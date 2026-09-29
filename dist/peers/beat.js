/**
 * Single-flight loop around one asynchronous job — the heartbeat.
 *
 * Several callers ask for a beat (the timer, `/peers`, session events) and
 * shutdown must come after the last one. The loop guarantees:
 *
 * - at most one run of the job at a time;
 * - no request is lost: `request()` settles only after a run that started
 *   after the call has finished (or once the loop is stopped);
 * - stop is final: after `stop()` no run starts, and `stop()` settles only
 *   when the run in flight, if any, has finished — so the caller's cleanup
 *   (unlinking the presence record) comes after the job's last write.
 */
export function createBeatLoop(job, onError) {
    let stopped = false;
    let dirty = false;
    let driving;
    // Callers waiting for a run that starts after they asked.
    let waiting = [];
    const release = (callers) => {
        for (const settle of callers)
            settle();
    };
    async function drive() {
        while (dirty && !stopped) {
            dirty = false;
            const served = waiting;
            waiting = [];
            try {
                await job();
            }
            catch (err) {
                try {
                    onError(err);
                }
                catch {
                    // Error reporting never breaks the loop.
                }
            }
            release(served);
        }
        // Synchronous from the loop test to here: a request cannot slip between.
        driving = undefined;
        if (stopped) {
            release(waiting);
            waiting = [];
        }
    }
    return {
        request() {
            if (stopped)
                return Promise.resolve();
            const asked = new Promise((settle) => waiting.push(settle));
            dirty = true;
            if (driving === undefined) {
                // Assigned before the job's first await, so a job that requests
                // again synchronously joins this loop instead of starting another.
                driving = Promise.resolve().then(drive);
            }
            return asked;
        },
        async stop() {
            stopped = true;
            await driving;
            release(waiting);
            waiting = [];
        },
    };
}
