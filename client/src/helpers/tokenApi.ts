import { API_BASE } from "../constants";
import { withRetry, API_RETRY_CONFIG, isRetryableError } from "./retryUtils";

type TokenPart = {
    id?: string;
    name: string;
    type_line?: string;
    uri?: string;
};

type TokenResponseItem = {
    name: string;
    set?: string;
    number?: string;
    token_parts?: TokenPart[];
};

// Matches the server-side import request limit for /api/cards/images/tokens.
const tokenRequestCardLimit = 100;

function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Result type for token fetching - distinguishes between success, empty result, and error.
 */
export type TokenFetchResult =
    | { success: true; data: TokenResponseItem[] }
    | { success: false; error: Error };

/**
 * Fetch token_parts data for a list of cards.
 * Uses retry logic for transient failures.
 * 
 * @returns TokenFetchResult - Explicitly indicates success/failure rather than silent empty array
 */
export async function fetchTokenParts(
    cards: { name: string; set?: string; number?: string }[],
    signal?: AbortSignal
): Promise<TokenFetchResult> {
    if (cards.length === 0) {
        return { success: true, data: [] };
    }

    try {
        const data: TokenResponseItem[] = [];
        for (let start = 0; start < cards.length; start += tokenRequestCardLimit) {
            throwIfAborted(signal);
            const chunk = cards.slice(start, start + tokenRequestCardLimit);
            const chunkData = await withRetry(
                async () => {
                    const response = await fetch(`${API_BASE}/api/cards/images/tokens`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ cards: chunk }),
                        signal,
                    });

                    if (!response.ok) {
                        throw new Error(`Token fetch failed: ${response.status}`);
                    }

                    return await response.json() as TokenResponseItem[];
                },
                API_RETRY_CONFIG,
                (error) => {
                    // Don't retry aborts or 4xx client errors
                    if (error instanceof Error && error.name === 'AbortError') return false;
                    if (error instanceof Error && error.message.includes('4')) {
                        const status = parseInt(error.message.match(/\d{3}/)?.[0] || '0');
                        if (status >= 400 && status < 500 && status !== 429) return false;
                    }
                    return isRetryableError(error);
                }
            );
            data.push(...chunkData);
        }

        return { success: true, data };
    } catch (e) {
        // Propagate AbortError without wrapping
        if (e instanceof Error && e.name === 'AbortError') {
            throw e;
        }
        return {
            success: false,
            error: e instanceof Error ? e : new Error(String(e))
        };
    }
}
