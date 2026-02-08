import { Router, type Request, type Response } from "express";
import axios from "axios";
import crypto from "crypto";
import { getDatabase } from "../db/db.js";
import { debugLog } from "../utils/debug.js";
import { isValidScryfallType, isKnownToken } from "../utils/scryfallCatalog.js";
import { getCardsWithImagesForCardInfo } from "../utils/getCardImagesPaged.js";
import { getScryfallClient, isMicroserviceAvailable } from "../services/scryfallMicroserviceClient.js";

const router = Router();

// Scryfall API base
const SCRYFALL_API = "https://api.scryfall.com";

// Axios instance with required headers
const scryfallAxios = axios.create({
    baseURL: SCRYFALL_API,
    headers: {
        "User-Agent": "Proxxied/1.0 (https://github.com/kclipsto/proxies-at-home)",
        "Accept": "application/json",
    },
});

// Rate limiting: 100ms between requests (Scryfall recommends 50-100ms)
let lastRequestTime = 0;
const REQUEST_DELAY_MS = 100;

async function rateLimitedRequest<T>(
    requestFn: () => Promise<{ data: T }>
): Promise<T> {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < REQUEST_DELAY_MS) {
        await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS - elapsed));
    }
    lastRequestTime = Date.now();
    const response = await requestFn();
    return response.data;
}

// Cache TTLs in milliseconds
const CACHE_TTL = {
    autocomplete: 7 * 24 * 60 * 60 * 1000, // 7 days
    named: 24 * 60 * 60 * 1000,            // 24 hours
    search: 24 * 60 * 60 * 1000,           // 24 hours
    card: 7 * 24 * 60 * 60 * 1000,         // 7 days
};

// Generate cache key from endpoint and params
function getCacheKey(endpoint: string, params: Record<string, string>): string {
    const sortedParams = Object.keys(params)
        .sort()
        .map((k) => `${k}=${params[k]}`)
        .join("&");
    const hash = crypto.createHash("sha256").update(`${endpoint}:${sortedParams}`).digest("hex");
    return hash;
}

// Check cache for existing response
function getFromCache(endpoint: string, queryHash: string): unknown | null {
    try {
        const db = getDatabase();
        const row = db
            .prepare(
                "SELECT response, expires_at FROM scryfall_cache WHERE endpoint = ? AND query_hash = ?"
            )
            .get(endpoint, queryHash) as { response: string; expires_at: number } | undefined;

        if (row && row.expires_at > Date.now()) {
            debugLog(`[ScryfallProxy] Cache HIT for ${endpoint}:${queryHash.slice(0, 8)}`);
            return JSON.parse(row.response);
        }
        return null;
    } catch {
        return null;
    }
}

// Store response in cache
function storeInCache(
    endpoint: string,
    queryHash: string,
    response: unknown,
    ttlMs: number
): void {
    try {
        const db = getDatabase();
        const now = Date.now();
        db.prepare(
            `INSERT OR REPLACE INTO scryfall_cache (endpoint, query_hash, response, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
        ).run(endpoint, queryHash, JSON.stringify(response), now, now + ttlMs);
    } catch (err) {
        debugLog(`[ScryfallProxy] Cache store error:`, err);
    }
}

/**
 * GET /api/scryfall/autocomplete
 * Proxies Scryfall /cards/autocomplete
 */
router.get("/autocomplete", async (req: Request, res: Response) => {
    const q = req.query.q as string;
    if (!q || q.length < 2) {
        return res.json({ object: "catalog", data: [] });
    }

    const params = { q };
    const queryHash = getCacheKey("autocomplete", params);
    const cached = getFromCache("autocomplete", queryHash);
    if (cached) {
        return res.json(cached);
    }

    try {
        const data = await rateLimitedRequest(() =>
            scryfallAxios.get("/cards/autocomplete", { params })
        );
        storeInCache("autocomplete", queryHash, data, CACHE_TTL.autocomplete);
        return res.json(data);
    } catch (err) {
        if (axios.isAxiosError(err) && err.response) {
            return res.status(err.response.status).json(err.response.data);
        }
        return res.status(500).json({ error: "Failed to fetch autocomplete" });
    }
});

/**
 * GET /api/scryfall/named
 * Get card by name using microservice (with fallback to direct Scryfall API)
 * Supports format=image for direct image redirects
 */
router.get("/named", async (req: Request, res: Response) => {
    const exact = req.query.exact as string | undefined;
    const fuzzy = req.query.fuzzy as string | undefined;
    const set = req.query.set as string | undefined;
    const format = req.query.format as string | undefined;
    const version = req.query.version as string | undefined;

    if (!exact && !fuzzy) {
        return res.status(400).json({ error: "Missing exact or fuzzy parameter" });
    }

    const params: Record<string, string> = {};
    if (exact) params.exact = exact;
    if (fuzzy) params.fuzzy = fuzzy;
    if (set) params.set = set;
    if (format) params.format = format;
    if (version) params.version = version;

    // For image format requests, redirect to Scryfall directly (CDN has no rate limits)
    if (format === "image") {
        const queryString = new URLSearchParams(params).toString();
        return res.redirect(`https://api.scryfall.com/cards/named?${queryString}`);
    }

    const queryHash = getCacheKey("named", params);
    const cached = getFromCache("named", queryHash);
    if (cached) {
        return res.json(cached);
    }

    try {
        // Try microservice first (it doesn't support set/version params yet, so fallback if needed)
        if (!set && !version && await isMicroserviceAvailable()) {
            debugLog(`[ScryfallProxy] Using microservice for named: ${exact || fuzzy}`);
            const client = getScryfallClient();
            const response = await client.getCardByName({ exact, fuzzy });
            
            if (response.success && response.data) {
                storeInCache("named", queryHash, response.data, CACHE_TTL.named);
                return res.json(response.data);
            }
        }
        
        // Fallback to direct Scryfall API (for set/version params or if microservice unavailable)
        debugLog(`[ScryfallProxy] Using direct Scryfall API for named query`);
        const data = await rateLimitedRequest(() =>
            scryfallAxios.get("/cards/named", { params })
        );
        storeInCache("named", queryHash, data, CACHE_TTL.named);
        return res.json(data);
    } catch (err) {
        if (axios.isAxiosError(err) && err.response) {
            return res.status(err.response.status).json(err.response.data);
        }
        return res.status(500).json({ error: "Failed to fetch card" });
    }
});

/**
 * Parse query for token-specific syntax.
 * Detects if t:<value> should be passed through (valid Scryfall type) or
 * translated to a token search (unknown type or known token name).
 * 
 * Supports multi-word token names via:
 * - Quotes: t:"human soldier" or t:'human soldier'
 * - Underscores: t:human_soldier
 * - Full phrase check: t:human soldier (if "human soldier" is a known token)
 */
function parseTypePrefix(query: string): { query: string; isToken: boolean } {
    // Check for t: prefix with various formats

    // Format 1: t:"quoted name" or t:'quoted name'
    const quotedMatch = query.match(/^t:["']([^"']+)["'](.*)$/i);
    if (quotedMatch) {
        const tokenName = quotedMatch[1].trim();
        const rest = quotedMatch[2]?.trim() || '';
        // Quoted = explicit token search
        return { query: rest ? `${tokenName} ${rest}` : tokenName, isToken: true };
    }

    // Format 2: t:underscore_name (convert underscores to spaces)
    const underscoreMatch = query.match(/^t:([a-z0-9]+(?:_[a-z0-9]+)+)(.*)$/i);
    if (underscoreMatch) {
        const tokenName = underscoreMatch[1].replace(/_/g, ' ').trim();
        const rest = underscoreMatch[2]?.trim() || '';
        // Underscore format = explicit token search
        return { query: rest ? `${tokenName} ${rest}` : tokenName, isToken: true };
    }

    // Format 3: t:word or t:word word... (standard format)
    const tPrefixMatch = query.match(/^t:(.+)$/i);
    if (tPrefixMatch) {
        const fullValue = tPrefixMatch[1].trim();

        // Check for explicit "t:token <name>" syntax - definitely a token search
        if (fullValue.toLowerCase().startsWith('token ')) {
            const tokenName = fullValue.slice(6).trim();
            return { query: tokenName, isToken: true };
        }

        // Check first word only
        const firstWord = fullValue.split(/\s+/)[0].toLowerCase();
        const restOfQuery = fullValue.slice(firstWord.length).trim();

        // Priority 1: If first word is a valid Scryfall type, pass through as type filter
        if (isValidScryfallType(firstWord)) {
            // Ambiguous case: check if full phrase is also a known token
            if (restOfQuery && isKnownToken(fullValue)) {
                // Both a type filter AND a token - use include:extras
                return { query: `${query} include:extras`, isToken: false };
            }
            return { query, isToken: false };
        }

        // Priority 2: Check if the FULL phrase is a known token (e.g., "human soldier", "treasure")
        if (isKnownToken(fullValue)) {
            // Known token - use include:extras to show both tokens and regular cards
            return { query: `${fullValue} include:extras`, isToken: false };
        }

        // Priority 3: If first word is NOT a known token, assume it's a type filter
        // This handles cases like t:legend where "legend" is not in our types catalog
        // but Scryfall understands it as an abbreviation for "legendary"
        if (!isKnownToken(firstWord)) {
            // Pass through to Scryfall - let Scryfall handle type abbreviations
            return { query, isToken: false };
        }

        // Not a valid type and first word IS a known token - treat as token search
        return { query: fullValue, isToken: true };
    }

    // Check if plain query matches a known token name (e.g., "treasure", "blood", "clue")
    // Add include:extras so BOTH tokens AND regular cards are returned
    const trimmed = query.trim();
    if (isKnownToken(trimmed)) {
        return { query: `${trimmed} include:extras`, isToken: false };
    }

    return { query, isToken: false };
}

/**
 * GET /api/scryfall/search
 * Searches for cards using the microservice (with fallback to direct Scryfall API)
 */
router.get("/search", async (req: Request, res: Response) => {
    const q = req.query.q as string;
    if (!q) {
        return res.status(400).json({ error: "Missing q parameter" });
    }

    // Pre-process query to support [set], (set), {set} syntax
    // Converts "cardname [set]" -> "cardname set:set"
    let processedQ = q.replace(/(?:\[|\(|\{)([a-zA-Z0-9]{3,})(?:\]|\)|\})/g, " set:$1 ");

    // Parse for token-specific syntax (t:<name>, t:token <name>, or known token names)
    const { query: parsedQuery, isToken } = parseTypePrefix(processedQ);
    if (isToken) {
        processedQ = `${parsedQuery} type:token`;
        debugLog(`[ScryfallProxy] Token search detected, query: ${processedQ}`);
    } else {
        processedQ = parsedQuery;
    }

    const params: Record<string, string> = { q: processedQ };
    if (req.query.unique) params.unique = req.query.unique as string;
    if (req.query.order) params.order = req.query.order as string;
    if (req.query.dir) params.dir = req.query.dir as string;
    if (req.query.page) params.page = req.query.page as string;
    if (req.query.limit) params.limit = req.query.limit as string;
    if (req.query.page_size) params.page_size = req.query.page_size as string;

    const queryHash = getCacheKey("search", params);
    const cached = getFromCache("search", queryHash);
    if (cached) {
        return res.json(cached);
    }

    try {
        // Try microservice first
        if (await isMicroserviceAvailable()) {
            debugLog(`[ScryfallProxy] Using microservice for search: ${processedQ}`);
            const client = getScryfallClient();
            
            // Build search params for microservice
            const searchParams: Record<string, string> = { q: processedQ };
            if (params.page) searchParams.page = params.page;
            if (params.page_size) searchParams.page_size = params.page_size; // Results per page
            if (params.limit) searchParams.limit = params.limit; // Total results cap
            
            const response = await client.searchCards(searchParams);
            
            if (response.success && response.data) {
                // Microservice returns paginated data with full metadata
                const scryfallFormat = {
                    object: "list",
                    has_more: response.data.has_more,
                    data: response.data.data,
                    page: response.data.page,
                    page_size: response.data.page_size,
                    total: response.data.total,
                    total_pages: response.data.total_pages,
                };
                storeInCache("search", queryHash, scryfallFormat, CACHE_TTL.search);
                return res.json(scryfallFormat);
            }
        }
        
        // Fallback to direct Scryfall API
        debugLog(`[ScryfallProxy] Microservice unavailable, using direct Scryfall API`);
        const data = await rateLimitedRequest(() =>
            scryfallAxios.get("/cards/search", { params })
        );
        storeInCache("search", queryHash, data, CACHE_TTL.search);
        return res.json(data);
    } catch (err) {
        if (axios.isAxiosError(err) && err.response) {
            return res.status(err.response.status).json(err.response.data);
        }
        return res.status(500).json({ error: "Failed to search cards" });
    }
});

/**
 * GET /api/scryfall/cards/:set/:number
 * Get card by set and collector number using microservice (with fallback to direct Scryfall API)
 */
router.get("/cards/:set/:number", async (req: Request, res: Response) => {
    const { set, number } = req.params;
    const lang = req.query.lang as string | undefined;

    const params: Record<string, string> = { set, number };
    if (lang) params.lang = lang;

    const queryHash = getCacheKey("card", params);
    const cached = getFromCache("card", queryHash);
    if (cached) {
        return res.json(cached);
    }

    try {
        // Try microservice first (search by set and number)
        if (!lang && await isMicroserviceAvailable()) {
            debugLog(`[ScryfallProxy] Using microservice for card lookup: ${set}/${number}`);
            const client = getScryfallClient();
            const searchQuery = `set:${set} number:${number}`;
            const response = await client.searchCards({ q: searchQuery, page_size: 1 });
            
            if (response.success && response.data && response.data.data.length > 0) {
                const card = response.data.data[0];
                storeInCache("card", queryHash, card, CACHE_TTL.card);
                return res.json(card);
            }
        }
        
        // Fallback to direct Scryfall API (for lang param or if microservice unavailable)
        debugLog(`[ScryfallProxy] Using direct Scryfall API for card lookup`);
        const url = lang ? `/cards/${set}/${number}/${lang}` : `/cards/${set}/${number}`;
        const data = await rateLimitedRequest(() => scryfallAxios.get(url));
        storeInCache("card", queryHash, data, CACHE_TTL.card);
        return res.json(data);
    } catch (err) {
        if (axios.isAxiosError(err) && err.response) {
            return res.status(err.response.status).json(err.response.data);
        }
        return res.status(500).json({ error: "Failed to fetch card" });
    }
});

/**
 * GET /api/scryfall/prints
 * Get all prints of a specific card with full metadata (including faceName for DFCs).
 * Used by ArtworkModal for displaying all art versions.
 * 
 * Query params:
 * - name: Card name (required)
 * - lang: Language code (optional, default: en)
 */
router.get("/prints", async (req: Request, res: Response) => {
    const name = req.query.name as string;
    const lang = (req.query.lang as string) || "en";

    if (!name) {
        return res.status(400).json({ error: "Missing name parameter" });
    }

    const params = { name, lang };
    const queryHash = getCacheKey("prints", params);
    const cached = getFromCache("prints", queryHash);
    if (cached) {
        return res.json(cached);
    }

    try {
        let allPrints: typeof import("../utils/getCardImagesPaged.js").ScryfallApiCard[] = [];
        
        // Try microservice first (for en language)
        if (lang === "en" && await isMicroserviceAvailable()) {
            debugLog(`[ScryfallProxy] Using microservice for prints: ${name}`);
            const client = getScryfallClient();
            // Search for all prints: exact name match with unique:prints
            // Note: microservice search doesn't support unique param in query, 
            // but returns all matching cards which we can deduplicate
            const response = await client.searchCards({ q: `!"${name}" include:extras` });
            
            if (response.success && response.data && response.data.data.length > 0) {
                allPrints = response.data.data as any[];
            }
        }
        
        // Fallback to direct Scryfall API or if non-English language requested
        if (allPrints.length === 0) {
            debugLog(`[ScryfallProxy] Using direct method for prints (lang=${lang})`);
            allPrints = await getCardsWithImagesForCardInfo(
                { name },
                "prints", // Get all prints, not just unique art
                lang,
                true // fallback to English if no results in requested language
            );
        }

        // Extract prints with full metadata (including faceName for DFCs)
        const prints: Array<{
            imageUrl: string;
            set: string;
            number: string;
            rarity?: string;
            faceName?: string;
            lang?: string;
        }> = [];

        for (const card of allPrints) {
            if (card.image_uris?.png) {
                // Non-DFC card
                prints.push({
                    imageUrl: card.image_uris.png,
                    set: card.set ?? "",
                    number: card.collector_number ?? "",
                    rarity: card.rarity,
                    faceName: card.name, // Use card name as faceName for compatibility with DFC filtering
                    lang: card.lang,
                });
            } else if (card.card_faces) {
                // DFC - add each face as a separate print
                for (const face of card.card_faces) {
                    if (face.image_uris?.png) {
                        prints.push({
                            imageUrl: face.image_uris.png,
                            set: card.set ?? "",
                            number: card.collector_number ?? "",
                            rarity: card.rarity,
                            faceName: face.name,
                            lang: card.lang,
                        });
                    }
                }
            }
        }

        const result = {
            name,
            lang,
            total: prints.length,
            prints,
        };

        storeInCache("prints", queryHash, result, CACHE_TTL.search);
        return res.json(result);

    } catch (err) {
        debugLog("[ScryfallProxy] Error fetching prints:", err);
        if (axios.isAxiosError(err) && err.response) {
            return res.status(err.response.status).json(err.response.data);
        }
        return res.status(500).json({ error: "Failed to fetch prints" });
    }
});

export { router as scryfallRouter };
