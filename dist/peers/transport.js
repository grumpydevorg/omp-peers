/**
 * Line-framed local transport under the peer protocol.
 *
 * Inside omp the host's native IPC (`@oh-my-pi/pi-natives`: owner-only Unix
 * sockets / named pipes, peer-uid checks, flock-guarded binding that refuses
 * a live endpoint and takes over a stale one) carries the frames. Where that
 * module does not resolve — pi, node — `node:net` does, with the same
 * contract:
 *
 * - a line is UTF-8 text ending in LF; empty lines are skipped and one
 *   trailing CR is stripped;
 * - a received line longer than `maxLineBytes` closes the connection with an
 *   `EMSGSIZE: …` reason and no reply, so senders check size before writing;
 * - every failure carries its errno code in the text (`ECONNREFUSED: …`),
 *   which is what liveness probing matches on.
 */
import { createConnection, createServer } from 'node:net';
import { rm } from 'node:fs/promises';
/** `CODE: message`, without repeating a code the message already names. */
export function describeError(err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err?.code;
    return typeof code === 'string' && code !== '' && !message.includes(code) ? `${code}: ${message}` : message;
}
function nodeConnection(socket, maxLineBytes) {
    const tooLong = `EMSGSIZE: line exceeds maxFrameBytes (${maxLineBytes} bytes)`;
    let started = false;
    return {
        start(onLine, onClose) {
            if (started)
                throw new TypeError('start() called twice');
            started = true;
            let failure = null;
            let pending = [];
            let pendingBytes = 0;
            socket.on('error', (err) => {
                failure ??= describeError(err);
            });
            socket.on('close', () => onClose(failure));
            socket.on('data', (chunk) => {
                // Split on the LF byte: it never occurs inside a multibyte UTF-8
                // sequence, so a character split across chunks decodes whole.
                let rest = chunk;
                let index = rest.indexOf(0x0a);
                while (index !== -1) {
                    const head = rest.subarray(0, index);
                    if (pendingBytes + head.length > maxLineBytes) {
                        failure ??= tooLong;
                        socket.destroy();
                        return;
                    }
                    const bytes = pending.length === 0 ? head : Buffer.concat([...pending, head]);
                    pending = [];
                    pendingBytes = 0;
                    let line = bytes.toString('utf8');
                    if (line.endsWith('\r'))
                        line = line.slice(0, -1);
                    if (line !== '')
                        onLine(line);
                    if (socket.destroyed)
                        return;
                    rest = rest.subarray(index + 1);
                    index = rest.indexOf(0x0a);
                }
                if (rest.length === 0)
                    return;
                if (pendingBytes + rest.length > maxLineBytes) {
                    failure ??= tooLong;
                    socket.destroy();
                    return;
                }
                pending.push(rest);
                pendingBytes += rest.length;
            });
        },
        send(line) {
            if (!socket.destroyed && socket.writable)
                socket.write(`${line}\n`);
        },
        end() {
            socket.end();
        },
        destroy() {
            socket.destroy();
        },
    };
}
const nodeTransport = {
    kind: 'node',
    listen(address, maxLineBytes, onConnection) {
        return new Promise((resolve, reject) => {
            const server = createServer((socket) => onConnection(nodeConnection(socket, maxLineBytes)));
            server.unref();
            server.once('error', (err) => reject(new Error(describeError(err))));
            server.once('listening', () => {
                server.on('error', () => undefined);
                let closed = false;
                resolve({
                    close() {
                        if (closed)
                            return;
                        closed = true;
                        server.close();
                        if (process.platform !== 'win32')
                            void rm(address, { force: true }).catch(() => undefined);
                    },
                });
            });
            server.listen(address);
        });
    },
    connect(address, maxLineBytes, timeoutMs) {
        return new Promise((resolve, reject) => {
            const socket = createConnection(address);
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error(`ETIMEDOUT: connect ${address} timed out after ${timeoutMs} ms`));
            }, timeoutMs);
            timer.unref?.();
            socket.once('error', (err) => {
                clearTimeout(timer);
                reject(new Error(describeError(err)));
            });
            socket.once('connect', () => {
                clearTimeout(timer);
                socket.removeAllListeners('error');
                resolve(nodeConnection(socket, maxLineBytes));
            });
        });
    },
};
function nativeTransport(natives) {
    const wrap = (conn) => ({
        start: (onLine, onClose) => conn.start(onLine, onClose),
        send: (line) => {
            conn.send(line);
        },
        end: () => conn.end(),
        destroy: () => conn.destroy(),
    });
    return {
        kind: 'native',
        async listen(address, maxLineBytes, onConnection) {
            let server;
            try {
                server = await natives.IpcServer.listen(address, { framing: 'lines', maxFrameBytes: maxLineBytes }, (conn) => onConnection(wrap(conn)));
            }
            catch (err) {
                throw new Error(describeError(err));
            }
            let closed = false;
            return {
                close() {
                    if (closed)
                        return;
                    closed = true;
                    // Unlinks the socket only while it is still the inode this server bound.
                    server.close();
                    // The bind lock is per endpoint and every endpoint is per node boot:
                    // nobody else will ever lock this one.
                    if (process.platform !== 'win32')
                        void rm(`${address}.bind.lock`, { force: true }).catch(() => undefined);
                },
            };
        },
        async connect(address, maxLineBytes, timeoutMs) {
            try {
                return wrap(await natives.IpcConnection.connect(address, { framing: 'lines', maxFrameBytes: maxLineBytes, timeoutMs }));
            }
            catch (err) {
                throw new Error(describeError(err));
            }
        },
    };
}
let chosen;
/**
 * The transport for this process: native inside omp, `node:net` elsewhere.
 * Resolved once. Dynamic because `@oh-my-pi/pi-natives` exists only inside
 * omp: a static import would stop the extension loading under pi and node.
 * The specifier is literal because omp only rewrites literal specifiers to
 * its own bundled module.
 */
export function loadTransport() {
    chosen ??= (async () => {
        try {
            const natives = await import('@oh-my-pi/pi-natives');
            if (typeof natives.IpcServer?.listen === 'function' && typeof natives.IpcConnection?.connect === 'function') {
                return nativeTransport(natives);
            }
        }
        catch {
            // Not inside omp: no native module to resolve.
        }
        return nodeTransport;
    })();
    return chosen;
}
