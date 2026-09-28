/**
 * Presence — one owner-written heartbeat file per peer process.
 *
 * `<state>/peers/<pid>.json` is written via `durableWriteJson` (sidecar +
 * fsync + copy-over, never a rename over a live file) on a 15s beat. A peer
 * is live while its beat is at most 45s old AND its pid answers
 * `process.kill(pid, 0)`. Stale records are reaped (unlinked on sight).
 * Shutdown unlinks the own record.
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
}
/** Write (or refresh) this process's presence record. Owner-only writer. */
export declare function writePeerBeat(input: BeatInput): Promise<PeerRecord>;
export interface ListPeersOptions {
    now?: number;
    /** Liveness probe seam (default: `process.kill(pid, 0)`). */
    isAlive?: (pid: number) => boolean;
}
/**
 * List live peers, reaping stale records on sight: wrong-shape files, dead
 * pids, and beats older than the TTL are unlinked. Unparseable files are
 * left alone (torn reads), as are well-shaped records from a newer schema
 * version. A unix socket is unlinked only when its pid is confirmed dead —
 * a live peer keeps its socket even on a stale beat — and orphan
 * `<pid>.sock` files with no live owner are reaped too. Results sort by name.
 */
export declare function listLivePeers(stateDir: string, selfPid: number, opts?: ListPeersOptions): Promise<PeerRecord[]>;
/** Remove one presence record (+ its unix socket on non-Windows, dead pids only). */
export declare function removePeerRecord(stateDir: string, pid: number, opts?: {
    isAlive?: (pid: number) => boolean;
}): Promise<void>;
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
