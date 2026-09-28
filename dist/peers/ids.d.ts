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
import type { PeerRecord } from '../types.js';
export declare const PEER_NAME_PATTERN: RegExp;
export declare function isValidPeerName(name: string): boolean;
/** Throw {@link PeerNameError} unless `name` is usable as a peer address. */
export declare function validatePeerName(name: string): void;
/**
 * The directory-derived base: the checkout (git top level when known, else
 * the cwd), stepping up once past a branch- or version-named directory, and
 * sanitised to the name alphabet. Never empty and never reserved.
 */
export declare function directoryBase(cwd: string, gitTopLevel?: string): string;
/**
 * The base name: the session name when the user set it (`/rename`) and it
 * is valid raw, else `dirBase`. Model-generated titles (`titleSource`
 * `"auto"`) never count and are not reported. A user name that fails
 * validation comes back as `rejected` so the caller can warn once.
 */
export declare function chooseBase(input: {
    sessionName: string | undefined;
    titleSource: string | undefined;
    dirBase: string;
}): {
    base: string;
    rejected?: string;
};
/** The base a record publishes; records from older versions carry only their name. */
export declare function recordBase(record: PeerRecord): string;
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
export declare function resolvePeerName(input: ResolveNameInput): string;
/** The key hop and wake accounting use for a peer: its session id, else its name. */
export declare function peerKey(sessionId: string | undefined, name: string): string;
export type PeerLookup = {
    found: true;
    record: PeerRecord;
} | {
    found: false;
    reason: string;
};
/**
 * Resolve an address against live peers, case-insensitively: exact name →
 * an alias held by exactly one peer (tab label or a name held in the last
 * minutes) → a session id or a prefix of at least 8 of its characters.
 */
export declare function lookupPeer(to: string, peers: PeerRecord[]): PeerLookup;
