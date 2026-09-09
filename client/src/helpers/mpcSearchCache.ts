import { db, type MpcSearchCacheEntry } from '../db';
import type { MpcAutofillCard } from './mpcAutofillApi';
import { parseMpcCardName } from './mpcUtils';

/**
 * Client-side MPC search cache with hybrid TTL + LRU eviction.
 * Persists across sessions, cleared on reset app data.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (aligned with server)
const MAX_ENTRIES = 1000;

/**
 * Get cached MPC search results if fresh (< 24 hours old).
 * Returns null if not cached or expired.
 */
export async function getCachedMpcSearch(
    query: string,
    cardType: 'CARD' | 'CARDBACK' | 'TOKEN'
): Promise<MpcAutofillCard[] | null> {
    try {
        const normalizedQuery = query.toLowerCase().trim();
        const now = Date.now();
        const expiryTime = now - CACHE_TTL_MS;

        const entry = await db.mpcSearchCache.get([normalizedQuery, cardType]);

        if (!entry) {
            return null;
        }

        // Check if expired
        if (entry.cachedAt < expiryTime) {
            // Delete expired entry
            await db.mpcSearchCache.delete([normalizedQuery, cardType]);
            return null;
        }

        // Update cachedAt for LRU (touch on access)
        await db.mpcSearchCache.update([normalizedQuery, cardType], { cachedAt: now });

        // Parse card names in case of stale cache entries with unparsed names
        // Ensure rawName is preserved (or set from name for pre-rawName cache entries)
        const cards = (entry.cards as MpcAutofillCard[]).map((card) => ({
            ...card,
            rawName: card.rawName || card.name,
            name: parseMpcCardName(card.name, card.name),
        }));
        return cards;
    } catch (error) {
        console.warn('[MPC Client Cache] Failed to get cached search:', error);
        return null;
    }
}

/**
 * Bulk-read cached MPC search results using one IndexedDB request.
 * Returned keys are normalized query strings, so callers can map their original
 * request strings back to cache hits without repeated database reads.
 */
export async function getCachedMpcSearchBulk(
    queries: string[],
    cardType: 'CARD' | 'CARDBACK' | 'TOKEN'
): Promise<Map<string, MpcAutofillCard[]>> {
    const normalizedQueries = new Map<string, [string, 'CARD' | 'CARDBACK' | 'TOKEN']>();
    for (const query of queries) {
        const normalizedQuery = query.toLowerCase().trim();
        normalizedQueries.set(normalizedQuery, [normalizedQuery, cardType]);
    }

    if (normalizedQueries.size === 0) {
        return new Map();
    }

    try {
        const entries = await db.mpcSearchCache.bulkGet([...normalizedQueries.values()]);
        const now = Date.now();
        const expiryTime = now - CACHE_TTL_MS;
        const results = new Map<string, MpcAutofillCard[]>();

        for (const [index, normalizedQuery] of [...normalizedQueries.keys()].entries()) {
            try {
                const entry = entries[index];
                if (!entry) {
                    continue;
                }

                if (entry.cachedAt < expiryTime) {
                    await db.mpcSearchCache.delete([normalizedQuery, cardType]);
                    continue;
                }

                await db.mpcSearchCache.update([normalizedQuery, cardType], { cachedAt: now });
                results.set(
                    normalizedQuery,
                    (entry.cards as MpcAutofillCard[]).map((card) => ({
                        ...card,
                        rawName: card.rawName || card.name,
                        name: parseMpcCardName(card.name, card.name),
                    }))
                );
            } catch (error) {
                console.warn('[MPC Client Cache] Failed to get cached search:', error);
            }
        }

        return results;
    } catch (error) {
        console.warn('[MPC Client Cache] Failed to get cached search:', error);
        return new Map();
    }
}

/**
 * Store MPC search results in cache.
 * Automatically trims oldest entries if over limit.
 */
export async function cacheMpcSearch(
    query: string,
    cardType: 'CARD' | 'CARDBACK' | 'TOKEN',
    cards: MpcAutofillCard[]
): Promise<void> {
    try {
        const normalizedQuery = query.toLowerCase().trim();
        const now = Date.now();

        const entry: MpcSearchCacheEntry = {
            query: normalizedQuery,
            cardType,
            cards,
            cachedAt: now,
        };

        await db.mpcSearchCache.put(entry);

        // Trim cache if over limit (async, non-blocking)
        trimMpcCacheIfNeeded().catch(e =>
            console.warn('[MPC Client Cache] Trim failed:', e)
        );
    } catch (error) {
        console.warn('[MPC Client Cache] Failed to cache search:', error);
    }
}

export interface MpcSearchCacheWrite {
    query: string;
    cardType: 'CARD' | 'CARDBACK' | 'TOKEN';
    cards: MpcAutofillCard[];
}

function isValidMpcCacheCard(card: unknown): card is MpcAutofillCard {
    if (card === null || typeof card !== 'object') {
        return false;
    }

    const candidate = card as Partial<MpcAutofillCard>;
    return typeof candidate.identifier === 'string' && candidate.identifier.length > 0 &&
        typeof candidate.name === 'string' &&
        typeof candidate.smallThumbnailUrl === 'string' &&
        typeof candidate.mediumThumbnailUrl === 'string' &&
        typeof candidate.dpi === 'number' && Number.isFinite(candidate.dpi) &&
        Array.isArray(candidate.tags) && candidate.tags.every(tag => typeof tag === 'string') &&
        typeof candidate.sourceName === 'string' &&
        typeof candidate.source === 'string' &&
        typeof candidate.extension === 'string' &&
        typeof candidate.size === 'number' && Number.isFinite(candidate.size);
}

function normalizeMpcSearchCacheWrites(entries: readonly MpcSearchCacheWrite[]): MpcSearchCacheEntry[] {
    const normalizedEntries = new Map<string, MpcSearchCacheEntry>();
    const now = Date.now();

    for (const entry of entries) {
        if (!entry || typeof entry.query !== 'string' || !Array.isArray(entry.cards)) {
            throw new Error('Invalid MPC cache entry');
        }

        const query = entry.query.toLowerCase().trim();
        if (!query || !['CARD', 'CARDBACK', 'TOKEN'].includes(entry.cardType)) {
            throw new Error('Invalid MPC cache entry');
        }

        if (!entry.cards.every(isValidMpcCacheCard)) {
            throw new Error('Invalid MPC cache cards');
        }

        normalizedEntries.set(`${query}\u0000${entry.cardType}`, {
            query,
            cardType: entry.cardType,
            cards: entry.cards,
            cachedAt: now,
        });
    }

    return [...normalizedEntries.values()];
}

/**
 * Store a batch of MPC search results atomically.
 * Entries are normalized and validated before the transaction begins so an
 * invalid response cannot leave earlier batch entries persisted on its own.
 */
export async function cacheMpcSearchBulk(entries: readonly MpcSearchCacheWrite[]): Promise<void> {
    try {
        const normalizedEntries = normalizeMpcSearchCacheWrites(entries);
        if (normalizedEntries.length === 0) {
            return;
        }

        await db.transaction('rw', db.mpcSearchCache, async () => {
            await db.mpcSearchCache.bulkPut(normalizedEntries);
        });

        // Keep the existing LRU policy without extending the write transaction.
        trimMpcCacheIfNeeded().catch(e =>
            console.warn('[MPC Client Cache] Trim failed:', e)
        );
    } catch (error) {
        console.warn('[MPC Client Cache] Failed to cache searches:', error);
    }
}

/**
 * Trim cache if over MAX_ENTRIES.
 * Deletes oldest entries first (LRU eviction).
 */
async function trimMpcCacheIfNeeded(): Promise<void> {
    const count = await db.mpcSearchCache.count();

    if (count > MAX_ENTRIES) {
        const toDelete = count - MAX_ENTRIES;

        // Get oldest entries by cachedAt
        const oldestEntries = await db.mpcSearchCache
            .orderBy('cachedAt')
            .limit(toDelete)
            .toArray();

        // Delete them
        const keysToDelete = oldestEntries.map(e => [e.query, e.cardType] as [string, string]);
        await db.mpcSearchCache.bulkDelete(keysToDelete);
    }
}

/**
 * Clear all MPC search cache entries.
 * Called during reset app data.
 */
export async function clearMpcSearchCache(): Promise<void> {
    try {
        await db.mpcSearchCache.clear();
    } catch (error) {
        console.warn('[MPC Client Cache] Failed to clear:', error);
    }
}

/**
 * Get cache statistics for debugging.
 */
export async function getMpcCacheStats(): Promise<{ count: number; oldestTimestamp: number | null }> {
    try {
        const count = await db.mpcSearchCache.count();
        const oldest = await db.mpcSearchCache.orderBy('cachedAt').first();
        return {
            count,
            oldestTimestamp: oldest?.cachedAt ?? null,
        };
    } catch {
        return { count: 0, oldestTimestamp: null };
    }
}
