/**
 * Inbound delivery — hand a socket message to the LOCAL agent.
 *
 * PRIMARY PATH: `cur.pi.sendUserMessage(text)` on the CURRENT context's pi
 * with default semantics — streaming queues as steer, idle starts a turn,
 * plan mode folds it into context. No registry lookup, no own-agent-id
 * discovery, no drop-for-undiscovered: the host's bus copy is unreachable
 * from a compiled extension, so delivery goes through the extension-host
 * surface that is always live on the current context.
 *
 * STRUCTURAL RULE: the session is NEVER snapshotted at boot. The current
 * `{pi, ctx}` comes from a live getter (refreshed on every host event).
 * Over-budget wakes are appended to the transcript without starting a turn
 * (`pi.sendMessage` with no `triggerTurn`), always on the CURRENT pi, never
 * a factory-captured one.
 */
import type { InboundMessage } from './server.js';
import type { CommandContextLike, ExtensionHostLike } from './host.js';
/** Default wakes one sender may spend per window before its messages wait for the next turn. */
export declare const MAX_WAKES_PER_PEER_PER_HOUR = 20;
/** Default length of the rolling wake window. */
export declare const WAKE_WINDOW_MS = 3600000;
/** Session entry type of a peer message that waited for the next turn instead of waking the agent. */
export declare const DEFERRED_ENTRY = "omp-peers.deferred";
/**
 * How many turns one sender may start in an idle session per rolling window.
 * `maxWakes: 0` means peer messages never wake an idle session.
 */
export interface WakeBudget {
    readonly maxWakes: number;
    readonly windowMs: number;
}
export declare const DEFAULT_WAKE_BUDGET: WakeBudget;
/** Environment variable holding the wakes each sender may spend per window. */
export declare const MAX_WAKES_ENV = "OMP_PEERS_MAX_WAKES";
/** Environment variable holding the wake window, in seconds. */
export declare const WAKE_WINDOW_ENV = "OMP_PEERS_WAKE_WINDOW_SECONDS";
/**
 * The wake budget from the environment of the omp process, read once when
 * the node starts. It is the user's setting, not the agent's: no tool or
 * command changes it, and an agent's shell cannot reach the environment of
 * the process it runs in. An unset variable takes the default; an invalid one
 * takes the default and is reported through `onInvalid`.
 */
export declare function readWakeBudget(env: Readonly<Record<string, string | undefined>>, onInvalid?: (text: string) => void): WakeBudget;
/** A batch held while the peer types waits at most this long before delivering anyway. */
export declare const HOLD_TIMEOUT_MS = 120000;
/** Upper bound on batches waiting for the peer's composer to clear. */
export declare const MAX_HELD_BATCHES = 20;
/** How often a process retries its held batches. */
export declare const HOLD_POLL_MS = 500;
export interface InboundCarrier {
    from: string;
    fromId?: string;
    body: string;
    replyTo?: string;
    /** PURE RECEIPT — DISPLAY-ONLY TOAST PATH, NEVER A WAKE. */
    ack?: boolean;
    /** The sender's user typed this (`/msg`), not its agent. */
    human?: boolean;
}
export interface CurrentHost {
    pi: ExtensionHostLike;
    ctx: CommandContextLike;
}
/** One coalesced batch waiting for the peer's composer to clear. */
export interface HeldBatch {
    message: InboundMessage;
    receivedAt: number;
}
/**
 * `aside` (wire value, kept for older senders): over the wake budget, the
 * message was added to the transcript and the agent reads it on its next
 * turn; no turn was started for it.
 */
export type InboundOutcome = 'injected' | 'woken' | 'aside' | 'dropped' | 'held' | 'acked';
export interface InboundDeps {
    /** Live getter for the freshest host handles — called on every delivery. */
    getCurrent: () => CurrentHost | undefined;
    /** Live composer text — non-empty means the peer is typing. Absent headless. */
    getDraftText?: () => string;
    /** When this batch first arrived — bounds how long a hold may last. */
    receivedAt?: number;
    /** In-memory per-peer wake timestamps; owned by the caller. */
    wakes?: Map<string, number[]>;
    /** Wakes allowed per sender per window; the default when absent. */
    budget?: WakeBudget;
    now?: () => number;
}
/**
 * Every injection carries the `[peer <name>]` prefix (the hop reset in
 * extension.ts keys on it) plus a line saying who wrote it. Text the peer's
 * user typed is labelled as such, but it is still not THIS agent's user
 * speaking: the sender's claim is unverifiable, so it carries no authority.
 */
export declare function formatPeerText(from: string, body: string, opts?: {
    replyTo?: string | undefined;
    human?: boolean | undefined;
}): string;
/** True when `from` already consumed its wake budget (prunes first). */
export declare function isWakeOverBudget(wakes: Map<string, number[]>, from: string, now: number, budget?: WakeBudget): boolean;
/** Record one real wake for `from` (prunes stamps older than the window). */
export declare function recordPeerWake(wakes: Map<string, number[]>, from: string, now: number, windowMs?: number): void;
/**
 * Deliver one coalesced inbound message. Never throws; the outcome tells the
 * socket layer what receipt to send back.
 */
export declare function deliverInboundPeerMessage(frame: InboundCarrier, deps: InboundDeps): Promise<{
    outcome: InboundOutcome;
    detail?: string;
}>;
