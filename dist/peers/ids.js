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
import { basename, dirname } from 'node:path';
import { PeerNameError } from '../errors.js';
export const PEER_NAME_PATTERN = /^[\w.-]{1,24}$/;
/**
 * Refused as names in any case: `main` is the host's driving agent id,
 * `all` reads as a broadcast, `self` as the sender. Purely numeric names are
 * refused too — they read as a pid or a default terminal-tab number.
 */
const RESERVED_NAMES = { main: true, all: true, self: true };
const NUMERIC = /^\d+$/;
export function isValidPeerName(name) {
    return PEER_NAME_PATTERN.test(name) && RESERVED_NAMES[name.toLowerCase()] !== true && !NUMERIC.test(name);
}
/** Throw {@link PeerNameError} unless `name` is usable as a peer address. */
export function validatePeerName(name) {
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
export function directoryBase(cwd, gitTopLevel) {
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
export function chooseBase(input) {
    const raw = input.sessionName;
    if (input.titleSource === 'auto' || raw === undefined || raw === '')
        return { base: input.dirBase };
    if (isValidPeerName(raw))
        return { base: raw };
    return { base: input.dirBase, rejected: raw };
}
/**
 * Separates a base from its suffix. It lies outside the base alphabet
 * (`[\w.-]`), so no base — however it was chosen — can spell another peer's
 * suffixed name: each base group is its own namespace.
 */
export const SUFFIX_SEPARATOR = '#';
/** Anything outside the base alphabet, replaced when a record's base is read. */
const NOT_BASE_CHAR = /[^\w.-]/g;
/**
 * The base a record publishes, in the base alphabet. Records from older
 * versions carry only their name; a record claiming a separator in its base
 * cannot forge a suffixed name.
 */
export function recordBase(record) {
    return (record.base ?? record.name).replace(NOT_BASE_CHAR, '-');
}
/** Session-id tail lengths tried in order; the leading digits are a timestamp shared by all peers. */
const TAIL_LENGTHS = [4, 6, 8];
/**
 * Suffixes for one group of peers sharing a base. Members with a session id
 * of their own take its shortest tail at which those ids are distinct (the
 * whole id at worst). A member with no id, or one another member shares (two
 * processes resuming one session), also appends `_<pid>`. Tails never
 * contain `_` and pids are distinct, so the suffixes are distinct by
 * construction.
 */
function groupSuffixes(group) {
    const ids = group.map((source) => source.sessionId.toLowerCase().replace(/[^0-9a-z]/g, ''));
    const shared = ids.map((id) => id === '' || ids.indexOf(id) !== ids.lastIndexOf(id));
    const own = ids.filter((_, index) => shared[index] !== true);
    const length = TAIL_LENGTHS.find((l) => new Set(own.map((id) => id.slice(-l))).size === own.length) ?? Number.POSITIVE_INFINITY;
    return group.map((source, index) => {
        const tail = ids[index]?.slice(-length) ?? '';
        return shared[index] === true ? `${tail}_${source.pid}` : tail;
    });
}
/**
 * Every peer's name, as a function of the whole set (pids distinct): the
 * base alone when no other peer shares it (case-insensitive), else
 * `<base>#<suffix>` for every sharer. Names are pairwise distinct, do not
 * depend on input order, and a peer's name depends only on the peers that
 * share its base — every reader of the same set computes the same names.
 */
export function deriveNames(sources) {
    const groups = new Map();
    for (const source of sources) {
        const key = source.base.toLowerCase();
        const group = groups.get(key);
        if (group === undefined)
            groups.set(key, [source]);
        else
            group.push(source);
    }
    const names = new Map();
    for (const group of groups.values()) {
        const [only] = group;
        if (group.length === 1 && only !== undefined) {
            names.set(only.pid, only.base);
            continue;
        }
        const suffixes = groupSuffixes(group);
        group.forEach((source, index) => {
            names.set(source.pid, `${source.base}${SUFFIX_SEPARATOR}${suffixes[index] ?? ''}`);
        });
    }
    return names;
}
/**
 * One peer's view of the roster: its own name and every other record under
 * its derived name, all computed from the same set — `self` from the
 * reader's current state, not its last beat. A published name that differs
 * (an older peer's, or the owner's view from another snapshot) stays
 * reachable as an alias, so replies to the name a peer signs with land.
 */
export function nameRoster(records, self) {
    const others = records.filter((record) => record.pid !== self.pid);
    const bases = others.map((record) => recordBase(record));
    const names = deriveNames([
        self,
        ...others.map((record, index) => ({ pid: record.pid, base: bases[index] ?? '', sessionId: record.sessionId })),
    ]);
    return {
        self: names.get(self.pid) ?? self.base,
        others: others.map((record, index) => {
            const name = names.get(record.pid) ?? record.name;
            const aliases = [...(record.aliases ?? [])];
            if (record.name.toLowerCase() !== name.toLowerCase() && !aliases.includes(record.name)) {
                aliases.unshift(record.name);
            }
            return { ...record, base: bases[index] ?? name, name, ...(aliases.length > 0 ? { aliases } : {}) };
        }),
    };
}
/** The key hop and wake accounting use for a peer: its session id, else its name. */
export function peerKey(sessionId, name) {
    return sessionId !== undefined && sessionId !== '' ? sessionId : name.toLowerCase();
}
/**
 * Resolve an address against live peers, case-insensitively: exact name →
 * an alias held by exactly one peer (tab label or a name held in the last
 * minutes) → a session id or a prefix of at least 8 of its characters.
 * Every step refuses an address that fits more than one peer: a lookup
 * never guesses.
 */
export function lookupPeer(to, peers) {
    const key = to.trim().toLowerCase();
    const byName = peers.filter((p) => p.name.toLowerCase() === key);
    if (byName.length === 1 && byName[0] !== undefined)
        return { found: true, record: byName[0] };
    if (byName.length > 1) {
        return {
            found: false,
            reason: `"${to}" is held by ${byName.length} peers (${byName.map((p) => `pid ${p.pid} in ${p.cwd}`).join('; ')}). Address one by its session id.`,
        };
    }
    const byAlias = peers.filter((p) => (p.aliases ?? []).some((alias) => alias.toLowerCase() === key));
    if (byAlias.length === 1 && byAlias[0] !== undefined)
        return { found: true, record: byAlias[0] };
    if (byAlias.length > 1) {
        return {
            found: false,
            reason: `"${to}" is ambiguous: it names ${byAlias.map((p) => p.name).join(', ')}. Use one of those names.`,
        };
    }
    if (key.length >= 8) {
        const bySession = peers.filter((p) => p.sessionId !== '' && p.sessionId.toLowerCase().startsWith(key));
        if (bySession.length === 1 && bySession[0] !== undefined)
            return { found: true, record: bySession[0] };
    }
    const known = peers.map((p) => p.name).join(', ') || 'none';
    return { found: false, reason: `Unknown peer "${to}". Live peers: ${known}` };
}
