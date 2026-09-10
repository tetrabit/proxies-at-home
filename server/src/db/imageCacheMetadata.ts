import fs from 'node:fs';
import path from 'node:path';

import { getDatabase } from './db.js';

export interface ImageCacheMetadataRow {
  basename: string;
  size: number;
  last_access: number;
}

export interface ImageCacheEvictionCandidate {
  basename: string;
  size: number;
  lastAccess: number;
}

function isFinalCacheBasename(basename: string): boolean {
  return basename.length > 0
    && basename === path.basename(basename)
    && !basename.endsWith('.tmp');
}

function logMetadataFailure(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[Image cache metadata] ${action} failed; startup reconciliation will repair disk/metadata divergence: ${message}`);
}

/**
 * Records a file only after its atomic rename has published exactly `size` bytes.
 * Metadata is advisory: failure is logged but never retracts a published file.
 */
export function recordImageCachePublication(basename: string, size: number, lastAccess = Date.now()): void {
  if (!isFinalCacheBasename(basename)) return;

  try {
    getDatabase().prepare(`
      INSERT INTO image_cache_metadata (basename, size, last_access)
      VALUES (?, ?, ?)
      ON CONFLICT(basename) DO UPDATE SET size = excluded.size, last_access = excluded.last_access
    `).run(basename, size, lastAccess);
  } catch (error) {
    logMetadataFailure('publication recording', error);
  }
}

/**
 * Refreshes only recency for a cache hit; size remains the publication value.
 */
export function touchImageCacheMetadata(basename: string, lastAccess = Date.now()): void {
  if (!isFinalCacheBasename(basename)) return;

  try {
    getDatabase().prepare(
      'UPDATE image_cache_metadata SET last_access = ? WHERE basename = ?',
    ).run(lastAccess, basename);
  } catch (error) {
    logMetadataFailure('access recording', error);
  }
}

/** Returns the durable byte total without inspecting the cache directory. */
export function getImageCacheMetadataTotalBytes(): number | undefined {
  try {
    const row = getDatabase().prepare(
      'SELECT COALESCE(SUM(size), 0) AS totalBytes FROM image_cache_metadata',
    ).get() as { totalBytes: number };
    return row.totalBytes;
  } catch (error) {
    logMetadataFailure('aggregate read', error);
    return undefined;
  }
}

/**
 * Returns no more than one eviction batch in deterministic least-recently-used
 * order. Limits outside the bounded request-cleanup range intentionally do not
 * issue a database query.
 */
export function listOldestImageCacheMetadata(limit: number): ImageCacheEvictionCandidate[] | undefined {
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) return undefined;

  try {
    const rows = getDatabase().prepare(
      `SELECT basename, size, last_access FROM image_cache_metadata
       ORDER BY last_access ASC, basename ASC
       LIMIT ?`,
    ).all(limit) as ImageCacheMetadataRow[];
    return rows.map(({ basename, size, last_access: lastAccess }) => ({ basename, size, lastAccess }));
  } catch (error) {
    logMetadataFailure('oldest batch read', error);
    return undefined;
  }
}

/**
 * Removes metadata only once filesystem unlink has succeeded, then returns the
 * durable aggregate observed in that same transaction. A failed unlink retains
 * its row and leaves the byte budget authoritative.
 */
export function removeImageCacheMetadata(basename: string, unlinkSucceeded: boolean): number | undefined {
  if (!unlinkSucceeded || !isFinalCacheBasename(basename)) return undefined;

  try {
    const database = getDatabase();
    const remove = database.prepare('DELETE FROM image_cache_metadata WHERE basename = ?');
    const total = database.prepare(
      'SELECT COALESCE(SUM(size), 0) AS totalBytes FROM image_cache_metadata',
    );
    return database.transaction(() => {
      remove.run(basename);
      return (total.get() as { totalBytes: number }).totalBytes;
    })();
  } catch (error) {
    logMetadataFailure('unlink recording', error);
    return undefined;
  }
}

/**
 * Idempotently removes metadata for a final file confirmed absent by ENOENT.
 * It never inspects the directory; the returned total is durable or unknown.
 */
export function reconcileMissingImageCacheMetadata(basename: string): number | undefined {
  return removeImageCacheMetadata(basename, true);
}

/**
 * Performs the startup repair boundary. The directory must be scanned completely
 * before any row is changed, so a readdir/stat failure preserves every old row.
 */
export async function reconcileImageCacheMetadata(cacheDirectory: string): Promise<boolean> {
  let files: ImageCacheMetadataRow[];
  try {
    await fs.promises.mkdir(cacheDirectory, { recursive: true });
    const entries = await fs.promises.readdir(cacheDirectory, { withFileTypes: true });
    files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !isFinalCacheBasename(entry.name)) continue;
      const stats = await fs.promises.stat(path.join(cacheDirectory, entry.name));
      if (!stats.isFile()) continue;
      files.push({
        basename: entry.name,
        size: stats.size,
        last_access: Math.trunc(stats.atimeMs),
      });
    }
  } catch (error) {
    logMetadataFailure('startup reconciliation scan', error);
    return false;
  }

  return applyReconciliation(files);
}

/** Runs the same complete repair synchronously during database startup. */
export function reconcileImageCacheMetadataSync(cacheDirectory: string): boolean {
  let files: ImageCacheMetadataRow[];
  try {
    fs.mkdirSync(cacheDirectory, { recursive: true });
    files = [];
    for (const entry of fs.readdirSync(cacheDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !isFinalCacheBasename(entry.name)) continue;
      const stats = fs.statSync(path.join(cacheDirectory, entry.name));
      if (!stats.isFile()) continue;
      files.push({ basename: entry.name, size: stats.size, last_access: Math.trunc(stats.atimeMs) });
    }
  } catch (error) {
    logMetadataFailure('startup reconciliation scan', error);
    return false;
  }

  return applyReconciliation(files);
}

function applyReconciliation(files: ImageCacheMetadataRow[]): boolean {
  try {
    const database = getDatabase();
    const upsert = database.prepare(`
      INSERT INTO image_cache_metadata (basename, size, last_access)
      VALUES (?, ?, ?)
      ON CONFLICT(basename) DO UPDATE SET size = excluded.size
    `);
    const removeMissing = database.prepare('DELETE FROM image_cache_metadata WHERE basename = ?');
    const existing = database.prepare('SELECT basename FROM image_cache_metadata').all() as Array<{ basename: string }>;
    const discovered = new Set(files.map(({ basename }) => basename));

    database.transaction(() => {
      for (const file of files) upsert.run(file.basename, file.size, file.last_access);
      for (const { basename } of existing) {
        if (!discovered.has(basename)) removeMissing.run(basename);
      }
    })();
    return true;
  } catch (error) {
    logMetadataFailure('startup reconciliation write', error);
    return false;
  }
}
