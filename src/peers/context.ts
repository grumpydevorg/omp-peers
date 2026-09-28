/**
 * Slow environment facts a peer name draws on: the git top level of the
 * working directory and the terminal tab label (herdr). Both come from
 * subprocesses, so they are fetched in the background with a timeout and
 * cached. The heartbeat reads the cache and never waits on a subprocess:
 * a hung `git` or `herdr` must not delay the beat past the liveness TTL.
 */

import { execFile } from 'node:child_process';

/** Longest a single lookup may run before it is abandoned. */
export const LOOKUP_TIMEOUT_MS = 1_500;
/** How often the tab label is re-read, so a renamed tab shows up. */
export const LABEL_REFRESH_MS = 60_000;

type Run = (file: string, args: string[]) => Promise<string>;

const run: Run = (file, args) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(file, args, { timeout: LOOKUP_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
    if (err) reject(err);
    else resolve(stdout);
  });
  return promise;
};

/** `record[key]` when `record` is an object, else `undefined`. */
function field(record: unknown, key: string): unknown {
  if (typeof record !== 'object' || record === null || !(key in record)) return undefined;
  return Reflect.get(record, key);
}

/** The `result` object of a herdr socket-API reply. */
function herdrResult(stdout: string): unknown {
  return field(JSON.parse(stdout), 'result');
}

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
export function createEnvLookups(options: EnvLookupOptions = {}): EnvLookups {
  const env = options.env ?? process.env;
  const exec = options.run ?? run;
  const now = options.now ?? Date.now;
  const report = (what: string, err: unknown): void => {
    options.onError?.(`peers: ${what} lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  };

  // cwd → top level (null = looked up, not a work tree).
  const topLevels = new Map<string, string | null>();
  const topLevelsInFlight = new Map<string, Promise<unknown>>();

  let label: string | undefined;
  let labelReadAt = Number.NEGATIVE_INFINITY;
  let labelInFlight: Promise<unknown> | undefined;

  const paneId = env['HERDR_PANE_ID'];
  const herdr = env['HERDR_BIN_PATH'] ?? 'herdr';

  async function readLabel(pane: string): Promise<string | undefined> {
    // The pane's tab is re-read each time: panes can move between tabs, so
    // the HERDR_TAB_ID the process was spawned with may be stale.
    const tabId = field(field(herdrResult(await exec(herdr, ['pane', 'get', pane])), 'pane'), 'tab_id');
    if (typeof tabId !== 'string') return undefined;
    const tabLabel = field(field(herdrResult(await exec(herdr, ['tab', 'get', tabId])), 'tab'), 'label');
    return typeof tabLabel === 'string' ? tabLabel : undefined;
  }

  return {
    gitTopLevel(cwd) {
      const cached = topLevels.get(cwd);
      if (cached !== undefined) return cached ?? undefined;
      if (!topLevelsInFlight.has(cwd)) {
        const lookup = exec('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])
          .then((out) => topLevels.set(cwd, out.trim() || null))
          .catch(() => topLevels.set(cwd, null)) // Not a work tree, or no git: use the cwd.
          .finally(() => topLevelsInFlight.delete(cwd));
        topLevelsInFlight.set(cwd, lookup);
      }
      return undefined;
    },
    tabLabel() {
      if (paneId === undefined || paneId === '' || env['HERDR_ENV'] !== '1') return undefined;
      if (labelInFlight === undefined && now() - labelReadAt >= LABEL_REFRESH_MS) {
        labelReadAt = now();
        labelInFlight = readLabel(paneId)
          .then((value) => {
            label = value;
          })
          .catch((err: unknown) => report('herdr tab label', err))
          .finally(() => {
            labelInFlight = undefined;
          });
      }
      return label;
    },
    async prime(cwd) {
      this.gitTopLevel(cwd);
      this.tabLabel();
      await Promise.allSettled([topLevelsInFlight.get(cwd), labelInFlight]);
    },
  };
}
