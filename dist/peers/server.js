/**
 * Socket transport between peer processes.
 *
 * Address seam: Windows serves a named pipe (`\\.\pipe\peers-<pid>`),
 * everywhere else a unix socket (`<state>/peers/<pid>.sock`). Both sides go
 * through `node:net` with a plain string address, so one code path covers
 * both. Frames are newline-delimited JSON (`PeerFrame`); every frame gets a
 * one-line `PeerReply`.
 *
 * Inbound policy lives here: hop cap (4 — a chain of agent-to-agent relays
 * past a human prompt is refused, never relayed) and 400ms per-sender burst
 * coalescing (N frames in one window cost one wake, not N).
 */
import { createConnection, createServer } from 'node:net';
import { rm } from 'node:fs/promises';
import { peersDir } from '../store/paths.js';
/** Max agent-to-agent relays from the last human prompt before refusal. */
export const MAX_HOPS = 4;
/** Burst window: frames from one sender inside it become a single wake. */
export const COALESCE_MS = 400;
/** Socket round-trip timeout for outbound sends. */
export const PEER_REQUEST_TIMEOUT_MS = 8_000;
/** Idle server-side sockets are destroyed after this long without a frame. */
export const SOCKET_IDLE_MS = 30_000;
/** Largest buffered frame per socket before the connection is dropped. */
export const MAX_FRAME_BYTES = 1_048_576;
/** Where this peer listens (and where others reach it). */
export function peerSocketAddress(stateDir, pid) {
    if (process.platform === 'win32')
        return `\\\\.\\pipe\\peers-${pid}`;
    return `${peersDir(stateDir)}/${pid}.sock`;
}
// Hop is sender-reported: it bounds honest relay chains, not forged ones.
function normalizeHop(hop) {
    return typeof hop === 'number' && Number.isFinite(hop) ? Math.max(0, Math.trunc(hop)) : 0;
}
function reply(socket, payload) {
    try {
        if (!socket.destroyed)
            socket.write(`${JSON.stringify(payload)}\n`);
    }
    catch {
        // Reply delivery is best-effort; the sender already treats close as failure.
    }
}
/**
 * Serve one peer address. `onMessage` runs once per coalesced batch and its
 * return becomes the reply `outcome`. Never throws into the host.
 */
export function startPeerServer(opts) {
    const coalesceMs = opts.coalesceMs ?? COALESCE_MS;
    const pending = new Map();
    const sockets = new Set();
    let stopped = false;
    let server;
    async function deliverBatch(from, first) {
        if (stopped)
            return;
        await new Promise((resolve) => {
            const wait = setTimeout(resolve, coalesceMs);
            wait.unref?.();
        });
        const batch = pending.get(from) ?? { bodies: [], hop: 0, first };
        pending.delete(from);
        const bodies = batch.bodies.length > 0 ? batch.bodies : [''];
        const body = bodies.length === 1
            ? bodies[0]
            : `${bodies.length} messages arrived together:\n\n${bodies
                .map((entry, index) => `${index + 1}. ${entry}`)
                .join('\n\n')}`;
        try {
            const outcome = await opts.onMessage({
                from,
                body,
                ...(batch.replyTo !== undefined ? { replyTo: batch.replyTo } : {}),
                hop: batch.hop,
            });
            reply(first, { ok: true, outcome });
        }
        catch (err) {
            // `from` was already deleted above — deleting again could eat a NEWER
            // pending entry that arrived while onMessage was failing.
            reply(first, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
    }
    async function handleFrame(line, socket) {
        let frame;
        try {
            frame = JSON.parse(line);
        }
        catch {
            reply(socket, { ok: false, error: 'bad frame' });
            return;
        }
        if (frame.t === 'ping') {
            reply(socket, { ok: true, name: opts.ownName() });
            return;
        }
        if (frame.t !== 'msg') {
            reply(socket, { ok: false, error: 'unknown frame' });
            return;
        }
        const hop = normalizeHop(frame.hop);
        if (hop > MAX_HOPS) {
            try {
                opts.onWarn?.(`peers: refused a message from ${frame.from} — hop ${hop} exceeds the ${MAX_HOPS}-hop chain limit`);
            }
            catch {
                // Warning delivery is best-effort.
            }
            reply(socket, {
                ok: false,
                error: `Refused: this message is ${hop} hops from a human prompt and the limit is ${MAX_HOPS}. The chain has to end here — do not resend. Ask your user if it must continue.`,
            });
            return;
        }
        if (typeof frame.from !== 'string' || frame.from === '' || typeof frame.body !== 'string') {
            reply(socket, { ok: false, error: 'bad frame' });
            return;
        }
        if (frame.ack === true) {
            // ACKS BYPASS THE COALESCE QUEUE ENTIRELY: A RECEIPT MUST DELIVER
            // IMMEDIATELY, NEVER BATCH, NEVER DELAY A REAL MESSAGE SLOT.
            try {
                const outcome = await opts.onMessage({
                    from: frame.from,
                    body: frame.body,
                    hop,
                    ack: true,
                });
                reply(socket, { ok: true, outcome });
            }
            catch (err) {
                reply(socket, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
            return;
        }
        const known = pending.get(frame.from);
        if (known) {
            known.bodies.push(frame.body);
            known.hop = Math.max(known.hop, hop);
            reply(socket, { ok: true, outcome: 'coalesced' });
            return;
        }
        pending.set(frame.from, {
            bodies: [frame.body],
            ...(typeof frame.replyTo === 'string' && frame.replyTo !== '' ? { replyTo: frame.replyTo } : {}),
            hop,
            first: socket,
        });
        void deliverBatch(frame.from, socket);
    }
    function accept(socket) {
        sockets.add(socket);
        socket.on('close', () => {
            sockets.delete(socket);
        });
        // Decode multibyte chars across chunk boundaries — String(chunk) per
        // chunk turns a split sequence into U+FFFD and breaks JSON.parse.
        socket.setEncoding('utf8');
        socket.on('error', () => {
            try {
                socket.destroy();
            }
            catch {
                // Destroy is best-effort.
            }
        });
        socket.setTimeout(SOCKET_IDLE_MS);
        socket.on('timeout', () => {
            try {
                socket.destroy();
            }
            catch {
                // Destroy is best-effort.
            }
        });
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk;
            if (buffer.length > MAX_FRAME_BYTES) {
                reply(socket, { ok: false, error: 'frame too large' });
                try {
                    socket.destroy();
                }
                catch {
                    // Destroy is best-effort.
                }
                buffer = '';
                return;
            }
            let index = buffer.indexOf('\n');
            while (index !== -1) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                index = buffer.indexOf('\n');
                void handleFrame(line, socket);
            }
        });
    }
    server = createServer(accept);
    server.on('error', (err) => {
        try {
            opts.onWarn?.(`peers: server error: ${err instanceof Error ? err.message : String(err)}`);
        }
        catch {
            // Warning delivery is best-effort.
        }
    });
    server.unref();
    const address = opts.address;
    void (async () => {
        try {
            if (process.platform !== 'win32') {
                await rm(address, { force: true }).catch(() => undefined);
            }
            server?.listen(address);
        }
        catch (err) {
            try {
                opts.onWarn?.(`peers: failed to listen on ${address}: ${err instanceof Error ? err.message : String(err)}`);
            }
            catch {
                // Warning delivery is best-effort.
            }
        }
    })();
    return {
        address,
        stop: (stopOpts) => {
            stopped = true;
            try {
                server?.close();
            }
            catch {
                // Close is best-effort.
            }
            server = undefined;
            // Senders parked in the coalesce window get a real reply instead of
            // hanging until their request timeout; end() flushes the reply where
            // destroy() could discard it.
            for (const entry of pending.values()) {
                reply(entry.first, { ok: false, error: 'peer shutting down' });
                try {
                    entry.first.end();
                }
                catch {
                    // Shutdown is best-effort.
                }
                sockets.delete(entry.first);
            }
            pending.clear();
            for (const socket of sockets) {
                try {
                    socket.destroy();
                }
                catch {
                    // Destroy is best-effort.
                }
            }
            sockets.clear();
            if (process.platform !== 'win32' && (stopOpts?.unlinkSocket ?? true)) {
                void rm(address, { force: true }).catch(() => undefined);
            }
        },
    };
}
/**
 * One request/response round trip to a peer socket. Resolves `undefined`
 * when the socket closes before replying (peer gone — caller reaps).
 */
export function requestPeer(address, frame, timeoutMs = PEER_REQUEST_TIMEOUT_MS) {
    // An oversized frame is refused here, before any byte is written. Left to
    // the receiver, it closes the socket mid-write and the sender sees EPIPE
    // (macOS) instead of the "too large" reply the receiver tried to send.
    const payload = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(payload, 'utf8') > MAX_FRAME_BYTES) {
        return Promise.resolve({ ok: false, error: 'frame too large' });
    }
    return new Promise((resolve) => {
        let settled = false;
        let timer;
        const socket = createConnection(address);
        // Same split-multibyte hazard as the server side: replies can carry
        // non-ASCII, so decode at the socket instead of per chunk.
        socket.setEncoding('utf8');
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            try {
                socket.destroy();
            }
            catch {
                // Destroy is best-effort.
            }
            resolve(value);
        };
        timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
        timer.unref?.();
        socket.on('error', (err) => {
            finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
        });
        socket.on('connect', () => {
            try {
                socket.write(payload);
            }
            catch (err) {
                finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
            }
        });
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk;
            if (buffer.length > MAX_FRAME_BYTES) {
                finish({ ok: false, error: 'response too large' });
                return;
            }
            const index = buffer.indexOf('\n');
            try {
                finish(JSON.parse(buffer.slice(0, index)));
            }
            catch {
                finish({ ok: false, error: 'bad response' });
            }
        });
        socket.on('close', () => finish(undefined));
    });
}
