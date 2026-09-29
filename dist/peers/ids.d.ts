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
 *           (case-insensitive); then every sharer takes `<base>#<suffix>`,
 *           the suffix being the shortest session-id tail distinct within
 *           the group. `#` is outside the base alphabet, so a base can never
 *           spell another peer's suffixed name.
 *
 * Names are a function of the whole set of live records (`deriveNames`):
 * every reader of the same set computes the same, pairwise-distinct names.
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
/**
 * Separates a base from its suffix. It lies outside the base alphabet
 * (`[\w.-]`), so no base — however it was chosen — can spell another peer's
 * suffixed name: each base group is its own namespace.
 */
export declare const SUFFIX_SEPARATOR = "#";
/**
 * The base a record publishes, in the base alphabet. Records from older
 * versions carry only their name; a record claiming a separator in its base
 * cannot forge a suffixed name.
 */
export declare function recordBase(record: Pick<PeerRecord, 'base' | 'name'>): string;
/** What a name is derived from. */
export interface NameSource {
    pid: number;
    base: string;
    sessionId: string;
}
/**
 * Every peer's name, as a function of the whole set (pids distinct): the
 * base alone when no other peer shares it (case-insensitive), else
 * `<base>#<suffix>` for every sharer. Names are pairwise distinct, do not
 * depend on input order, and a peer's name depends only on the peers that
 * share its base — every reader of the same set computes the same names.
 */
export declare function deriveNames(sources: readonly NameSource[]): Map<number, string>;
/**
 * One peer's view of the roster: its own name and every other record under
 * its derived name, all computed from the same set — `self` from the
 * reader's current state, not its last beat. A published name that differs
 * (an older peer's, or the owner's view from another snapshot) stays
 * reachable as an alias, so replies to the name a peer signs with land.
 */
export declare function nameRoster(records: readonly PeerRecord[], self: NameSource): {
    self: string;
    others: PeerRecord[];
};
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
 * Every step refuses an address that fits more than one peer: a lookup
 * never guesses.
 */
export declare function lookupPeer(to: string, peers: PeerRecord[]): PeerLookup;
