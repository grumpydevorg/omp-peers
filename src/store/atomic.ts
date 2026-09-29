/**
 * Windows-safe durability primitives.
 *
 * The old plugin died on EPERM races when moving a fresh file over a live one,
 * so this module NEVER moves files over live targets. Target replacement is
 * exclusively the copy-a-sidecar-over-the-target pattern (`copyFile`).
 *
 * Conventions:
 *  - Presence files: owner-only writers, no lock, sidecar + copy pattern.
 *  - Readers of any JSON file tolerate a partial read (a copy can be observed
 *    mid-flight) with one bounded retry.
 */

import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { CorruptStateError } from '../errors.js';

/** Sidecars older than this are swept after a successful write. */
const STALE_SIDECAR_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (): number => 20 + Math.floor(Math.random() * 40);

function hasErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === code;
}

/** Memoized per-process parent-directory creation. */
const ensuredParents = new Set<string>();

async function ensureParent(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  if (ensuredParents.has(dir)) {
    return;
  }
  await mkdir(dir, { recursive: true });
  ensuredParents.add(dir);
}

/**
 * Read and parse one JSON file. Missing file → undefined. A read that lands
 * mid-copy (partial content → parse error, or a transient EPERM/EBUSY) is
 * retried `retries` times with `retryDelayMs` between attempts; persistent
 * parse failure throws CorruptStateError.
 */
export async function readJsonFile<T = unknown>(
  filePath: string,
  opts: { retries?: number; retryDelayMs?: number } = {}
): Promise<T | undefined> {
  const retries = opts.retries ?? 1;
  const retryDelayMs = opts.retryDelayMs ?? 50;
  let attempt = 0;
  for (;;) {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      if (hasErrno(err, 'ENOENT')) {
        return undefined;
      }
      if ((hasErrno(err, 'EPERM') || hasErrno(err, 'EBUSY') || hasErrno(err, 'EACCES')) && attempt < retries) {
        attempt += 1;
        await sleep(retryDelayMs);
        continue;
      }
      throw err;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      if (attempt < retries) {
        attempt += 1;
        await sleep(retryDelayMs);
        continue;
      }
      throw new CorruptStateError(`unparseable JSON in ${filePath}`);
    }
  }
}

function sidecarPathFor(target: string): string {
  const nonce = randomBytes(5).toString('hex');
  return `${target}.${process.pid}.${nonce}.tmp`;
}

/** Best-effort cleanup of our own abandoned sidecars (> 1 minute old). */
async function sweepStaleSidecars(target: string): Promise<void> {
  try {
    const dir = dirname(target);
    const prefix = `${basename(target)}.`;
    const names = await readdir(dir);
    const now = Date.now();
    await Promise.all(
      names.map(async (name) => {
        if (!name.startsWith(prefix) || !name.endsWith('.tmp')) {
          return;
        }
        const full = join(dir, name);
        try {
          if (now - (await stat(full)).mtimeMs > STALE_SIDECAR_MS) {
            await unlink(full);
          }
        } catch {
          // Already gone.
        }
      })
    );
  } catch {
    // Directory missing or unreadable — sweep is best effort.
  }
}

/**
 * Durably replace a JSON file: write a unique sidecar next to the target,
 * fsync it, copy it over the target, delete the sidecar. The sidecar never
 * coexists with a move over a live file: the target is replaced in place by
 * the copy, so any reader sees either the old or the new content.
 */
export async function durableWriteJson(
  filePath: string,
  data: unknown,
  opts: { pretty?: boolean } = {}
): Promise<void> {
  await ensureParent(filePath);
  const text = `${JSON.stringify(data, null, opts.pretty === false ? undefined : 2)}\n`;
  let attempt = 0;
  for (;;) {
    const sidecar = sidecarPathFor(filePath);
    try {
      const fh = await open(sidecar, 'wx', 0o600);
      try {
        await fh.writeFile(text, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await copyFile(sidecar, filePath);
      await unlink(sidecar).catch(() => undefined);
      await sweepStaleSidecars(filePath);
      return;
    } catch (err) {
      await unlink(sidecar).catch(() => undefined);
      if ((hasErrno(err, 'EPERM') || hasErrno(err, 'EBUSY') || hasErrno(err, 'EACCES')) && attempt < 6) {
        attempt += 1;
        await sleep(jitter());
        continue;
      }
      if (hasErrno(err, 'EEXIST') && attempt < 3) {
        // Sidecar name collision (astronomically unlikely) — new nonce next try.
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}
