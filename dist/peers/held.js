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
export function createHeldQueue(deps) {
    let batches = [];
    let inFlight;
    let draining = false;
    // Notices still going out; a drain waits for every one, not just its own.
    const notices = new Set();
    const drop = (batch, reason) => {
        const notice = deps
            .dropped(batch, reason)
            .catch((err) => deps.onError(err))
            .finally(() => notices.delete(notice));
        notices.add(notice);
    };
    const loop = createBeatLoop(async () => {
        for (const batch of [...batches]) {
            if (draining)
                return;
            // Dropped since this pass began (overflow while an earlier batch was
            // being delivered): its sender was already told it will not arrive.
            if (!batches.includes(batch))
                continue;
            inFlight = batch;
            let outcome;
            try {
                outcome = await deps.deliver(batch);
            }
            catch (err) {
                deps.onError(err);
                outcome = 'dropped';
            }
            finally {
                inFlight = undefined;
            }
            if (outcome === 'held')
                continue;
            batches = batches.filter((b) => b !== batch);
            if (outcome === 'dropped')
                drop(batch, 'delivery failed');
        }
    }, deps.onError);
    return {
        get size() {
            return batches.length;
        },
        hold(batch) {
            if (draining) {
                drop(batch, 'the peer is shutting down');
                return;
            }
            batches.push(batch);
            while (batches.length > deps.max) {
                const oldest = batches.find((b) => b !== inFlight);
                if (oldest === undefined)
                    break;
                batches = batches.filter((b) => b !== oldest);
                drop(oldest, 'too many messages were waiting');
            }
        },
        retry: () => loop.request(),
        async drain(reason) {
            draining = true;
            await loop.stop();
            for (const batch of batches)
                drop(batch, reason);
            batches = [];
            while (notices.size > 0)
                await Promise.all(notices);
        },
    };
}
