import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies with vi.hoisted
const mockGetMpcImageUrl = vi.hoisted(() => vi.fn());
const mockGetCachedMpcSearch = vi.hoisted(() => vi.fn());
const mockCacheMpcSearch = vi.hoisted(() => vi.fn());
const mockDebugLog = vi.hoisted(() => vi.fn());

vi.mock("./mpc", () => ({
    getMpcImageUrl: mockGetMpcImageUrl,
}));

vi.mock("./mpcSearchCache", () => ({
    getCachedMpcSearch: mockGetCachedMpcSearch,
    cacheMpcSearch: mockCacheMpcSearch,
}));

vi.mock("./debug", () => ({
    debugLog: mockDebugLog,
}));

import {
    getMpcAutofillImageUrl,
    extractMpcIdentifierFromImageId,
    searchMpcAutofill,
    batchSearchMpcAutofill,
} from "./mpcAutofillApi";
import type { MpcAutofillCard } from "./mpcAutofillApi";

import { parseMpcCardName } from "./mpcUtils";

const createMpcCard = (
    overrides: Partial<MpcAutofillCard> = {}
): MpcAutofillCard => ({
    identifier: "id1",
    name: "Sol Ring {C21}",
    rawName: "Sol Ring {C21}",
    dpi: 300,
    tags: [],
    sourceName: "Test",
    source: "test",
    extension: "png",
    size: 1000,
    smallThumbnailUrl: "",
    mediumThumbnailUrl: "",
    ...overrides,
});

const createDeferred = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });

    return { promise, resolve, reject };
};

describe("mpcAutofillApi", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetMpcImageUrl.mockReset();
        mockGetCachedMpcSearch.mockReset();
        mockCacheMpcSearch.mockReset();
        mockDebugLog.mockReset();
        vi.stubGlobal("fetch", vi.fn());
    });

    describe("getMpcAutofillImageUrl", () => {
        it("should return the MPC image URL for an identifier", () => {
            mockGetMpcImageUrl.mockReturnValue("https://example.com/mpc/abc123");

            const result = getMpcAutofillImageUrl("abc123");

            expect(result).toBe("https://example.com/mpc/abc123");
            expect(mockGetMpcImageUrl).toHaveBeenCalledWith("abc123", "full");
        });

        it("should return empty string if getMpcImageUrl returns null", () => {
            mockGetMpcImageUrl.mockReturnValue(null);

            const result = getMpcAutofillImageUrl("abc123");

            expect(result).toBe("");
        });

        it("should pass explicit image size through to the MPC image helper", () => {
            mockGetMpcImageUrl.mockReturnValue("https://example.com/mpc/abc123-small");

            const result = getMpcAutofillImageUrl("abc123", "small");

            expect(result).toBe("https://example.com/mpc/abc123-small");
            expect(mockGetMpcImageUrl).toHaveBeenCalledWith("abc123", "small");
        });
    });

    describe("extractMpcIdentifierFromImageId", () => {
        it("should return null for undefined imageId", () => {
            expect(extractMpcIdentifierFromImageId(undefined)).toBeNull();
        });

        it("should return null for empty string", () => {
            expect(extractMpcIdentifierFromImageId("")).toBeNull();
        });

        it("should extract identifier from full MPC URL", () => {
            const imageId = "/api/cards/images/mpc?id=abc123456789012345";
            expect(extractMpcIdentifierFromImageId(imageId)).toBe("abc123456789012345");
        });

        it("should extract identifier from MPC URL with additional params", () => {
            const imageId = "/api/cards/images/mpc?id=abc123456789012345&other=param";
            expect(extractMpcIdentifierFromImageId(imageId)).toBe("abc123456789012345");
        });

        it("should return null for malformed MPC URLs without an id parameter", () => {
            expect(extractMpcIdentifierFromImageId("/api/cards/images/mpc?id=")).toBeNull();
        });

        it("should return bare identifier if it matches MPC format", () => {
            const bareId = "abc123456789012345678"; // 21+ alphanumeric chars
            expect(extractMpcIdentifierFromImageId(bareId)).toBe(bareId);
        });

        it("should allow underscores and hyphens in identifier", () => {
            const bareId = "abc_123-456789012345";
            expect(extractMpcIdentifierFromImageId(bareId)).toBe(bareId);
        });

        it("should return null for Scryfall URLs", () => {
            const scryfallUrl = "https://cards.scryfall.io/png/front/a/b/abc123.png";
            expect(extractMpcIdentifierFromImageId(scryfallUrl)).toBeNull();
        });

        it("should return null for known internal image prefixes", () => {
            expect(extractMpcIdentifierFromImageId("cardback_default")).toBeNull();
            expect(extractMpcIdentifierFromImageId("scryfall_abc1234567890")).toBeNull();
            expect(extractMpcIdentifierFromImageId("local_custom_upload")).toBeNull();
        });

        it("should return null for custom uploaded image hashes", () => {
            const hash = "a".repeat(64);

            expect(extractMpcIdentifierFromImageId(hash)).toBeNull();
            expect(extractMpcIdentifierFromImageId(`${hash}-mpc`)).toBeNull();
        });

        it("should return null for short identifiers", () => {
            const shortId = "abc123"; // Less than 15 chars
            expect(extractMpcIdentifierFromImageId(shortId)).toBeNull();
        });
    });

    describe("parseMpcCardName", () => {
        it("should extract name before brackets", () => {
            expect(parseMpcCardName("Forest [THB] {254}")).toBe("Forest");
        });

        it("should extract name before parentheses", () => {
            expect(parseMpcCardName("Lightning Bolt (M21)")).toBe("Lightning Bolt");
        });

        it("should extract name before curly braces", () => {
            expect(parseMpcCardName("Sol Ring {C21}")).toBe("Sol Ring");
        });

        it("should handle name without extra info", () => {
            expect(parseMpcCardName("Lightning Bolt")).toBe("Lightning Bolt");
        });

        it("should trim whitespace", () => {
            expect(parseMpcCardName("  Forest  [SET]")).toBe("Forest");
        });

        it("should return fallback for empty name", () => {
            expect(parseMpcCardName("", "Fallback")).toBe("Fallback");
        });

        it("should return empty string if no fallback and empty name", () => {
            expect(parseMpcCardName("")).toBe("");
        });

        it("should handle complex MPC format", () => {
            expect(parseMpcCardName("Card Name [SET] (V2) {123}")).toBe("Card Name");
        });

        it("should return trimmed MPC name if regex doesn't match", () => {
            // Edge case: name starts with special character
            const result = parseMpcCardName("Test Card");
            expect(result).toBe("Test Card");
        });
    });

    describe("searchMpcAutofill", () => {
        it("coalesces concurrent identical cache misses into one transport and cache write", async () => {
            const response = createDeferred<Response>();
            const cards = [createMpcCard()];
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockReturnValue(response.promise);

            const first = searchMpcAutofill("Sol Ring");
            await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

            const second = searchMpcAutofill("  sol ring  ");
            await vi.waitFor(() => expect(mockGetCachedMpcSearch).toHaveBeenCalledTimes(2));
            expect(fetch).toHaveBeenCalledTimes(1);
            response.resolve({
                ok: true,
                json: () => Promise.resolve({ cards }),
            } as Response);

            const [firstResults, secondResults] = await Promise.all([first, second]);
            expect(firstResults).toBe(secondResults);
            expect(firstResults).toEqual([
                expect.objectContaining({ identifier: "id1", name: "Sol Ring" }),
            ]);
            expect(mockCacheMpcSearch).toHaveBeenCalledTimes(1);
        });

        it("keeps distinct MPC query response filters out of the shared transport", async () => {
            const response = createDeferred<Response>();
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockReturnValue(response.promise);

            const searches = [
                searchMpcAutofill("Sol Ring", "CARD", true),
                searchMpcAutofill("Sol Ring", "CARD", false),
                searchMpcAutofill("Sol Ring", "TOKEN", true),
                searchMpcAutofill("Sol Ring", "CARD", true, { includeAllLanguages: true }),
                searchMpcAutofill("Forest", "CARD", true),
            ];

            await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
            response.resolve({
                ok: true,
                json: () => Promise.resolve({ cards: [createMpcCard()] }),
            } as Response);

            await expect(Promise.all(searches)).resolves.toHaveLength(5);
            expect(mockCacheMpcSearch).toHaveBeenCalledTimes(5);
            expect(vi.mocked(fetch).mock.calls.map(([, request]) => (request as RequestInit).body)).toEqual([
                JSON.stringify({ query: "Sol Ring", cardType: "CARD", fuzzySearch: true }),
                JSON.stringify({ query: "Sol Ring", cardType: "CARD", fuzzySearch: false }),
                JSON.stringify({ query: "Sol Ring", cardType: "TOKEN", fuzzySearch: true }),
                JSON.stringify({ query: "Sol Ring", cardType: "CARD", fuzzySearch: true, includeAllLanguages: true }),
                JSON.stringify({ query: "Forest", cardType: "CARD", fuzzySearch: true }),
            ]);
        });

        it("does not cache a shared transport failure and retries after its registry entry clears", async () => {
            const failure = new Error("network down");
            const failedResponse = createDeferred<Response>();
            const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockReturnValueOnce(failedResponse.promise);

            const first = searchMpcAutofill("Sol Ring");
            await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
            const second = searchMpcAutofill("  sol ring  ");
            await vi.waitFor(() => expect(mockGetCachedMpcSearch).toHaveBeenCalledTimes(2));
            expect(fetch).toHaveBeenCalledTimes(1);
            failedResponse.reject(failure);

            await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
            expect(mockCacheMpcSearch).not.toHaveBeenCalled();

            vi.mocked(fetch).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ cards: [createMpcCard()] }),
            } as Response);
            await expect(searchMpcAutofill("Sol Ring")).resolves.toEqual([
                expect.objectContaining({ identifier: "id1" }),
            ]);
            expect(fetch).toHaveBeenCalledTimes(2);
            expect(mockCacheMpcSearch).toHaveBeenCalledTimes(1);
            expect(consoleErrorSpy).toHaveBeenCalledWith("[MPC Autofill] Search error:", failure);
        });

        it("rejects only an aborted subscriber while another shared-search subscriber completes", async () => {
            const response = createDeferred<Response>();
            const firstController = new AbortController();
            const secondController = new AbortController();
            const abortReason = new DOMException("First subscriber stopped", "AbortError");
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockReturnValue(response.promise);

            const first = searchMpcAutofill("Sol Ring", "CARD", true, {}, firstController.signal);
            await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
            const second = searchMpcAutofill("Sol Ring", "CARD", true, {}, secondController.signal);
            await vi.waitFor(() => expect(mockGetCachedMpcSearch).toHaveBeenCalledTimes(2));
            firstController.abort(abortReason);
            response.resolve({
                ok: true,
                json: () => Promise.resolve({ cards: [createMpcCard()] }),
            } as Response);

            await expect(first).rejects.toBe(abortReason);
            await expect(second).resolves.toEqual([
                expect.objectContaining({ identifier: "id1" }),
            ]);
            expect(mockCacheMpcSearch).toHaveBeenCalledTimes(1);
        });

        it("aborts the physical transport after every shared-search subscriber cancels and admits a retry", async () => {
            const firstController = new AbortController();
            const secondController = new AbortController();
            const firstReason = new DOMException("First subscriber stopped", "AbortError");
            const secondReason = new DOMException("Second subscriber stopped", "AbortError");
            const abortedTransport = createDeferred<Response>();
            let transportSignal: AbortSignal | undefined;
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockImplementation((_, request) => {
                transportSignal = (request as RequestInit).signal as AbortSignal;
                transportSignal.addEventListener("abort", () => {
                    abortedTransport.reject(transportSignal?.reason);
                }, { once: true });
                return abortedTransport.promise;
            });

            const first = searchMpcAutofill("Sol Ring", "CARD", true, {}, firstController.signal);
            await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
            const second = searchMpcAutofill("Sol Ring", "CARD", true, {}, secondController.signal);
            await vi.waitFor(() => expect(mockGetCachedMpcSearch).toHaveBeenCalledTimes(2));
            firstController.abort(firstReason);
            expect(transportSignal?.aborted).toBe(false);
            secondController.abort(secondReason);

            await expect(first).rejects.toBe(firstReason);
            await expect(second).rejects.toBe(secondReason);
            expect(transportSignal?.aborted).toBe(true);
            expect(mockCacheMpcSearch).not.toHaveBeenCalled();

            vi.mocked(fetch).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve({ cards: [createMpcCard()] }),
            } as Response);
            await expect(searchMpcAutofill("Sol Ring")).resolves.toEqual([
                expect.objectContaining({ identifier: "id1" }),
            ]);
            expect(fetch).toHaveBeenCalledTimes(2);
        });

        it("keeps a retry registry entry when an abandoned transport settles after it", async () => {
            const controller = new AbortController();
            const abortReason = new DOMException("Subscriber stopped", "AbortError");
            const oldTransport = createDeferred<Response>();
            const retryTransport = createDeferred<Response>();
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch)
                .mockImplementationOnce(() => oldTransport.promise)
                .mockImplementationOnce(() => retryTransport.promise);

            const abandoned = searchMpcAutofill("Sol Ring", "CARD", true, {}, controller.signal);
            await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
            controller.abort(abortReason);
            await expect(abandoned).rejects.toBe(abortReason);

            const retry = searchMpcAutofill("Sol Ring");
            await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
            oldTransport.resolve({
                ok: true,
                json: () => Promise.resolve({ cards: [createMpcCard({ identifier: "old" })] }),
            } as Response);
            await Promise.resolve();
            await Promise.resolve();

            const lateJoiner = searchMpcAutofill("  sol ring  ");
            await vi.waitFor(() => expect(mockGetCachedMpcSearch).toHaveBeenCalledTimes(3));
            expect(fetch).toHaveBeenCalledTimes(2);
            retryTransport.resolve({
                ok: true,
                json: () => Promise.resolve({ cards: [createMpcCard({ identifier: "retry" })] }),
            } as Response);

            await expect(Promise.all([retry, lateJoiner])).resolves.toEqual([
                [expect.objectContaining({ identifier: "retry" })],
                [expect.objectContaining({ identifier: "retry" })],
            ]);
            expect(mockCacheMpcSearch).toHaveBeenCalledTimes(1);
        });

        it("should parse card names before returning results", async () => {
            // Setup: API returns unparsed names
            const mockResponse = {
                cards: [
                    { identifier: "id1", name: "Deflecting Swat (Borderless Greg Staples)", dpi: 300, tags: [], sourceName: "Test", source: "test", extension: "png", size: 1000, smallThumbnailUrl: "", mediumThumbnailUrl: "" },
                    { identifier: "id2", name: "Deflecting Swat {311} (Patrick Gañas) (Elemental Frame)", dpi: 300, tags: [], sourceName: "Test", source: "test", extension: "png", size: 1000, smallThumbnailUrl: "", mediumThumbnailUrl: "" },
                ],
            };
            mockGetCachedMpcSearch.mockResolvedValue(null); // No cache hit
            vi.mocked(fetch).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(mockResponse),
            } as Response);

            const results = await searchMpcAutofill("Deflecting Swat");

            // Verify returned names are parsed
            expect(results[0].name).toBe("Deflecting Swat");
            expect(results[1].name).toBe("Deflecting Swat");
        });

        it("should cache parsed names, not unparsed names", async () => {
            const mockResponse = {
                cards: [
                    { identifier: "id1", name: "Sol Ring {C21} (Artist Name)", dpi: 300, tags: [], sourceName: "Test", source: "test", extension: "png", size: 1000, smallThumbnailUrl: "", mediumThumbnailUrl: "" },
                ],
            };
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(mockResponse),
            } as Response);

            await searchMpcAutofill("Sol Ring");

            // Verify cacheMpcSearch was called with parsed names
            expect(mockCacheMpcSearch).toHaveBeenCalled();
            const cachedCards = mockCacheMpcSearch.mock.calls[0][2];
            expect(cachedCards[0].name).toBe("Sol Ring");
        });

        it("should return empty array for empty query", async () => {
            const results = await searchMpcAutofill("");
            expect(results).toEqual([]);
        });

        it("should return cached search results without fetching", async () => {
            const cachedCards = [createMpcCard({ identifier: "cached" })];
            mockGetCachedMpcSearch.mockResolvedValue(cachedCards);

            await expect(searchMpcAutofill("  Sol Ring  ", "TOKEN", false)).resolves.toBe(cachedCards);

            expect(mockGetCachedMpcSearch).toHaveBeenCalledWith("sol ring:exact", "TOKEN");
            expect(fetch).not.toHaveBeenCalled();
        });

        it("should isolate all-language calibration searches in the cache and request body", async () => {
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    cards: [createMpcCard({
                        identifier: "shipwreck-fr",
                        name: "Shipwreck Marsh (Min Steven Belledin)",
                    })],
                }),
            } as Response);

            const searchWithOptions = searchMpcAutofill as unknown as (
                query: string,
                cardType: "CARD" | "CARDBACK" | "TOKEN",
                fuzzySearch: boolean,
                options: { includeAllLanguages: boolean }
            ) => Promise<MpcAutofillCard[]>;
            await searchWithOptions("Shipwreck Marsh", "CARD", false, {
                includeAllLanguages: true,
            });

            expect(mockGetCachedMpcSearch).toHaveBeenCalledWith(
                "shipwreck marsh:exact:all-languages",
                "CARD"
            );
            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining("/api/mpcfill/search"),
                expect.objectContaining({
                    body: JSON.stringify({
                        query: "Shipwreck Marsh",
                        cardType: "CARD",
                        fuzzySearch: false,
                        includeAllLanguages: true,
                    }),
                })
            );
            expect(mockCacheMpcSearch).toHaveBeenCalledWith(
                "shipwreck marsh:exact:all-languages",
                "CARD",
                expect.arrayContaining([
                    expect.objectContaining({ identifier: "shipwreck-fr" }),
                ])
            );
        });

        it("should use a transport signal that is isolated from an optional subscriber AbortSignal", async () => {
            const controller = new AbortController();
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ cards: [] }),
            } as Response);

            await searchMpcAutofill("Sol Ring", "CARD", true, {}, controller.signal);

            const [, request] = vi.mocked(fetch).mock.calls[0];
            expect(request).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
            expect((request as RequestInit).signal).not.toBe(controller.signal);
        });

        it("should propagate search cancellation without caching results", async () => {
            const controller = new AbortController();
            const abortError = new DOMException("Request aborted", "AbortError");
            controller.abort(abortError);
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockRejectedValue(abortError);

            await expect(
                searchMpcAutofill("Sol Ring", "CARD", true, {}, controller.signal)
            ).rejects.toBe(abortError);

            expect(mockCacheMpcSearch).not.toHaveBeenCalled();
        });

        it("should not cache a search response when its signal aborts during body reading", async () => {
            const controller = new AbortController();
            const abortError = new DOMException("Request aborted", "AbortError");
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockResolvedValue({
                ok: true,
                json: () => {
                    controller.abort(abortError);
                    return Promise.resolve({ cards: [createMpcCard()] });
                },
            } as Response);

            await expect(
                searchMpcAutofill("Sol Ring", "CARD", true, {}, controller.signal)
            ).rejects.toBe(abortError);

            expect(mockCacheMpcSearch).not.toHaveBeenCalled();
        });

        it("should reject with the abort reason after a pending cache write completes", async () => {
            const controller = new AbortController();
            const abortError = new DOMException("Request aborted", "AbortError");
            const cacheWrite = createDeferred<void>();
            const cacheWriteStarted = createDeferred<void>();
            mockGetCachedMpcSearch.mockResolvedValue(null);
            mockCacheMpcSearch.mockImplementationOnce(() => {
                cacheWriteStarted.resolve();
                return cacheWrite.promise;
            });
            vi.mocked(fetch).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ cards: [createMpcCard()] }),
            } as Response);

            const search = searchMpcAutofill("Sol Ring", "CARD", true, {}, controller.signal);
            await cacheWriteStarted.promise;
            controller.abort(abortError);
            cacheWrite.resolve();

            await expect(search).rejects.toBe(abortError);
            expect(mockCacheMpcSearch).toHaveBeenCalledTimes(1);
        });

        it("should return an empty array and skip caching when search responds with no cards", async () => {
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({}),
            } as Response);

            await expect(searchMpcAutofill("No Results")).resolves.toEqual([]);

            expect(mockCacheMpcSearch).not.toHaveBeenCalled();
        });

        it("should return an empty array for failed search responses", async () => {
            const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);

            await expect(searchMpcAutofill("Offline")).resolves.toEqual([]);

            expect(consoleErrorSpy).toHaveBeenCalledWith("[MPC Autofill] Search failed:", 503);
        });

        it("should return an empty array for thrown search errors", async () => {
            const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const error = new Error("network down");
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockRejectedValue(error);

            await expect(searchMpcAutofill("Offline")).resolves.toEqual([]);

            expect(consoleErrorSpy).toHaveBeenCalledWith("[MPC Autofill] Search error:", error);
        });
    });

    describe("batchSearchMpcAutofill", () => {
        it("should forward an optional AbortSignal to the batch request", async () => {
            const controller = new AbortController();
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ results: {} }),
            } as Response);

            await batchSearchMpcAutofill(["Sol Ring"], "CARD", controller.signal);

            expect(fetch).toHaveBeenCalledWith(
                expect.stringContaining("/api/mpcfill/batch-search"),
                expect.objectContaining({ signal: controller.signal })
            );
        });

        it("should propagate batch cancellation without caching results", async () => {
            const controller = new AbortController();
            const abortError = new DOMException("Request aborted", "AbortError");
            controller.abort(abortError);
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockRejectedValue(abortError);

            await expect(
                batchSearchMpcAutofill(["Sol Ring"], "CARD", controller.signal)
            ).rejects.toBe(abortError);

            expect(mockCacheMpcSearch).not.toHaveBeenCalled();
        });

        it("should stop starting cache writes after a pending write completes following abort", async () => {
            const controller = new AbortController();
            const abortError = new DOMException("Request aborted", "AbortError");
            const firstCacheWrite = createDeferred<void>();
            const firstCacheWriteStarted = createDeferred<void>();
            mockGetCachedMpcSearch.mockResolvedValue(null);
            mockCacheMpcSearch.mockImplementationOnce(() => {
                firstCacheWriteStarted.resolve();
                return firstCacheWrite.promise;
            });
            vi.mocked(fetch).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    results: {
                        "Sol Ring": [createMpcCard()],
                        Forest: [createMpcCard({ identifier: "forest", name: "Forest" })],
                    },
                }),
            } as Response);

            const search = batchSearchMpcAutofill(["Sol Ring", "Forest"], "CARD", controller.signal);
            await firstCacheWriteStarted.promise;
            controller.abort(abortError);
            firstCacheWrite.resolve();

            await expect(search).rejects.toBe(abortError);
            expect(mockCacheMpcSearch).toHaveBeenCalledTimes(1);
        });

        it("should parse card names before returning results", async () => {
            const mockResponse = {
                results: {
                    "Lightning Bolt": [
                        { identifier: "id1", name: "Lightning Bolt (M21) (Artist)", dpi: 300, tags: [], sourceName: "Test", source: "test", extension: "png", size: 1000, smallThumbnailUrl: "", mediumThumbnailUrl: "" },
                    ],
                    "Forest": [
                        { identifier: "id2", name: "Forest [THB] {254}", dpi: 300, tags: [], sourceName: "Test", source: "test", extension: "png", size: 1000, smallThumbnailUrl: "", mediumThumbnailUrl: "" },
                    ],
                },
            };
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(mockResponse),
            } as Response);

            const results = await batchSearchMpcAutofill(["Lightning Bolt", "Forest"]);

            // Verify returned names are parsed
            expect(results["Lightning Bolt"][0].name).toBe("Lightning Bolt");
            expect(results["Forest"][0].name).toBe("Forest");
        });

        it("should cache parsed names, not unparsed names", async () => {
            const mockResponse = {
                results: {
                    "Dark Ritual": [
                        { identifier: "id1", name: "Dark Ritual {311} (Borderless)", dpi: 300, tags: [], sourceName: "Test", source: "test", extension: "png", size: 1000, smallThumbnailUrl: "", mediumThumbnailUrl: "" },
                    ],
                },
            };
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(mockResponse),
            } as Response);

            await batchSearchMpcAutofill(["Dark Ritual"]);

            // Verify cacheMpcSearch was called with parsed names
            expect(mockCacheMpcSearch).toHaveBeenCalled();
            const cachedCards = mockCacheMpcSearch.mock.calls[0][2];
            expect(cachedCards[0].name).toBe("Dark Ritual");
        });

        it("should return empty object for empty queries array", async () => {
            const results = await batchSearchMpcAutofill([]);
            expect(results).toEqual({});
        });

        it("should return cached batch results without fetching when every query is cached", async () => {
            const cachedBolt = [createMpcCard({ identifier: "bolt", name: "Lightning Bolt" })];
            const cachedForest = [createMpcCard({ identifier: "forest", name: "Forest" })];
            mockGetCachedMpcSearch
                .mockResolvedValueOnce(cachedBolt)
                .mockResolvedValueOnce(cachedForest);

            await expect(batchSearchMpcAutofill([" Lightning Bolt ", "Forest"], "TOKEN")).resolves.toEqual({
                " Lightning Bolt ": cachedBolt,
                Forest: cachedForest,
            });

            expect(mockDebugLog).toHaveBeenCalledWith("[MPC Batch] 2 cache hits, 0 misses");
            expect(fetch).not.toHaveBeenCalled();
        });

        it("should keep cached batch hits when the uncached server request fails", async () => {
            const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const cachedBolt = [createMpcCard({ identifier: "bolt", name: "Lightning Bolt" })];
            mockGetCachedMpcSearch
                .mockResolvedValueOnce(cachedBolt)
                .mockResolvedValueOnce(null);
            vi.mocked(fetch).mockResolvedValue({ ok: false, status: 502 } as Response);

            await expect(batchSearchMpcAutofill(["Lightning Bolt", "Forest"])).resolves.toEqual({
                "Lightning Bolt": cachedBolt,
            });

            expect(consoleErrorSpy).toHaveBeenCalledWith("[MPC Autofill] Batch search failed:", 502);
        });

        it("should keep cached batch hits when the uncached server request throws", async () => {
            const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const error = new Error("network down");
            const cachedBolt = [createMpcCard({ identifier: "bolt", name: "Lightning Bolt" })];
            mockGetCachedMpcSearch
                .mockResolvedValueOnce(cachedBolt)
                .mockResolvedValueOnce(null);
            vi.mocked(fetch).mockRejectedValue(error);

            await expect(batchSearchMpcAutofill(["Lightning Bolt", "Forest"])).resolves.toEqual({
                "Lightning Bolt": cachedBolt,
            });

            expect(consoleErrorSpy).toHaveBeenCalledWith("[MPC Autofill] Batch search error:", error);
        });

        it("should skip cache writes for empty batch result entries", async () => {
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ results: { Forest: [] } }),
            } as Response);

            await expect(batchSearchMpcAutofill([" Forest "])).resolves.toEqual({
                Forest: [],
            });

            expect(mockCacheMpcSearch).not.toHaveBeenCalled();
        });

        it("should tolerate batch responses that omit the results object", async () => {
            mockGetCachedMpcSearch.mockResolvedValue(null);
            vi.mocked(fetch).mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({}),
            } as Response);

            await expect(batchSearchMpcAutofill(["Forest"])).resolves.toEqual({});
        });
    });
});
