/**
 * Presence — one owner-written heartbeat file per peer process.
 *
 * `<state>/peers/<pid>.json` is written via `durableWriteJson` (sidecar +
 * fsync + copy-over, never a rename over a live file) on a 15s beat. A peer
 * is live while its beat is at most 45s old AND its pid answers
 * `process.kill(pid, 0)`. Stale records are reaped (unlinked on sight).
 * Shutdown unlinks the own record.
 */

import { chmod, readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { durableWriteJson, readJsonFile } from '../store/atomic.js';
import { peerPath, peersDir } from '../store/paths.js';
import type { HarnessKind, PeerRecord, PeerTodo } from '../types.js';

export const HEARTBEAT_MS = 15_000;
export const PEER_TTL_MS = 45_000;

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

/** Field shape shared by every schema version (version gate lives in isPeerRecord). */
function hasPeerRecordShape(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['pid'] === 'number' &&
    typeof r['name'] === 'string' &&
    typeof r['cwd'] === 'string' &&
    (r['harness'] === 'omp' || r['harness'] === 'pi') &&
    typeof r['socket'] === 'string' &&
    typeof r['startedAt'] === 'number' &&
    typeof r['beatAt'] === 'number' &&
    (r['base'] === undefined || typeof r['base'] === 'string') &&
    (r['label'] === undefined || typeof r['label'] === 'string') &&
    (r['aliases'] === undefined ||
      (Array.isArray(r['aliases']) && r['aliases'].every((alias) => typeof alias === 'string')))
  );
}

function isPeerRecord(value: unknown): value is PeerRecord {
  return hasPeerRecordShape(value) && value['v'] === 1;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Write (or refresh) this process's presence record. Owner-only writer. */
export async function writePeerBeat(input: BeatInput): Promise<PeerRecord> {
  const pid = input.pid ?? process.pid;
  const record: PeerRecord = {
    v: 1,
    pid,
    name: input.name,
    cwd: input.cwd,
    project: basename(input.cwd),
    harness: input.harness,
    sessionId: input.sessionId ?? '',
    model: input.model ?? '',
    socket: input.socket,
    startedAt: input.startedAt,
    beatAt: Date.now(),
    busy: input.busy ?? false,
  };
  if (input.activity !== undefined && input.activity !== '') {
    record.activity = input.activity;
  }
  if (input.todos !== undefined && input.todos.length > 0) {
    record.todos = input.todos;
  }
  if (input.base !== undefined) record.base = input.base;
  if (input.label !== undefined && input.label !== '') record.label = input.label;
  if (input.aliases !== undefined && input.aliases.length > 0) record.aliases = input.aliases;
  const file = peerPath(pid, input.stateDir);
  // chmod only on first write — the file keeps its mode across refreshes,
  // so re-chmodding every 15s beat is wasted syscalls.
  let isNew = true;
  try {
    await stat(file);
    isNew = false;
  } catch {
    isNew = true;
  }
  await durableWriteJson(file, record);
  if (isNew) {
    try {
      await chmod(file, 0o600);
    } catch {
      // Best effort: the parent dir is already mode-restricted on creation.
    }
  }
  return record;
}

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
export async function listLivePeers(
  stateDir: string,
  selfPid: number,
  opts: ListPeersOptions = {}
): Promise<PeerRecord[]> {
  const dir = peersDir(stateDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const live: PeerRecord[] = [];
  const sockNames: string[] = [];
  for (const name of names) {
    if (name.endsWith('.sock')) {
      sockNames.push(name);
      continue;
    }
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    let parsed: unknown;
    try {
      parsed = await readJsonFile<PeerRecord>(file, { retries: 1, retryDelayMs: 50 });
    } catch {
      continue;
    }
    if (!isPeerRecord(parsed)) {
      // Forward-compat: a well-shaped record with a newer `v` is skipped,
      // not unlinked — a future peer owns it. Malformed files get reaped.
      if (!(hasPeerRecordShape(parsed) && typeof parsed['v'] === 'number' && parsed['v'] > 1)) {
        await rm(file, { force: true }).catch(() => undefined);
      }
      continue;
    }
    if (parsed.pid !== selfPid) {
      let alive = true;
      try {
        alive = isAlive(parsed.pid);
      } catch {
        alive = false;
      }
      if (!alive || now - parsed.beatAt > PEER_TTL_MS) {
        await rm(file, { force: true }).catch(() => undefined);
        // Only a confirmed-dead pid loses its socket: a live process with a
        // stalled beat keeps it — unlinking a live peer's socket would
        // strand it (ENOENT forever); its next beat rewrites the record.
        if (!alive && process.platform !== 'win32' && parsed.socket.startsWith(`${dir}/`)) {
          await rm(parsed.socket, { force: true }).catch(() => undefined);
        }
        continue;
      }
    }
    live.push(parsed);
  }
  if (process.platform !== 'win32') {
    // Orphan sockets: a dead pid's `<pid>.sock` survives record reaping when
    // the record was already gone. Skip names that don't parse to a pid.
    const livePids = new Set(live.map((p) => p.pid));
    for (const name of sockNames) {
      const base = name.slice(0, -'.sock'.length);
      if (!/^\d+$/.test(base)) continue;
      const pid = Number(base);
      if (livePids.has(pid)) continue;
      let alive = true;
      try {
        alive = isAlive(pid);
      } catch {
        alive = false;
      }
      if (!alive) await rm(join(dir, name), { force: true }).catch(() => undefined);
    }
  }
  live.sort((a, b) => a.name.localeCompare(b.name));
  return live;
}

/** Remove one presence record (+ its unix socket on non-Windows, dead pids only). */
export async function removePeerRecord(
  stateDir: string,
  pid: number,
  opts: { isAlive?: (pid: number) => boolean } = {}
): Promise<void> {
  const dir = peersDir(stateDir);
  await rm(join(dir, `${pid}.json`), { force: true }).catch(() => undefined);
  // The socket belongs to the pid, not the record: unlinking a live pid's
  // socket strands it. A live owner's own cleanup runs via server.stop().
  let alive = true;
  try {
    alive = (opts.isAlive ?? defaultIsAlive)(pid);
  } catch {
    alive = false;
  }
  if (process.platform !== 'win32' && !alive) {
    await rm(join(dir, `${pid}.sock`), { force: true }).catch(() => undefined);
  }
}

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
export function startPresenceBeat(
  tick: () => Promise<void> | void,
  opts: PresenceBeatOptions = {}
): { stop(): void } {
  const intervalMs = opts.intervalMs ?? HEARTBEAT_MS;
  const guarded = (): void => {
    try {
      const out = tick();
      if (out !== undefined && typeof (out as Promise<void>).catch === 'function') {
        (out as Promise<void>).catch((err: unknown) => {
          try {
            opts.onError?.(err);
          } catch {
            // Error reporting never throws into the timer.
          }
        });
      }
    } catch (err) {
      try {
        opts.onError?.(err);
      } catch {
        // Error reporting never throws into the timer.
      }
    }
  };
  if (typeof opts.setInterval === 'function' && typeof opts.clearTimer === 'function') {
    const timer = opts.setInterval(guarded, intervalMs);
    const clearTimer = opts.clearTimer;
    guarded();
    return {
      stop: (): void => {
        try {
          clearTimer(timer);
        } catch {
          // Stop never throws.
        }
      },
    };
  }
  const timer = setInterval(guarded, intervalMs);
  timer.unref?.();
  guarded();
  return {
    stop: (): void => {
      clearInterval(timer);
    },
  };
}

/** `3s ago` / `12m ago` / `2h ago` for the `/peers` beat-age column. */
export function formatBeatAge(beatAt: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - beatAt) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}
