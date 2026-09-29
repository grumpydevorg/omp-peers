/**
 * State-directory layout and path helpers.
 *
 * The state dir is machine-global and NEVER repo-local. Resolution order:
 *   1. `$OMP_PEERS_DIR` (explicit override)
 *   2. `%LOCALAPPDATA%\omp-peers`   (Windows)
 *   3. `$HOME/.omp/var/omp-peers`   (fallback)
 *
 * Layout:
 *   <state>/peers/<pid>.json      owner-only presence records (0600)
 *   <state>/peers/<pid>.sock      unix sockets (non-Windows only)
 */

import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

function stripTrailingSeparators(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

/** Resolve the machine-global state dir from the environment. */
export function resolveStateDir(): string {
  const override = process.env.OMP_PEERS_DIR;
  if (override !== undefined && override.trim() !== '') {
    return stripTrailingSeparators(override);
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData.trim() !== '') {
    return join(stripTrailingSeparators(localAppData), 'omp-peers');
  }
  return join(homedir(), '.omp', 'var', 'omp-peers');
}

/** Directory holding one `<pid>.json` presence record per live peer. */
export function peersDir(stateDir: string = resolveStateDir()): string {
  return join(stateDir, 'peers');
}

/** Presence record for one peer pid (single writer: the owning process). */
export function peerPath(pid: number, stateDir: string = resolveStateDir()): string {
  return join(peersDir(stateDir), `${pid}.json`);
}

/** Create the fixed state directory skeleton. Returns the state dir. */
export async function ensureStateDirs(stateDir: string = resolveStateDir()): Promise<string> {
  await mkdir(stateDir, { recursive: true });
  await mkdir(peersDir(stateDir), { recursive: true });
  // mkdir's mode only applies to dirs it creates — chmod unconditionally so
  // pre-existing installs get repaired too. Other users must not reach the
  // socket files (local prompt-injection surface).
  if (process.platform !== 'win32') {
    await chmod(stateDir, 0o700).catch(() => undefined);
    await chmod(peersDir(stateDir), 0o700).catch(() => undefined);
  }
  return stateDir;
}
