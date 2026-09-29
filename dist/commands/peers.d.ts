/**
 * The user's commands: `/peers` and `/msg`.
 *
 * `/peers` always has a text form. In the TUI (`ctx.ui.select` present and
 * `ctx.mode === 'tui'`) it is a picker of the OTHER peers — this session is
 * named in the title, not offered as a row — and picking one opens an action
 * menu: Message, Status, Hand to my agent. No UI module is ever imported; the
 * primitives are probed on the live ctx and called as receiver methods.
 *
 * `/msg <peer> <text>` and the Message action send text the user typed
 * straight to the peer, without a turn of this session's agent. The frame is
 * marked `human`, so the receiver labels it as typed by this peer's user; it
 * still carries no authority there.
 */
import type { ExtensionHostLike } from '../peers/host.js';
import type { PeerRecord } from '../types.js';
export interface PeersSnapshot {
    ownName: string;
    peers: PeerRecord[];
    /** Batches held while the peer types — shown so held mail is visible. */
    held?: number;
}
export interface PeerCommandDeps {
    getSnapshot: () => Promise<PeersSnapshot>;
    /** Deliver text the user typed; resolves to the human-readable receipt. Never throws. */
    sendAsUser: (to: string, body: string) => Promise<string>;
}
/** `backend · omp(1234) · C:\work · model-id · working · beat 3s ago`. */
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
