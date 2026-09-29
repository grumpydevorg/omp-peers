/**
 * The user's commands: `/peers` and `/msg`.
 *
 * `/peers` always has a text form. In the TUI (`ctx.ui.select` present and
 * `ctx.mode === 'tui'`) it is a picker of the OTHER peers — this session is
 * named in the title, not offered as a row — and picking one opens an action
 * menu: Message, Status, Hand to my agent. No UI module is ever imported; the
 * primitives are probed on the live ctx and called as receiver methods.
 * `/peers leave` and `/peers join` take this session out of the peer list and
 * back; the choice is saved with the session.
 *
 * `/msg <peer> <text>` and the Message action send text the user typed
 * straight to the peer, without a turn of this session's agent. The frame is
 * marked `human`, so the receiver labels it as typed by this peer's user; it
 * still carries no authority there.
 */
import type { AutocompleteItemLike, ExtensionHostLike } from '../peers/host.js';
import type { PeerRecord } from '../types.js';
export interface PeersSnapshot {
    ownName: string;
    peers: PeerRecord[];
    /** Batches held while the peer types — shown so held mail is visible. */
    held?: number;
    /** When this session left the peer list; absent while it is in it. */
    left?: number;
}
export interface PeerCommandDeps {
    /** Fresh snapshot: re-beats first, so it reflects a just-run `/rename`. */
    getSnapshot: () => Promise<PeersSnapshot>;
    /** The last heartbeat's snapshot, read synchronously (completion runs per keystroke). */
    cachedSnapshot: () => PeersSnapshot;
    /** Deliver text the user typed; resolves to the human-readable receipt. Never throws. */
    sendAsUser: (to: string, body: string) => Promise<string>;
    /** Leave or rejoin the peer list; resolves to what to tell the user. */
    leave: () => Promise<string>;
    join: () => Promise<string>;
}
/**
 * `/msg` argument completion: while the first word is being typed, the other
 * peers whose names start with it (case-insensitive), each inserted with a
 * trailing space so the message can follow. Nothing once the name is done.
 */
export declare function completePeerNames(prefix: string, snap: PeersSnapshot, now: number): AutocompleteItemLike[] | null;
/**
 * One text-list row:
 * `backend (tab api) · omp(1234) · /work · model-id · working · beat 3s ago · fixing login · 2 todos · you`.
 * The tab, activity, todo count and `you` appear only when they apply.
 */
export declare function formatPeerLine(p: PeerRecord, now: number, selfName: string): string;
export declare function formatPeersText(snap: PeersSnapshot, now: number): string;
/**
 * Split `/msg` arguments into the peer name and the message. The name is the
 * first word; everything after it, internal newlines included, is the body.
 */
export declare function parseMsgArgs(args: string): {
    to: string;
    body: string;
} | undefined;
export declare const PEER_ACTIONS: {
    readonly message: 'Message';
    readonly status: 'Status';
    readonly handOff: 'Hand to my agent';
};
export declare function registerPeersCommand(pi: ExtensionHostLike, deps: PeerCommandDeps): void;
