/**
 * Durability primitives.
 *
 * A target is replaced by writing and fsyncing a unique sidecar next to it,
 * then putting the sidecar in its place:
 *  - POSIX: `rename` over the target, which is atomic — a reader opens either
 *    the old file or the new one, never a partial write.
 *  - Windows: `copyFile` over the target. Renaming over a file another
 *    process has open fails with EPERM there (the failure the old plugin died
 *    on), so the copy stays, and a reader can land mid-copy.
 *
 * Readers of any JSON file tolerate a partial read (Windows) with one bounded
 * retry.
 */
/**
 * Read and parse one JSON file. Missing file → undefined. A read that lands
 * mid-copy (partial content → parse error, or a transient EPERM/EBUSY) is
 * retried `retries` times with `retryDelayMs` between attempts; persistent
 * parse failure throws CorruptStateError.
 */
export declare function readJsonFile<T = unknown>(filePath: string, opts?: {
    retries?: number;
    retryDelayMs?: number;
}): Promise<T | undefined>;
/**
 * Durably replace a JSON file: write a unique sidecar next to the target,
 * fsync it, then rename it over the target (POSIX, atomic) or copy it over
 * the target and delete it (Windows). See the module comment.
 */
export declare function durableWriteJson(filePath: string, data: unknown, opts?: {
    pretty?: boolean;
}): Promise<void>;
