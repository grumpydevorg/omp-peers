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
export interface LineConnection {
    /** Begin delivery; call once. `onClose` fires once: `null` for an orderly close, else `"<CODE>: <message>"`. */
    start(onLine: (line: string) => void, onClose: (reason: string | null) => void): void;
    /** Queue one line (no LF). Dropped once the connection has closed. */
    send(line: string): void;
    /** Write everything queued, then close. */
    end(): void;
    /** Close now, dropping queued writes. Idempotent. */
    destroy(): void;
}
export interface LineServer {
    /** Stop accepting and remove this server's own endpoint. Accepted connections are untouched. Idempotent. */
    close(): void;
}
export interface LineTransport {
    readonly kind: 'native' | 'node';
    /** Rejects with a coded message (`EADDRINUSE: …`, `EACCES: …`). */
    listen(address: string, maxLineBytes: number, onConnection: (conn: LineConnection) => void): Promise<LineServer>;
    /** Rejects with a coded message (`ENOENT: …`, `ECONNREFUSED: …`, `ETIMEDOUT: …`). */
    connect(address: string, maxLineBytes: number, timeoutMs: number): Promise<LineConnection>;
}
/** `CODE: message`, without repeating a code the message already names. */
export declare function describeError(err: unknown): string;
/**
 * The transport for this process: native inside omp, `node:net` elsewhere.
 * Resolved once. Dynamic because `@oh-my-pi/pi-natives` exists only inside
 * omp: a static import would stop the extension loading under pi and node.
 * The specifier is literal because omp only rewrites literal specifiers to
 * its own bundled module.
 */
export declare function loadTransport(): Promise<LineTransport>;
