import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureRoot = fileURLToPath(new URL('../../.review-artifacts/image-cache-metadata-fixtures/', import.meta.url));
const originalServerDataDir = process.env.SERVER_DATA_DIR;

function createExclusiveFixtureDirectory(): string {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const directory = path.join(fixtureRoot, randomUUID());
  fs.mkdirSync(directory);
  return directory;
}

describe('image cache metadata', () => {
  let fixtureDirectory: string;
  let cacheDirectory: string;
  let dbModule: typeof import('./db.js');
  let metadata: typeof import('./imageCacheMetadata.js');

  beforeEach(async () => {
    vi.resetModules();
    fixtureDirectory = createExclusiveFixtureDirectory();
    process.env.SERVER_DATA_DIR = fixtureDirectory;
    dbModule = await import('./db.js');
    metadata = await import('./imageCacheMetadata.js');
    dbModule.initDatabase();
    cacheDirectory = path.join(fixtureDirectory, 'cached-images');
    fs.mkdirSync(cacheDirectory, { recursive: true });
  });

  afterEach(() => {
    dbModule.closeDatabase();
    if (originalServerDataDir === undefined) delete process.env.SERVER_DATA_DIR;
    else process.env.SERVER_DATA_DIR = originalServerDataDir;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('reconciles final regular files by basename and exact bytes while excluding temps and directories', async () => {
    await fs.promises.writeFile(path.join(cacheDirectory, 'final.png'), Buffer.from('exact-bytes'));
    await fs.promises.writeFile(path.join(cacheDirectory, 'partial.tmp'), Buffer.from('partial'));
    await fs.promises.mkdir(path.join(cacheDirectory, 'nested'));
    metadata.recordImageCachePublication('stale.png', 999, 1);

    await expect(metadata.reconcileImageCacheMetadata(cacheDirectory)).resolves.toBe(true);

    const rows = dbModule.getDatabase().prepare(
      'SELECT basename, size, last_access FROM image_cache_metadata ORDER BY basename',
    ).all();
    expect(rows).toEqual([{ basename: 'final.png', size: Buffer.byteLength('exact-bytes'), last_access: expect.any(Number) }]);
  });

  it('preserves existing metadata when a directory scan fails', async () => {
    metadata.recordImageCachePublication('retained.png', 4, 123);
    const readdir = vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(new Error('scan denied'));

    await expect(metadata.reconcileImageCacheMetadata(cacheDirectory)).resolves.toBe(false);
    expect(dbModule.getDatabase().prepare(
      'SELECT basename, size, last_access FROM image_cache_metadata',
    ).all()).toEqual([{ basename: 'retained.png', size: 4, last_access: 123 }]);
    readdir.mockRestore();
  });

  it('preserves existing metadata when synchronous startup directory reading fails', () => {
    metadata.recordImageCachePublication('retained.png', 4, 123);
    const readdir = vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => {
      throw new Error('scan denied');
    });

    expect(metadata.reconcileImageCacheMetadataSync(cacheDirectory)).toBe(false);
    expect(dbModule.getDatabase().prepare(
      'SELECT basename, size, last_access FROM image_cache_metadata',
    ).all()).toEqual([{ basename: 'retained.png', size: 4, last_access: 123 }]);
    readdir.mockRestore();
  });

  it('preserves existing metadata when synchronous startup file stat fails', () => {
    fs.writeFileSync(path.join(cacheDirectory, 'published.png'), 'exact');
    metadata.recordImageCachePublication('retained.png', 4, 123);
    const stat = vi.spyOn(fs, 'statSync').mockImplementationOnce(() => {
      throw new Error('stat denied');
    });

    expect(metadata.reconcileImageCacheMetadataSync(cacheDirectory)).toBe(false);
    expect(dbModule.getDatabase().prepare(
      'SELECT basename, size, last_access FROM image_cache_metadata',
    ).all()).toEqual([{ basename: 'retained.png', size: 4, last_access: 123 }]);
    stat.mockRestore();
  });

  it('updates only the access time for hits and retains metadata after failed unlink cleanup', () => {
    metadata.recordImageCachePublication('hit.png', 7, 10);
    metadata.touchImageCacheMetadata('hit.png', 20);
    metadata.removeImageCacheMetadata('hit.png', false);

    expect(dbModule.getDatabase().prepare(
      'SELECT basename, size, last_access FROM image_cache_metadata',
    ).all()).toEqual([{ basename: 'hit.png', size: 7, last_access: 20 }]);

    metadata.removeImageCacheMetadata('hit.png', true);
    expect(dbModule.getDatabase().prepare('SELECT * FROM image_cache_metadata').all()).toEqual([]);
  });

  it('returns the metadata-only aggregate cache size', () => {
    metadata.recordImageCachePublication('first.png', 7, 10);
    metadata.recordImageCachePublication('second.png', 11, 20);

    expect(metadata.getImageCacheMetadataTotalBytes()).toBe(18);
  });

  it('lists a bounded oldest batch with deterministic basename ties', () => {
    metadata.recordImageCachePublication('zebra.png', 3, 10);
    metadata.recordImageCachePublication('alpha.png', 4, 10);
    metadata.recordImageCachePublication('later.png', 5, 20);

    expect(metadata.listOldestImageCacheMetadata(2)).toEqual([
      { basename: 'alpha.png', size: 4, lastAccess: 10 },
      { basename: 'zebra.png', size: 3, lastAccess: 10 },
    ]);
    expect(metadata.listOldestImageCacheMetadata(0)).toBeUndefined();
    expect(metadata.listOldestImageCacheMetadata(65)).toBeUndefined();
  });

  it('returns the transactionally reconciled total only after successful unlink metadata removal', () => {
    metadata.recordImageCachePublication('removed.png', 7, 10);
    metadata.recordImageCachePublication('retained.png', 11, 20);

    expect(metadata.removeImageCacheMetadata('removed.png', true)).toBe(11);
    expect(metadata.removeImageCacheMetadata('retained.png', false)).toBeUndefined();
    expect(metadata.getImageCacheMetadataTotalBytes()).toBe(11);
  });

  it('reconciles a confirmed-missing stale basename without a directory scan', () => {
    metadata.recordImageCachePublication('stale.png', 7, 10);
    metadata.recordImageCachePublication('retained.png', 11, 20);
    const readdir = vi.spyOn(fs.promises, 'readdir');
    const stat = vi.spyOn(fs.promises, 'stat');

    expect(metadata.reconcileMissingImageCacheMetadata('stale.png')).toBe(11);
    expect(readdir).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });
});
