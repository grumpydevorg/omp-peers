/**
 * Presence — one owner-written heartbeat file per peer process.
 *
 * `<state>/peers/<pid>.json` is written via `durableWriteJson` (sidecar +
 * fsync + copy-over, never a rename over a live file) on a 15s beat.
 *
 * Only the owner writes its record. Anyone else deletes it only once its
 * instance is confirmed dead: the pid is gone, or the beat is stale AND the
 * socket refuses or answers as another instance. A stale beat alone proves
 * nothing — a peer whose event loop stalls stays listed as it was, and its
 * next beat refreshes it. Shutdown unlinks the own record.
 */

import { chmod, readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { durableWriteJson, readJsonFile } from '../store/atomic.js';
import { peerPath, peersDir } from '../store/paths.js';
import type { HarnessKind, PeerRecord, PeerTodo } from '../types.js';
import { requestPeer } from './server.js';

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
  instanceId?: string;
}

/** Field shape shared by every schema version (version gate lives in isPeerRecord). Checks every field a reader uses. */
function hasPeerRecordShape(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  const optionalString = (key: string): boolean => r[key] === undefined || typeof r[key] === 'string';
  return (
    typeof r['pid'] === 'number' &&
    typeof r['name'] === 'string' &&
    typeof r['cwd'] === 'string' &&
    typeof r['project'] === 'string' &&
    (r['harness'] === 'omp' || r['harness'] === 'pi') &&
    typeof r['sessionId'] === 'string' &&
    typeof r['model'] === 'string' &&
    typeof r['socket'] === 'string' &&
    typeof r['startedAt'] === 'number' &&
    typeof r['beatAt'] === 'number' &&
    typeof r['busy'] === 'boolean' &&
    optionalString('activity') &&
    optionalString('base') &&
    optionalString('label') &&
    optionalString('instanceId') &&
    (r['aliases'] === undefined ||
      (Array.isArray(r['aliases']) && r['aliases'].every((alias) => typeof alias === 'string'))) &&
    (r['todos'] === undefined ||
      (Array.isArray(r['todos']) &&
        r['todos'].every(
          (todo: unknown) =>
            typeof todo === 'object' && todo !== null && 'text' in todo && typeof todo.text === 'string'
        )))
  );
}

function isPeerRecord(value: unknown): value is PeerRecord {
  return hasPeerRecordShape(value) && value['v'] === 1;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists under another user — alive, not ours to judge dead.
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

/** What an observer can prove about a record's instance. `unknown` never justifies a delete. */
export type Liveness = 'alive' | 'dead' | 'unknown';

/** How long a liveness ping waits: a stalled peer answers late, so a timeout proves nothing. */
const PROBE_TIMEOUT_MS = 1_000;

/** Ping a record's socket: `dead` only on a refused/absent socket or an answer from another instance. */
async function pingProbe(record: PeerRecord): Promise<Liveness> {
  const reply = await requestPeer(record.socket, { t: 'ping', from: 'probe' }, PROBE_TIMEOUT_MS);
  if (reply === undefined) return 'unknown';
  if (reply.ok) {
    const other = record.instanceId !== undefined && reply.id !== undefined && reply.id !== record.instanceId;
    return other ? 'dead' : 'alive';
  }
  return /\b(ECONNREFUSED|ENOENT)\b/.test(reply.error ?? '') ? 'dead' : 'unknown';
}

interface Judge {
  now: number;
  isAlive: (pid: number) => boolean;
  probe: (record: PeerRecord) => Promise<Liveness>;
}

function pidAlive(judge: Judge, pid: number): boolean {
  try {
    return judge.isAlive(pid);
  } catch {
    // A failing liveness check proves nothing either way: keep the record.
    return true;
  }
}

/** Dead only on proof: the pid is gone, or the beat is stale and the socket disowns it. */
async function judgeRecord(judge: Judge, record: PeerRecord): Promise<Liveness> {
  if (!pidAlive(judge, record.pid)) return 'dead';
  if (judge.now - record.beatAt <= PEER_TTL_MS) return 'alive';
  try {
    return await judge.probe(record);
  } catch {
    return 'unknown';
  }
}

/**
 * Unlink `record`'s file after it was judged dead, unless the file changed
 * since it was read (its owner — or a new instance on a reused pid — wrote
 * again). Its socket goes too when the pid itself is gone.
 */
async function unlinkDead(stateDir: string, record: PeerRecord, judge: Judge): Promise<void> {
  const dir = peersDir(stateDir);
  const file = join(dir, `${record.pid}.json`);
  let current: unknown;
  try {
    current = await readJsonFile<PeerRecord>(file, { retries: 1, retryDelayMs: 50 });
  } catch {
    return;
  }
  if (!isPeerRecord(current) || current.beatAt !== record.beatAt || current.instanceId !== record.instanceId) return;
  await rm(file, { force: true }).catch(() => undefined);
  if (process.platform !== 'win32' && !pidAlive(judge, record.pid) && record.socket.startsWith(`${dir}/`)) {
    await rm(record.socket, { force: true }).catch(() => undefined);
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
  if (input.instanceId !== undefined && input.instanceId !== '') record.instanceId = input.instanceId;
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
  /** Asks a stale record's socket whether its instance still answers (default: a ping). */
  probe?: (record: PeerRecord) => Promise<Liveness>;
}

function judgeOf(opts: ListPeersOptions): Judge {
  return { now: opts.now ?? Date.now(), isAlive: opts.isAlive ?? defaultIsAlive, probe: opts.probe ?? pingProbe };
}

/**
 * List every peer not proven dead, sorted by name, reaping the dead on
 * sight (see the module comment for what counts as proof). A wrong-shape
 * file is reaped only when the pid in its file name is gone. Unparseable
 * files are left alone (torn reads), as are records from a newer schema
 * version. Orphan `<pid>.sock` files whose pid is gone are reaped too.
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
  const judge = judgeOf(opts);
  const live: PeerRecord[] = [];
  const sockNames: string[] = [];
  for (const name of names) {
    if (name.endsWith('.sock')) {
      sockNames.push(name);
      continue;
    }
    const owner = /^(\d+)\.json$/.exec(name)?.[1];
    if (owner === undefined) continue;
    const file = join(dir, name);
    let parsed: unknown;
    try {
      parsed = await readJsonFile<PeerRecord>(file, { retries: 1, retryDelayMs: 50 });
    } catch {
      continue;
    }
    if (!isPeerRecord(parsed) || parsed.pid !== Number(owner)) {
      // Forward-compat: a record with a newer `v` is skipped, not unlinked —
      // a future peer owns it and may shape it differently.
      const version = typeof parsed === 'object' && parsed !== null && 'v' in parsed ? parsed.v : undefined;
      if (!(typeof version === 'number' && version > 1) && !pidAlive(judge, Number(owner))) {
        await rm(file, { force: true }).catch(() => undefined);
      }
      continue;
    }
    if (parsed.pid !== selfPid && (await judgeRecord(judge, parsed)) === 'dead') {
      await unlinkDead(stateDir, parsed, judge);
      continue;
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
      if (!pidAlive(judge, pid)) await rm(join(dir, name), { force: true }).catch(() => undefined);
    }
  }
  live.sort((a, b) => a.name.localeCompare(b.name));
  return live;
}

/**
 * A sender's socket closed without a reply: remove `record` if — and only
 * if — its instance is now proven dead and the file still holds it.
 */
export async function reapPeer(stateDir: string, record: PeerRecord, opts: ListPeersOptions = {}): Promise<void> {
  const judge = judgeOf(opts);
  if ((await judgeRecord(judge, record)) === 'dead') await unlinkDead(stateDir, record, judge);
}

/** The owner removes its own record on shutdown; its socket is the server's to unlink. */
export async function removeOwnRecord(stateDir: string, pid: number): Promise<void> {
  await rm(join(peersDir(stateDir), `${pid}.json`), { force: true }).catch(() => undefined);
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
export function startPresenceBeat(tick: () => Promise<void> | void, opts: PresenceBeatOptions = {}): { stop(): void } {
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
