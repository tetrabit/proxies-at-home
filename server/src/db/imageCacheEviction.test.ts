import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createImageCacheEvictor } from './imageCacheEviction.js';

const GiB = 1024 * 1024 * 1024;

describe('image cache metadata eviction', () => {
  it('consumes one deterministic metadata batch and stops at the reconciled low-water total', async () => {
    const cacheDirectory = '/cache';
    const unlink = vi.fn().mockResolvedValue(undefined);
    const listOldest = vi.fn().mockReturnValue([
      { basename: 'first.png', size: GiB, lastAccess: 10 },
      { basename: 'second.png', size: GiB, lastAccess: 20 },
      { basename: 'newer.png', size: GiB, lastAccess: 30 },
    ]);
    const remove = vi.fn()
      .mockReturnValueOnce(11 * GiB)
      .mockReturnValueOnce(9 * GiB);
    const evict = createImageCacheEvictor({
      cacheDirectory,
      getTotalBytes: vi.fn().mockReturnValue(13 * GiB),
      listOldest,
      removeAfterUnlink: remove,
      reconcileMissing: vi.fn(),
      unlink,
      writeInProgress: new Set(),
      log: vi.fn(),
    });

    await expect(evict.cleanup()).resolves.toEqual({ status: 'under-low-water', totalBytes: 9 * GiB });
    expect(listOldest).toHaveBeenCalledOnce();
    expect(listOldest).toHaveBeenCalledWith(64);
    expect(unlink).toHaveBeenCalledTimes(2);
    expect(unlink).toHaveBeenNthCalledWith(1, path.join(cacheDirectory, 'first.png'));
    expect(unlink).toHaveBeenNthCalledWith(2, path.join(cacheDirectory, 'second.png'));
    expect(remove).toHaveBeenNthCalledWith(1, 'first.png', true);
    expect(remove).toHaveBeenNthCalledWith(2, 'second.png', true);
  });

  it('reconciles a stale ENOENT row once before considering the next prefetched candidate', async () => {
    const unlink = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }))
      .mockResolvedValueOnce(undefined);
    const reconcileMissing = vi.fn().mockReturnValue(11 * GiB);
    const remove = vi.fn().mockReturnValue(9 * GiB);
    const evict = createImageCacheEvictor({
      cacheDirectory: '/cache',
      getTotalBytes: vi.fn().mockReturnValue(13 * GiB),
      listOldest: vi.fn().mockReturnValue([
        { basename: 'stale.png', size: GiB, lastAccess: 10 },
        { basename: 'next.png', size: GiB, lastAccess: 20 },
      ]),
      removeAfterUnlink: remove,
      reconcileMissing,
      unlink,
      writeInProgress: new Set(),
      log: vi.fn(),
    });

    await expect(evict.cleanup()).resolves.toEqual({ status: 'under-low-water', totalBytes: 9 * GiB });
    expect(unlink).toHaveBeenCalledTimes(2);
    expect(reconcileMissing).toHaveBeenCalledOnce();
    expect(reconcileMissing).toHaveBeenCalledWith('stale.png');
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('next.png', true);
  });

  it('does not query candidates below high-water and skips only exact active publish paths', async () => {
    const listOldest = vi.fn();
    const unlink = vi.fn().mockResolvedValue(undefined);
    const activeFinalPath = path.join('/cache', 'active.png');
    const evict = createImageCacheEvictor({
      cacheDirectory: '/cache',
      getTotalBytes: vi.fn()
        .mockReturnValueOnce(12 * GiB)
        .mockReturnValueOnce(13 * GiB),
      listOldest: listOldest.mockReturnValue([
        { basename: 'active.png', size: GiB, lastAccess: 10 },
        { basename: 'near-active.png', size: GiB, lastAccess: 20 },
      ]),
      removeAfterUnlink: vi.fn().mockReturnValue(9 * GiB),
      reconcileMissing: vi.fn(),
      unlink,
      writeInProgress: new Set([activeFinalPath]),
      log: vi.fn(),
    });

    await expect(evict.cleanup()).resolves.toEqual({ status: 'below-high-water', totalBytes: 12 * GiB });
    expect(listOldest).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();

    await expect(evict.cleanup()).resolves.toEqual({ status: 'under-low-water', totalBytes: 9 * GiB });
    expect(unlink).toHaveBeenCalledOnce();
    expect(unlink).toHaveBeenCalledWith(path.join('/cache', 'near-active.png'));
  });

  it('stops destructive work when durable metadata mutation totals are unavailable', async () => {
    const unlink = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockReturnValue(undefined);
    const evict = createImageCacheEvictor({
      cacheDirectory: '/cache',
      getTotalBytes: vi.fn().mockReturnValue(13 * GiB),
      listOldest: vi.fn().mockReturnValue([
        { basename: 'first.png', size: GiB, lastAccess: 10 },
        { basename: 'second.png', size: GiB, lastAccess: 20 },
      ]),
      removeAfterUnlink: remove,
      reconcileMissing: vi.fn(),
      unlink,
      writeInProgress: new Set(),
      log: vi.fn(),
    });

    await expect(evict.cleanup()).resolves.toEqual({ status: 'metadata-failure', totalBytes: undefined });
    expect(unlink).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('enforces the 64-candidate bound without retrying an EBUSY candidate in the same pass', async () => {
    const candidates = Array.from({ length: 65 }, (_, index) => ({
      basename: `candidate-${index}.png`,
      size: 1,
      lastAccess: index,
    }));
    const unlink = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
      .mockResolvedValue(undefined);
    const listOldest = vi.fn().mockReturnValue(candidates);
    const evict = createImageCacheEvictor({
      cacheDirectory: '/cache',
      getTotalBytes: vi.fn().mockReturnValue(13 * GiB),
      listOldest,
      removeAfterUnlink: vi.fn().mockReturnValue(11 * GiB),
      reconcileMissing: vi.fn(),
      unlink,
      writeInProgress: new Set(),
      log: vi.fn(),
    });

    await expect(evict.cleanup()).resolves.toEqual({ status: 'batch-exhausted', totalBytes: 11 * GiB });
    expect(listOldest).toHaveBeenCalledOnce();
    expect(unlink).toHaveBeenCalledTimes(64);
    expect(unlink).toHaveBeenCalledWith(path.join('/cache', 'candidate-0.png'));
    expect(unlink).not.toHaveBeenCalledWith(path.join('/cache', 'candidate-64.png'));
  });

  it('coalesces overlapping cleanup calls into one bounded metadata pass', async () => {
    let resolveTotal: ((total: number) => void) | undefined;
    const pendingTotal = new Promise<number>(resolve => { resolveTotal = resolve; });
    const getTotalBytes = vi.fn().mockReturnValue(pendingTotal);
    const evict = createImageCacheEvictor({
      cacheDirectory: '/cache',
      getTotalBytes,
      listOldest: vi.fn(),
      removeAfterUnlink: vi.fn(),
      reconcileMissing: vi.fn(),
      unlink: vi.fn(),
      writeInProgress: new Set(),
      log: vi.fn(),
    });

    const first = evict.cleanup();
    const second = evict.cleanup();
    resolveTotal?.(12 * GiB);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'below-high-water', totalBytes: 12 * GiB },
      { status: 'below-high-water', totalBytes: 12 * GiB },
    ]);
    expect(getTotalBytes).toHaveBeenCalledOnce();
  });
});
