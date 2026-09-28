/**
 * Slow environment facts a peer name draws on: the git top level of the
 * working directory and the terminal tab label (herdr). Both come from
 * subprocesses, so they are fetched in the background with a timeout and
 * cached. The heartbeat reads the cache and never waits on a subprocess:
 * a hung `git` or `herdr` must not delay the beat past the liveness TTL.
 */
/** Longest a single lookup may run before it is abandoned. */
export declare const LOOKUP_TIMEOUT_MS = 1500;
/** How often the tab label is re-read, so a renamed tab shows up. */
export declare const LABEL_REFRESH_MS = 60000;
type Run = (file: string, args: string[]) => Promise<string>;
export interface EnvLookups {
    /** Cached git top level for `cwd`; `undefined` until known or when `cwd` is not in a work tree. */
    gitTopLevel(cwd: string): string | undefined;
    /** Cached tab label, or `undefined` outside herdr or before the first read. */
    tabLabel(): string | undefined;
    /**
     * Start both lookups for `cwd` and wait for them (each bounded by
     * {@link LOOKUP_TIMEOUT_MS}). Called once before the first beat, so a
     * fresh peer does not publish a cwd-derived name and rename itself one
     * beat later.
     */
    prime(cwd: string): Promise<void>;
}
export interface EnvLookupOptions {
    env?: NodeJS.ProcessEnv;
    run?: Run;
    now?: () => number;
    onError?: (message: string) => void;
}
/**
 * Cached, non-blocking lookups. Each getter returns the cached value at once
 * and, when the value is missing or stale, starts one background refresh.
 */
export declare function createEnvLookups(options?: EnvLookupOptions): EnvLookups;
export {};
