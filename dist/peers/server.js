/**
 * Peer protocol over the local line transport (`transport.ts`: omp's native
 * IPC inside omp, `node:net` elsewhere).
 *
 * Address: one endpoint per node boot — `<state>/peers/<pid>-<tag>.sock`, a
 * named pipe `\\.\pipe\peers-<pid>-<tag>` on Windows — so a successor node in
 * the same process never contends for its predecessor's endpoint. Frames are
 * newline-delimited JSON (`PeerFrame`); every frame gets a one-line
 * `PeerReply`. A received line over `MAX_FRAME_BYTES` closes the connection
 * without a reply, so `requestPeer` refuses an oversized frame before
 * writing any of it.
 *
 * Inbound policy lives here: hop cap (4 — a chain of agent-to-agent relays
 * past a human prompt is refused, never relayed) and 400ms per-sender burst
 * coalescing (N frames in one window cost one wake, not N).
 */
import { peersDir } from '../store/paths.js';
import { loadTransport } from './transport.js';
import { checkFrame, checkReply } from './wire.js';
/** Max agent-to-agent relays from the last human prompt before refusal. */
export const MAX_HOPS = 4;
/** Burst window: frames from one sender inside it become a single wake. */
export const COALESCE_MS = 400;
/** Round-trip timeout for outbound sends. */
export const PEER_REQUEST_TIMEOUT_MS = 8_000;
/** Idle server-side connections are closed after this long without a frame. */
export const SOCKET_IDLE_MS = 30_000;
/** Largest line, in UTF-8 bytes with its LF, either side accepts. */
export const MAX_FRAME_BYTES = 1_048_576;
/** Reply error for a message addressed to another instance than the one listening here. */
export const WRONG_PEER = 'wrong peer';
/** Reply error from a node that has left the peer list. */
export const LEFT = 'left';
/**
 * Where this node boot listens (and where others reach it). The tag is the
 * first 8 alphanumerics of `instanceId`; reaping matches `<pid>-<tag>.sock`.
 */
export function peerSocketAddress(stateDir, pid, instanceId) {
    const tag = instanceId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
    if (process.platform === 'win32')
        return `\\\\.\\pipe\\peers-${pid}-${tag}`;
    return `${peersDir(stateDir)}/${pid}-${tag}.sock`;
}
// Hop is sender-reported: it bounds honest relay chains, not forged ones.
function normalizeHop(hop) {
    return typeof hop === 'number' && Number.isFinite(hop) ? Math.max(0, Math.trunc(hop)) : 0;
}
function reply(conn, payload) {
    try {
        conn.send(JSON.stringify(payload));
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
    // Keyed by the sender's id (name for older senders), so a burst stays one
    // batch even if the sender's name changes mid-burst. Every member connection
    // waits for the batch's own outcome: a receipt never claims more than
    // happened to the message.
    const pending = new Map();
    const connections = new Set();
    let stopped = false;
    let server;
    async function deliverBatch(key) {
        if (stopped)
            return;
        await new Promise((resolve) => {
            const wait = setTimeout(resolve, coalesceMs);
            wait.unref?.();
        });
        const batch = pending.get(key);
        pending.delete(key);
        if (batch === undefined)
            return;
        const refused = opts.refuse?.();
        if (refused !== undefined) {
            for (const member of batch.members)
                reply(member, { ok: false, error: refused });
            return;
        }
        const bodies = batch.bodies.length > 0 ? batch.bodies : [''];
        const body = bodies.length === 1
            ? bodies[0]
            : `${bodies.length} messages arrived together:\n\n${bodies
                .map((entry, index) => `${index + 1}. ${entry}`)
                .join('\n\n')}`;
        try {
            const outcome = await opts.onMessage({
                from: batch.from,
                ...(batch.fromId !== undefined ? { fromId: batch.fromId } : {}),
                body,
                ...(batch.replyTo !== undefined ? { replyTo: batch.replyTo } : {}),
                hop: batch.hop,
                ...(batch.human ? { human: true } : {}),
            });
            for (const member of batch.members)
                reply(member, { ok: true, outcome });
        }
        catch (err) {
            // `key` was already deleted above — deleting again could eat a NEWER
            // pending entry that arrived while onMessage was failing.
            const error = err instanceof Error ? err.message : String(err);
            for (const member of batch.members)
                reply(member, { ok: false, error });
        }
    }
    // Frame handlers run fire-and-forget off connection events. A throw escaping
    // one is an unhandled rejection, and that terminates the host process.
    function contain(task, what) {
        task.catch((err) => {
            try {
                opts.onWarn?.(`peers: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            catch {
                // Warning delivery is best-effort.
            }
        });
    }
    async function handleFrame(line, conn) {
        let decoded;
        try {
            decoded = JSON.parse(line);
        }
        catch {
            reply(conn, { ok: false, error: 'bad frame' });
            return;
        }
        const checked = checkFrame(decoded);
        if (!checked.ok) {
            reply(conn, { ok: false, error: checked.error });
            return;
        }
        const frame = checked.frame;
        if (frame.t === 'ping') {
            reply(conn, { ok: true, name: opts.ownName(), id: opts.ownId() });
            return;
        }
        // Addressed to another instance (a name that moved, a reused pid): refused
        // before anything reaches the host, so the sender can re-resolve.
        if (frame.toId !== undefined && frame.toId !== opts.ownId()) {
            reply(conn, { ok: false, error: WRONG_PEER });
            return;
        }
        const refused = opts.refuse?.();
        if (refused !== undefined) {
            reply(conn, { ok: false, error: refused });
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
            reply(conn, {
                ok: false,
                error: `Refused: this message is ${hop} hops from a human prompt and the limit is ${MAX_HOPS}. The chain has to end here — do not resend. Ask your user if it must continue.`,
            });
            return;
        }
        if (frame.ack === true) {
            // ACKS BYPASS THE COALESCE QUEUE ENTIRELY: A RECEIPT MUST DELIVER
            // IMMEDIATELY, NEVER BATCH, NEVER DELAY A REAL MESSAGE SLOT.
            try {
                const outcome = await opts.onMessage({
                    from: frame.from,
                    ...(frame.fromId !== undefined ? { fromId: frame.fromId } : {}),
                    body: frame.body,
                    hop,
                    ack: true,
                });
                reply(conn, { ok: true, outcome });
            }
            catch (err) {
                reply(conn, { ok: false, error: err instanceof Error ? err.message : String(err) });
            }
            return;
        }
        const key = frame.fromId !== undefined && frame.fromId !== '' ? frame.fromId : frame.from;
        const known = pending.get(key);
        if (known) {
            known.bodies.push(frame.body);
            known.hop = Math.max(known.hop, hop);
            // One agent-written message makes the whole batch agent text: the
            // label must never overstate who wrote it.
            known.human = known.human && frame.human === true;
            known.members.push(conn);
            return;
        }
        pending.set(key, {
            from: frame.from,
            ...(frame.fromId !== undefined ? { fromId: frame.fromId } : {}),
            bodies: [frame.body],
            ...(frame.replyTo !== undefined && frame.replyTo !== '' ? { replyTo: frame.replyTo } : {}),
            hop,
            human: frame.human === true,
            members: [conn],
        });
        contain(deliverBatch(key), 'batch delivery');
    }
    function accept(conn) {
        connections.add(conn);
        // Idle connections are closed after SOCKET_IDLE_MS without a frame.
        let idle;
        const armIdle = () => {
            clearTimeout(idle);
            idle = setTimeout(() => conn.destroy(), SOCKET_IDLE_MS);
            idle.unref?.();
        };
        armIdle();
        conn.start((line) => {
            armIdle();
            contain(handleFrame(line, conn), 'frame handling');
        }, () => {
            clearTimeout(idle);
            connections.delete(conn);
        });
    }
    let settleListening = () => undefined;
    const listening = new Promise((resolve) => {
        settleListening = resolve;
    });
    const address = opts.address;
    void (async () => {
        try {
            const transport = await loadTransport();
            if (stopped) {
                settleListening(false);
                return;
            }
            const bound = await transport.listen(address, MAX_FRAME_BYTES, accept);
            if (stopped) {
                bound.close();
                settleListening(false);
                return;
            }
            server = bound;
            settleListening(true);
        }
        catch (err) {
            settleListening(false);
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
        listening,
        stop: () => {
            stopped = true;
            settleListening(false);
            try {
                server?.close();
            }
            catch {
                // Close is best-effort.
            }
            server = undefined;
            // Senders parked in the coalesce window get a real refusal instead of
            // hanging until their request timeout: none of their messages reached
            // the host. end() flushes the reply where destroy() could discard it.
            for (const entry of pending.values()) {
                for (const member of entry.members) {
                    reply(member, { ok: false, error: 'peer shutting down' });
                    try {
                        member.end();
                    }
                    catch {
                        // Shutdown is best-effort.
                    }
                    connections.delete(member);
                }
            }
            pending.clear();
            for (const conn of connections) {
                try {
                    conn.destroy();
                }
                catch {
                    // Destroy is best-effort.
                }
            }
            connections.clear();
        },
    };
}
/**
 * One request/response round trip to a peer endpoint. Resolves `undefined`
 * when the connection closes before replying (peer gone — caller reaps).
 * Connect failures carry their errno code (`ECONNREFUSED: …`).
 */
export async function requestPeer(address, frame, timeoutMs = PEER_REQUEST_TIMEOUT_MS) {
    // An oversized frame is refused here, before any byte is written: the
    // receiver closes on an over-long line without replying, and a sender
    // mid-write sees EPIPE instead of a reason. The cap counts UTF-8 bytes of
    // the whole line, LF included.
    const line = JSON.stringify(frame);
    if (Buffer.byteLength(line, 'utf8') + 1 > MAX_FRAME_BYTES) {
        return { ok: false, error: 'frame too large' };
    }
    const transport = await loadTransport();
    return new Promise((resolve) => {
        let settled = false;
        let conn;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                conn?.destroy();
            }
            catch {
                // Destroy is best-effort.
            }
            resolve(value);
        };
        const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
        timer.unref?.();
        transport.connect(address, MAX_FRAME_BYTES, timeoutMs).then((connected) => {
            conn = connected;
            if (settled) {
                connected.destroy();
                return;
            }
            connected.start((text) => {
                let decoded;
                try {
                    decoded = JSON.parse(text);
                }
                catch {
                    finish({ ok: false, error: 'bad response' });
                    return;
                }
                finish(checkReply(decoded) ?? { ok: false, error: 'bad response' });
            }, (reason) => {
                if (reason === null)
                    finish(undefined);
                else if (reason.startsWith('EMSGSIZE'))
                    finish({ ok: false, error: 'response too large' });
                else
                    finish({ ok: false, error: reason });
            });
            connected.send(line);
        }, (err) => finish({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    });
}
