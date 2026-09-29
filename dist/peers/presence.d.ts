/**
 * Presence — one owner-written heartbeat file per peer process.
 *
 * `<state>/peers/<pid>.json` is written via `durableWriteJson` (sidecar +
 * fsync, then an atomic rename over the record; a copy on Windows) on a 15s beat.
 *
 * Only the owner writes its record. Anyone else deletes it only once its
 * instance is confirmed dead: the pid is gone, or the beat is stale AND the
 * socket refuses or answers as another instance. A stale beat alone proves
 * nothing — a peer whose event loop stalls stays listed as it was, and its
 * next beat refreshes it. Shutdown unlinks the own record.
 */
import type { HarnessKind, PeerRecord, PeerTodo } from '../types.js';
export declare const HEARTBEAT_MS = 15000;
export declare const PEER_TTL_MS = 45000;
export interface BeatInput {
    stateDir: string;
    pid?: number;
    name: string;
    cwd: string;
    harness: HarnessKind;
    sessionId?: string;
    model?: string;
    socket: string;
    startedAt: number;
    busy?: boolean;
    activity?: string;
    todos?: PeerTodo[];
    base?: string;
    label?: string;
    aliases?: string[];
    instanceId?: string;
    /** Set while the owner has left the peer list (`/peers leave`). */
    left?: number;
}
/** What an observer can prove about a record's instance. `unknown` never justifies a delete. */
export type Liveness = 'alive' | 'dead' | 'unknown';
/** Write (or refresh) this process's presence record. Owner-only writer. */
export declare function writePeerBeat(input: BeatInput): Promise<PeerRecord>;
export interface ListPeersOptions {
    now?: number;
    /** Liveness probe seam (default: `process.kill(pid, 0)`). */
    isAlive?: (pid: number) => boolean;
    /** Asks a stale record's socket whether its instance still answers (default: a ping). */
    probe?: (record: PeerRecord) => Promise<Liveness>;
}
/**
 * List every peer not proven dead, sorted by name, reaping the dead on
 * sight (see the module comment for what counts as proof). A wrong-shape
 * file is reaped only when the pid in its file name is gone. Unparseable
 * files are left alone (torn reads), as are records from a newer schema
 * version. Orphan `<pid>.sock` files whose pid is gone are reaped too.
 */
export declare function listLivePeers(stateDir: string, selfPid: number, opts?: ListPeersOptions): Promise<PeerRecord[]>;
/**
 * A sender's socket closed without a reply: remove `record` if — and only
 * if — its instance is now proven dead and the file still holds it.
 */
export declare function reapPeer(stateDir: string, record: PeerRecord, opts?: ListPeersOptions): Promise<void>;
/** The owner removes its own record on shutdown; its socket is the server's to unlink. */
export declare function removeOwnRecord(stateDir: string, pid: number): Promise<void>;
export interface PresenceBeatOptions {
    intervalMs?: number;
    onError?: (err: unknown) => void;
    /** Host-managed timers (omp) when available; raw unref'd timer otherwise. */
    setInterval?: (callback: () => void, ms?: number) => unknown;
    clearTimer?: (timer: unknown) => void;
}
/**
 * Run `tick` immediately and every `intervalMs`. The tick body never throws
 * into the host: failures route to `onError`. Returns a `stop` handle.
 */
export declare function startPresenceBeat(tick: () => Promise<void> | void, opts?: PresenceBeatOptions): {
    stop(): void;
};
/** `3s ago` / `12m ago` / `2h ago` for the `/peers` beat-age column. */
export declare function formatBeatAge(beatAt: number, now?: number): string;
