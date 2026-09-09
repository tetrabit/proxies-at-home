import { API_BASE } from "../constants";
import { getMpcImageUrl } from "./mpc";
import { debugLog } from "./debug";
import { parseMpcCardName } from "./mpcUtils";

/**
 * MPC Autofill card data from the community database
 */
export interface MpcAutofillCard {
    identifier: string;
    name: string;
    rawName: string;       // Original name from API before parseMpcCardName (preserves [SET] {CN})
    smallThumbnailUrl: string;
    mediumThumbnailUrl: string;
    dpi: number;
    tags: string[];
    sourceName: string;
    source: string;
    extension: string;
    size: number;
}

interface MpcSearchResponse {
    cards: MpcAutofillCard[];
    error?: string;
}

interface MpcBatchSearchResponse {
    results: Record<string, MpcAutofillCard[]>;
    error?: string;
}

export interface MpcSearchOptions {
    /** Include every MPCFill language and current source in the result pool. */
    includeAllLanguages?: boolean;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    }
}

function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === "AbortError";
}

interface InFlightMpcSearch {
    promise: Promise<MpcAutofillCard[]>;
    activeSubscribers: Set<symbol>;
    controller: AbortController;
}

const inFlightMpcSearches = new Map<string, InFlightMpcSearch>();

function removeInFlightMpcSearch(requestKey: string, inFlight: InFlightMpcSearch): void {
    // An earlier transport must never delete a replacement retry entry.
    if (inFlightMpcSearches.get(requestKey) === inFlight) {
        inFlightMpcSearches.delete(requestKey);
    }
}

function getMpcSearchKeys(
    query: string,
    cardType: "CARD" | "CARDBACK" | "TOKEN",
    fuzzySearch: boolean,
    options: MpcSearchOptions
): { cacheKey: string; requestKey: string } {
    const normalizedQuery = query.trim().toLowerCase();
    const includeAllLanguages = Boolean(options.includeAllLanguages);
    const cacheKey = `${normalizedQuery}:${fuzzySearch ? 'fuzzy' : 'exact'}${
        includeAllLanguages ? ':all-languages' : ''
    }`;

    // The transport key deliberately includes every value that can alter the MPC response.
    const requestKey = JSON.stringify({
        url: `${API_BASE}/api/mpcfill/search`,
        query: normalizedQuery,
        cardType,
        fuzzySearch,
        includeAllLanguages,
    });

    return { cacheKey, requestKey };
}

function subscribeToMpcSearch(
    requestKey: string,
    inFlight: InFlightMpcSearch,
    signal?: AbortSignal
): Promise<MpcAutofillCard[]> {
    throwIfAborted(signal);

    const subscriber = Symbol("mpc-search-subscriber");
    inFlight.activeSubscribers.add(subscriber);

    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            inFlight.activeSubscribers.delete(subscriber);
            signal?.removeEventListener("abort", onAbort);
            if (inFlight.activeSubscribers.size === 0 && !inFlight.controller.signal.aborted) {
                inFlight.controller.abort(new DOMException("All subscribers aborted", "AbortError"));
                removeInFlightMpcSearch(requestKey, inFlight);
            }
        };
        const settle = (callback: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback();
        };
        const onAbort = () => settle(() => reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError")));

        signal?.addEventListener("abort", onAbort, { once: true });
        inFlight.promise.then(
            (cards) => settle(() => resolve(cards)),
            (err) => settle(() => reject(err))
        );
    });
}

async function performMpcSearch(
    query: string,
    cardType: "CARD" | "CARDBACK" | "TOKEN",
    fuzzySearch: boolean,
    options: MpcSearchOptions,
    cacheKey: string,
    activeSubscribers: Set<symbol>,
    transportSignal: AbortSignal
): Promise<MpcAutofillCard[]> {
    const { cacheMpcSearch } = await import('./mpcSearchCache');

    try {
        throwIfAborted(transportSignal);
        const response = await fetch(`${API_BASE}/api/mpcfill/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: query.trim(),
                cardType,
                fuzzySearch,
                ...(options.includeAllLanguages
                    ? { includeAllLanguages: true }
                    : {}),
            }),
            signal: transportSignal,
        });

        throwIfAborted(transportSignal);
        if (!response.ok) {
            console.error("[MPC Autofill] Search failed:", response.status);
            return [];
        }

        const data: MpcSearchResponse = await response.json();
        throwIfAborted(transportSignal);
        // Parse card names to extract base names (strips { } and ( ) suffixes)
        const cards = (data.cards || []).map((card) => ({
            ...card,
            rawName: card.name,
            name: parseMpcCardName(card.name, card.name),
        }));

        // Do not populate the cache when every subscriber abandoned this request.
        if (cards.length > 0 && activeSubscribers.size > 0) {
            await cacheMpcSearch(cacheKey, cardType, cards);
            throwIfAborted(transportSignal);
        }

        return cards;
    } catch (err) {
        if (transportSignal.aborted) {
            throwIfAborted(transportSignal);
        }
        if (isAbortError(err)) {
            throw err;
        }
        console.error("[MPC Autofill] Search error:", err);
        return [];
    }
}

/**
 * Search MPC Autofill for custom card art
 * @param query Card name to search for
 * @param cardType Type of card to search (default: CARD)
 * @param fuzzySearch Enable fuzzy/approximate name matching (default: true)
 * @returns Array of matching MPC cards
 */
export async function searchMpcAutofill(
    query: string,
    cardType: "CARD" | "CARDBACK" | "TOKEN" = "CARD",
    fuzzySearch: boolean = true,
    options: MpcSearchOptions = {},
    signal?: AbortSignal
): Promise<MpcAutofillCard[]> {
    if (!query.trim()) {
        return [];
    }
    throwIfAborted(signal);

    const { getCachedMpcSearch } = await import('./mpcSearchCache');
    const { cacheKey, requestKey } = getMpcSearchKeys(query, cardType, fuzzySearch, options);
    const cached = await getCachedMpcSearch(cacheKey, cardType);
    throwIfAborted(signal);
    if (cached) {
        return cached;
    }

    let inFlight = inFlightMpcSearches.get(requestKey);
    if (!inFlight) {
        const controller = new AbortController();
        const activeSubscribers = new Set<symbol>();
        const entry: InFlightMpcSearch = {
            promise: Promise.resolve([]),
            activeSubscribers,
            controller,
        };
        entry.promise = performMpcSearch(
            query,
            cardType,
            fuzzySearch,
            options,
            cacheKey,
            activeSubscribers,
            controller.signal
        );
        inFlight = entry;
        inFlightMpcSearches.set(requestKey, entry);
        void entry.promise.finally(() => {
            removeInFlightMpcSearch(requestKey, entry);
        }).catch(() => undefined);
    }

    return subscribeToMpcSearch(requestKey, inFlight, signal);
}

/**
 * Batch search MPC Autofill for multiple cards
 * Uses client cache for each query - only fetches uncached from server
 * @param queries Array of card names to search for
 * @param cardType Type of card to search (default: CARD)
 * @returns Object mapping queries to matching MPC cards
 */
export async function batchSearchMpcAutofill(
    queries: string[],
    cardType: "CARD" | "CARDBACK" | "TOKEN" = "CARD",
    signal?: AbortSignal
): Promise<Record<string, MpcAutofillCard[]>> {
    if (queries.length === 0) {
        return {};
    }

    const { getCachedMpcSearch, cacheMpcSearch } = await import('./mpcSearchCache');
    const results: Record<string, MpcAutofillCard[]> = {};
    const uncachedQueries: string[] = [];

    // Batch search always uses fuzzy=true, so cache key includes :fuzzy suffix
    // Check cache for each query first
    for (const query of queries) {
        const cacheKey = `${query.trim().toLowerCase()}:fuzzy`;
        const cached = await getCachedMpcSearch(cacheKey, cardType);
        if (cached) {
            results[query] = cached;
        } else {
            uncachedQueries.push(query);
        }
    }

    const cacheHits = queries.length - uncachedQueries.length;
    if (cacheHits > 0) {
        debugLog(`[MPC Batch] ${cacheHits} cache hits, ${uncachedQueries.length} misses`);
    }

    if (uncachedQueries.length === 0) {
        return results;
    }

    try {
        const response = await fetch(`${API_BASE}/api/mpcfill/batch-search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ queries: uncachedQueries.map(q => q.trim()), cardType }),
            signal,
        });
        throwIfAborted(signal);

        if (!response.ok) {
            console.error("[MPC Autofill] Batch search failed:", response.status);
            return results;
        }

        const data: MpcBatchSearchResponse = await response.json();
        throwIfAborted(signal);

        // Cache and merge results (batch always uses fuzzy=true)
        // Parse card names to extract base names (strips { } and ( ) suffixes)
        for (const [query, rawCards] of Object.entries(data.results || {})) {
            const parsedCards = rawCards.map((card) => ({
                ...card,
                rawName: card.name,
                name: parseMpcCardName(card.name, card.name),
            }));
            results[query] = parsedCards;
            if (parsedCards.length > 0) {
                const cacheKey = `${query.toLowerCase()}:fuzzy`;
                throwIfAborted(signal);
                await cacheMpcSearch(cacheKey, cardType, parsedCards);
                throwIfAborted(signal);
            }
        }

        return results;
    } catch (err) {
        if (signal?.aborted) {
            throwIfAborted(signal);
        }
        if (isAbortError(err)) {
            throw err;
        }
        console.error("[MPC Autofill] Batch search error:", err);
        return results;
    }
}

/**
 * Get the full-resolution image URL for an MPC card
 * Uses the existing MPC proxy endpoint
 */
export function getMpcAutofillImageUrl(identifier: string, size: "small" | "large" | "full" = "full"): string {
    return getMpcImageUrl(identifier, size) || "";
}

/**
 * Extract MPC identifier from an imageId.
 * Handles both formats:
 * - Full URL: "/api/cards/images/mpc?id=abc123" -> "abc123"
 * - Bare identifier after parseImageIdFromUrl: "abc123" -> "abc123"
 * Returns null if not an MPC image.
 */
export function extractMpcIdentifierFromImageId(imageId?: string): string | null {
    if (!imageId) return null;

    // If it contains the full MPC URL path, extract from that
    if (imageId.includes('/api/cards/images/mpc?id=')) {
        const match = imageId.match(/id=([^&]+)/);
        return match ? match[1] : null;
    }

    // Exclude known internal prefixes
    if (imageId.startsWith('cardback_') || imageId.startsWith('scryfall_') || imageId.startsWith('local_')) {
        return null;
    }

    // Exclude SHA-256 hashes used for custom uploaded images
    // Can be: 64 hex chars alone, OR with suffix like "-mpc", "-std"
    if (/^[a-f0-9]{64}(-[a-z]+)?$/i.test(imageId)) {
        return null;
    }

    // If imageId is a bare identifier (alphanumeric, typical MPC format)
    // Relaxed check: at least 15 chars (Google Drive IDs are 33, hashes 32)
    // Reverting to 15 to avoid very short collisions, but keeping it flexible.
    if (/^[a-zA-Z0-9_-]{15,}$/.test(imageId)) {
        return imageId;
    }

    // Not an MPC image (e.g., Scryfall URL)
    return null;
}
