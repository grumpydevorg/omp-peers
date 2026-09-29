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

import { createBeatLoop } from './beat.js';
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

export function createHeldQueue(deps: HeldQueueDeps): HeldQueue {
  let batches: HeldBatch[] = [];
  let inFlight: HeldBatch | undefined;
  let draining = false;
  // Notices still going out; a drain waits for every one, not just its own.
  const notices = new Set<Promise<void>>();

  const drop = (batch: HeldBatch, reason: string): void => {
    const notice = deps
      .dropped(batch, reason)
      .catch((err: unknown) => deps.onError(err))
      .finally(() => notices.delete(notice));
    notices.add(notice);
  };

  const loop = createBeatLoop(async () => {
    for (const batch of [...batches]) {
      if (draining) return;
      // Dropped since this pass began (overflow while an earlier batch was
      // being delivered): its sender was already told it will not arrive.
      if (!batches.includes(batch)) continue;
      inFlight = batch;
      let outcome: InboundOutcome;
      try {
        outcome = await deps.deliver(batch);
      } catch (err) {
        deps.onError(err);
        outcome = 'dropped';
      } finally {
        inFlight = undefined;
      }
      if (outcome === 'held') continue;
      batches = batches.filter((b) => b !== batch);
      if (outcome === 'dropped') drop(batch, 'delivery failed');
    }
  }, deps.onError);

  return {
    get size(): number {
      return batches.length;
    },
    hold(batch: HeldBatch): void {
      if (draining) {
        drop(batch, 'the peer is shutting down');
        return;
      }
      batches.push(batch);
      while (batches.length > deps.max) {
        const oldest = batches.find((b) => b !== inFlight);
        if (oldest === undefined) break;
        batches = batches.filter((b) => b !== oldest);
        drop(oldest, 'too many messages were waiting');
      }
    },
    retry: () => loop.request(),
    async drain(reason: string): Promise<void> {
      draining = true;
      await loop.stop();
      for (const batch of batches) drop(batch, reason);
      batches = [];
      while (notices.size > 0) await Promise.all(notices);
    },
  };
}
