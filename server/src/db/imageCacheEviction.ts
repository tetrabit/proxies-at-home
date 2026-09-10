import path from 'node:path';

import type { ImageCacheEvictionCandidate } from './imageCacheMetadata.js';

const DEFAULT_HIGH_WATER_BYTES = 12 * 1024 * 1024 * 1024;
const DEFAULT_LOW_WATER_BYTES = 10 * 1024 * 1024 * 1024;
export const IMAGE_CACHE_EVICTION_BATCH_SIZE = 64;

type MaybePromise<T> = T | Promise<T>;

export type ImageCacheEvictionStatus =
  | 'below-high-water'
  | 'under-low-water'
  | 'batch-exhausted'
  | 'metadata-failure';

export interface ImageCacheEvictionResult {
  status: ImageCacheEvictionStatus;
  totalBytes: number | undefined;
}

export interface ImageCacheEvictorDependencies {
  cacheDirectory: string;
  getTotalBytes: () => MaybePromise<number | undefined>;
  listOldest: (limit: number) => ImageCacheEvictionCandidate[] | undefined;
  removeAfterUnlink: (basename: string, unlinkSucceeded: boolean) => number | undefined;
  reconcileMissing: (basename: string) => number | undefined;
  unlink: (filePath: string) => Promise<void>;
  writeInProgress: ReadonlySet<string>;
  log: (message: string, error?: unknown) => void;
  highWaterBytes?: number;
  lowWaterBytes?: number;
}

export interface ImageCacheEvictor {
  cleanup(): Promise<ImageCacheEvictionResult>;
}

function isFinalCacheBasename(basename: string): boolean {
  return basename.length > 0
    && basename === path.basename(basename)
    && !basename.endsWith('.tmp');
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

/**
 * Creates a request-safe bounded eviction primitive. It reads one metadata
 * batch, never scans the cache directory, and trusts only transactionally
 * reconciled totals after metadata mutations.
 */
export function createImageCacheEvictor(dependencies: ImageCacheEvictorDependencies): ImageCacheEvictor {
  const highWaterBytes = dependencies.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES;
  const lowWaterBytes = dependencies.lowWaterBytes ?? DEFAULT_LOW_WATER_BYTES;
  let cleanupInFlight: Promise<ImageCacheEvictionResult> | undefined;

  async function cleanupOnce(): Promise<ImageCacheEvictionResult> {
    let totalBytes: number | undefined;
    try {
      totalBytes = await dependencies.getTotalBytes();
    } catch (error) {
      dependencies.log('[Image cache eviction] aggregate read failed', error);
      return { status: 'metadata-failure', totalBytes: undefined };
    }

    if (totalBytes === undefined) {
      dependencies.log('[Image cache eviction] aggregate is unavailable');
      return { status: 'metadata-failure', totalBytes };
    }
    if (totalBytes <= highWaterBytes) return { status: 'below-high-water', totalBytes };

    let candidates: ImageCacheEvictionCandidate[] | undefined;
    try {
      candidates = dependencies.listOldest(IMAGE_CACHE_EVICTION_BATCH_SIZE);
    } catch (error) {
      dependencies.log('[Image cache eviction] oldest batch read failed', error);
      return { status: 'metadata-failure', totalBytes };
    }
    if (candidates === undefined) {
      dependencies.log('[Image cache eviction] oldest batch is unavailable');
      return { status: 'metadata-failure', totalBytes };
    }

    for (const candidate of candidates.slice(0, IMAGE_CACHE_EVICTION_BATCH_SIZE)) {
      if (!isFinalCacheBasename(candidate.basename)) {
        dependencies.log('[Image cache eviction] ignored invalid metadata basename');
        continue;
      }

      const filePath = path.join(dependencies.cacheDirectory, candidate.basename);
      if (dependencies.writeInProgress.has(filePath)) continue;

      try {
        await dependencies.unlink(filePath);
      } catch (error) {
        if (!isEnoent(error)) {
          dependencies.log(`[Image cache eviction] unlink failed for ${candidate.basename}`, error);
          continue;
        }

        try {
          totalBytes = dependencies.reconcileMissing(candidate.basename);
        } catch (reconciliationError) {
          dependencies.log(`[Image cache eviction] stale metadata reconciliation failed for ${candidate.basename}`, reconciliationError);
          return { status: 'metadata-failure', totalBytes: undefined };
        }
        if (totalBytes === undefined) {
          dependencies.log(`[Image cache eviction] stale metadata reconciliation is unavailable for ${candidate.basename}`);
          return { status: 'metadata-failure', totalBytes };
        }
        if (totalBytes <= lowWaterBytes) return { status: 'under-low-water', totalBytes };
        continue;
      }

      try {
        totalBytes = dependencies.removeAfterUnlink(candidate.basename, true);
      } catch (error) {
        dependencies.log(`[Image cache eviction] unlink metadata recording failed for ${candidate.basename}`, error);
        return { status: 'metadata-failure', totalBytes: undefined };
      }
      if (totalBytes === undefined) {
        dependencies.log(`[Image cache eviction] unlink metadata recording is unavailable for ${candidate.basename}`);
        return { status: 'metadata-failure', totalBytes };
      }
      if (totalBytes <= lowWaterBytes) return { status: 'under-low-water', totalBytes };
    }

    return { status: 'batch-exhausted', totalBytes };
  }

  return {
    cleanup(): Promise<ImageCacheEvictionResult> {
      if (cleanupInFlight !== undefined) return cleanupInFlight;

      cleanupInFlight = cleanupOnce().catch(error => {
        dependencies.log('[Image cache eviction] unexpected cleanup failure', error);
        return { status: 'metadata-failure', totalBytes: undefined };
      });
      void cleanupInFlight.finally(() => {
        cleanupInFlight = undefined;
      });
      return cleanupInFlight;
    },
  };
}
