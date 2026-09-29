/**
 * Batches held while the peer types — each one ends exactly once.
 *
 * A sender told `held` was promised delivery, so every held batch reaches
 * exactly one end: delivered (injected, woken or queued aside), or dropped
 * with its sender told why. A batch leaves the queue only at that end.
 * Retries run single-flight — a slow delivery never races a second attempt
 * at the same batch — and a drain waits for the attempt in flight before
 * dropping the rest.
 */
import type { HeldBatch, InboundOutcome } from './inbound.js';
export interface HeldQueueDeps {
    /** One delivery attempt; `held` keeps the batch for the next retry. */
    deliver: (batch: HeldBatch) => Promise<InboundOutcome>;
    /** The batch will never be delivered: tell its sender. */
    dropped: (batch: HeldBatch, reason: string) => Promise<void>;
    /** Most batches waiting at once; the oldest not being delivered goes first. */
    max: number;
    onError: (err: unknown) => void;
}
export interface HeldQueue {
    readonly size: number;
    hold(batch: HeldBatch): void;
    /** Try every held batch once, oldest first. */
    retry(): Promise<void>;
    /** Deliver nothing more; drop what is left, telling each sender `reason`. */
    drain(reason: string): Promise<void>;
}
export declare function createHeldQueue(deps: HeldQueueDeps): HeldQueue;
