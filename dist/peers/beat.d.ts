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
export interface BeatLoop {
    /** Run the job now, or once more after the run in flight. */
    request(): Promise<void>;
    /** Start no further runs; settles once the run in flight has finished. */
    stop(): Promise<void>;
}
export declare function createBeatLoop(job: () => Promise<void>, onError: (err: unknown) => void): BeatLoop;
