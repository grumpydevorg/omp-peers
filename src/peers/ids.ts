/**
 * Peer identity: validation, the base name, collision suffixes and lookup.
 *
 * A peer has a stable IDENTITY — its root omp session id, which survives
 * `omp --resume` — and a human NAME derived from it:
 *
 *   base  = the session's `/rename` name (explicit, raw-valid)
 *         → else the checkout: the git top level of the cwd, or its parent
 *           when that directory is `main`/`master`/`develop`/`trunk` or a
 *           version number (`<repo>/main` worktrees)
 *         → else the cwd basename, sanitised.
 *   name  = base, unless another live peer publishes the same base
 *           (case-insensitive); then every sharer takes
 *           `<base>-<last 4 hex of its session id>` (6 on a 4-hex tie).
 *
 * The suffix comes from the session id, not from start order, so the same
 * session gets the same name after a restart and no peer is renamed when an
 * unrelated one exits. Names are matched case-insensitively.
 */

import { basename, dirname } from 'node:path';

import { PeerNameError } from '../errors.js';
import type { PeerRecord } from '../types.js';

export const PEER_NAME_PATTERN = /^[\w.-]{1,24}$/;

/**
 * Refused as names in any case: `main` is the host's driving agent id,
 * `all` reads as a broadcast, `self` as the sender. Purely numeric names are
 * refused too — they read as a pid or a default terminal-tab number.
 */
const RESERVED_NAMES: Record<string, true> = { main: true, all: true, self: true };
const NUMERIC = /^\d+$/;

export function isValidPeerName(name: string): boolean {
  return PEER_NAME_PATTERN.test(name) && RESERVED_NAMES[name.toLowerCase()] !== true && !NUMERIC.test(name);
}

/** Throw {@link PeerNameError} unless `name` is usable as a peer address. */
export function validatePeerName(name: string): void {
  if (!PEER_NAME_PATTERN.test(name)) {
    throw new PeerNameError(`invalid peer name "${name}" — use 1-24 of a-z A-Z 0-9 _ . - (no spaces)`);
  }
  if (RESERVED_NAMES[name.toLowerCase()] === true) {
    throw new PeerNameError(`"${name}" is reserved — pick another peer name`);
  }
  if (NUMERIC.test(name)) {
    throw new PeerNameError(`"${name}" is all digits and reads as a pid — pick another peer name`);
  }
}

/** Directory names that are a branch or version, not the project. */
const NON_PROJECT_DIR = /^(main|master|develop|trunk|\d+(\.\d+)*)$/;

/**
 * The directory-derived base: the checkout (git top level when known, else
 * the cwd), stepping up once past a branch- or version-named directory, and
 * sanitised to the name alphabet. Never empty and never reserved.
 */
export function directoryBase(cwd: string, gitTopLevel?: string): string {
  const dir = gitTopLevel ?? cwd;
  const own = basename(dir);
  const chosen = NON_PROJECT_DIR.test(own) ? basename(dirname(dir)) : own;
  const sanitised = chosen
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return sanitised !== '' && isValidPeerName(sanitised) ? sanitised : 'peer';
}

/**
 * The base name: the session name when the user set it (`/rename`) and it
 * is valid raw, else `dirBase`. Model-generated titles (`titleSource`
 * `"auto"`) never count and are not reported. A user name that fails
 * validation comes back as `rejected` so the caller can warn once.
 */
export function chooseBase(input: {
  sessionName: string | undefined;
  titleSource: string | undefined;
  dirBase: string;
}): { base: string; rejected?: string } {
  const raw = input.sessionName;
  if (input.titleSource === 'auto' || raw === undefined || raw === '') return { base: input.dirBase };
  if (isValidPeerName(raw)) return { base: raw };
  return { base: input.dirBase, rejected: raw };
}

/** The last `length` hex digits of a session id; the leading ones are a timestamp shared by all peers. */
function sessionTail(sessionId: string, length: number): string {
  return sessionId.replace(/-/g, '').slice(-length);
}

/** The base a record publishes; records from older versions carry only their name. */
export function recordBase(record: PeerRecord): string {
  return record.base ?? record.name;
}

export interface ResolveNameInput {
  base: string;
  sessionId: string;
  pid: number;
  /** Live peers, own record excluded or not — own pid is skipped. */
  peers: PeerRecord[];
}

/**
 * `base` when no other live peer publishes the same base, else
 * `<base>-<session tail>`. The suffixed form is exempt from the 24-char cap.
 * A peer without a session id falls back to its pid as the suffix.
 */
export function resolvePeerName(input: ResolveNameInput): string {
  const key = input.base.toLowerCase();
  const sharers = input.peers.filter((p) => p.pid !== input.pid && recordBase(p).toLowerCase() === key);
  if (sharers.length === 0) return input.base;
  if (input.sessionId === '') return `${input.base}-${input.pid}`;
  const tail4 = sessionTail(input.sessionId, 4);
  const tie = sharers.some((p) => sessionTail(p.sessionId, 4) === tail4);
  return `${input.base}-${tie ? sessionTail(input.sessionId, 6) : tail4}`;
}

/** The key hop and wake accounting use for a peer: its session id, else its name. */
export function peerKey(sessionId: string | undefined, name: string): string {
  return sessionId !== undefined && sessionId !== '' ? sessionId : name.toLowerCase();
}

export type PeerLookup = { found: true; record: PeerRecord } | { found: false; reason: string };

/**
 * Resolve an address against live peers, case-insensitively: exact name →
 * an alias held by exactly one peer (tab label or a name held in the last
 * minutes) → a session id or a prefix of at least 8 of its characters.
 */
export function lookupPeer(to: string, peers: PeerRecord[]): PeerLookup {
  const key = to.trim().toLowerCase();
  const byName = peers.find((p) => p.name.toLowerCase() === key);
  if (byName !== undefined) return { found: true, record: byName };
  const byAlias = peers.filter((p) => (p.aliases ?? []).some((alias) => alias.toLowerCase() === key));
  if (byAlias.length === 1 && byAlias[0] !== undefined) return { found: true, record: byAlias[0] };
  if (byAlias.length > 1) {
    return {
      found: false,
      reason: `"${to}" is ambiguous: it names ${byAlias.map((p) => p.name).join(', ')}. Use one of those names.`,
    };
  }
  if (key.length >= 8) {
    const bySession = peers.filter((p) => p.sessionId !== '' && p.sessionId.toLowerCase().startsWith(key));
    if (bySession.length === 1 && bySession[0] !== undefined) return { found: true, record: bySession[0] };
  }
  const known = peers.map((p) => p.name).join(', ') || 'none';
  return { found: false, reason: `Unknown peer "${to}". Live peers: ${known}` };
}
