import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted to ensure mocks are available before vi.mock factory runs
const mockBatchSearchMpcAutofill = vi.hoisted(() => vi.fn());
const mockGetMpcAutofillImageUrl = vi.hoisted(() => vi.fn());
const mockPreferences = vi.hoisted(() => ({
    current: {
        favoriteMpcSources: [] as string[],
        favoriteMpcTags: [] as string[],
        favoriteMpcDpi: 0,
    },
}));

vi.mock("./mpcAutofillApi", () => ({
    batchSearchMpcAutofill: mockBatchSearchMpcAutofill,
    getMpcAutofillImageUrl: mockGetMpcAutofillImageUrl,
}));

vi.mock("../store", () => ({
    useSettingsStore: {
        getState: () => ({
            mpcFuzzySearch: true,
        }),
    },
    useUserPreferencesStore: {
        getState: () => ({
            preferences: mockPreferences.current,
        }),
    },
}));

import {
    findBestMpcMatches,
    parseMpcCardLogic,
    pickBestMpcCard,
} from "./mpcImportIntegration";
import type { CardInfo } from "./streamCards";
import type { MpcAutofillCard } from "./mpcAutofillApi";

// Helper to create mock MPC card
function createMpcCard(overrides: Partial<MpcAutofillCard> = {}): MpcAutofillCard {
    return {
        identifier: "test-id",
        name: "Test Card",
        rawName: "Test Card",
        dpi: 800,
        extension: "png",
        smallThumbnailUrl: "https://example.com/small.png",
        mediumThumbnailUrl: "https://example.com/medium.png",
        source: "test",
        sourceName: "Test Source",
        tags: [],
        size: 1000000,
        ...overrides,
    };
}

// Helper to create card info
function createCardInfo(name: string): CardInfo {
    return { name } as CardInfo;
}

describe("mpcImportIntegration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPreferences.current = {
            favoriteMpcSources: [],
            favoriteMpcTags: [],
            favoriteMpcDpi: 0,
        };
        mockGetMpcAutofillImageUrl.mockImplementation((id: string) => `https://example.com/mpc/${id}`);
    });

    describe("findBestMpcMatches", () => {
        it("should return empty array when no cards match", async () => {
            mockBatchSearchMpcAutofill.mockResolvedValue({});

            const result = await findBestMpcMatches([createCardInfo("Lightning Bolt")]);

            expect(result).toEqual([]);
        });

        it("should return matches for found cards", async () => {
            const mpcCard = createMpcCard({ identifier: "bolt-123", name: "Lightning Bolt" });
            mockBatchSearchMpcAutofill.mockResolvedValue({
                "Lightning Bolt": [mpcCard],
            });

            const result = await findBestMpcMatches([createCardInfo("Lightning Bolt")]);

            expect(result).toHaveLength(1);
            expect(result[0].mpcCard).toEqual(mpcCard);
            expect(result[0].imageUrl).toBe("https://example.com/mpc/bolt-123");
        });

        it("should handle multiple cards with same name", async () => {
            const mpcCard = createMpcCard({ identifier: "bolt-123" });
            mockBatchSearchMpcAutofill.mockResolvedValue({
                "Lightning Bolt": [mpcCard],
            });

            const infos = [
                createCardInfo("Lightning Bolt"),
                createCardInfo("Lightning Bolt"),
            ];

            const result = await findBestMpcMatches(infos);

            expect(result).toHaveLength(2);
            // Should have deduplicated the search query and use CARD type for non-tokens
            expect(mockBatchSearchMpcAutofill).toHaveBeenCalledWith(["Lightning Bolt"], "CARD");
        });

        it("should pick card with highest DPI when multiple matches", async () => {
            const lowDpi = createMpcCard({ identifier: "low", dpi: 300 });
            const highDpi = createMpcCard({ identifier: "high", dpi: 1200 });
            mockBatchSearchMpcAutofill.mockResolvedValue({
                "Test Card": [lowDpi, highDpi],
            });

            const result = await findBestMpcMatches([createCardInfo("Test Card")]);

            expect(result[0].mpcCard.identifier).toBe("high");
        });

        it("should batch tokens separately from regular cards and emit both match types", async () => {
            const tokenCard = createMpcCard({
                identifier: "token-1",
                name: "Goblin",
                sourceName: "Token Source",
            });
            const regularCard = createMpcCard({
                identifier: "card-1",
                name: "Lightning Bolt",
                sourceName: "Card Source",
            });
            mockBatchSearchMpcAutofill.mockImplementation(async (_names, cardType) =>
                cardType === "TOKEN"
                    ? { Goblin: [tokenCard] }
                    : { "Lightning Bolt": [regularCard] }
            );

            const result = await findBestMpcMatches([
                { name: "Goblin", isToken: true } as CardInfo,
                createCardInfo("Lightning Bolt"),
            ]);

            expect(mockBatchSearchMpcAutofill).toHaveBeenCalledWith(["Goblin"], "TOKEN");
            expect(mockBatchSearchMpcAutofill).toHaveBeenCalledWith(["Lightning Bolt"], "CARD");
            expect(result.map((match) => match.mpcCard.identifier)).toEqual([
                "token-1",
                "card-1",
            ]);
        });

        it("should skip the card batch call when only tokens are requested", async () => {
            const tokenCard = createMpcCard({ identifier: "token-1", name: "Goblin" });
            mockBatchSearchMpcAutofill.mockResolvedValue({ Goblin: [tokenCard] });

            await expect(
                findBestMpcMatches([{ name: "Goblin", isToken: true } as CardInfo])
            ).resolves.toHaveLength(1);

            expect(mockBatchSearchMpcAutofill).toHaveBeenCalledTimes(1);
            expect(mockBatchSearchMpcAutofill).toHaveBeenCalledWith(["Goblin"], "TOKEN");
        });

        it("should deduplicate repeated token names while returning a match for each token", async () => {
            const tokenCard = createMpcCard({ identifier: "token-1", name: "Goblin" });
            mockBatchSearchMpcAutofill.mockResolvedValue({ Goblin: [tokenCard] });

            const result = await findBestMpcMatches([
                { name: "Goblin", isToken: true } as CardInfo,
                { name: "Goblin", isToken: true } as CardInfo,
            ]);

            expect(mockBatchSearchMpcAutofill).toHaveBeenCalledTimes(1);
            expect(mockBatchSearchMpcAutofill).toHaveBeenCalledWith(["Goblin"], "TOKEN");
            expect(result.map((match) => match.mpcCard.identifier)).toEqual(["token-1", "token-1"]);
        });

        it("should use default preference filters when stored source and tag preferences are absent", async () => {
            mockPreferences.current = {} as typeof mockPreferences.current;
            const mpcCard = createMpcCard({ identifier: "default-prefs", name: "Lightning Bolt" });
            mockBatchSearchMpcAutofill.mockResolvedValue({
                "Lightning Bolt": [mpcCard],
            });

            const result = await findBestMpcMatches([createCardInfo("Lightning Bolt")]);

            expect(result).toHaveLength(1);
            expect(result[0].mpcCard.identifier).toBe("default-prefs");
        });

        it("should skip result entries with empty arrays or rejected preference filters", async () => {
            mockPreferences.current = {
                favoriteMpcSources: ["Missing Source"],
                favoriteMpcTags: [],
                favoriteMpcDpi: 0,
            };
            mockBatchSearchMpcAutofill.mockResolvedValue({
                "No Results": [],
                "Rejected": [
                    createMpcCard({
                        identifier: "rejected",
                        name: "Rejected",
                        sourceName: "Other Source",
                    }),
                ],
            });

            const result = await findBestMpcMatches([
                createCardInfo("No Results"),
                createCardInfo("Rejected"),
            ]);

            expect(result).toHaveLength(1);
            expect(result[0].mpcCard.identifier).toBe("rejected");
        });
    });

    describe("pickBestMpcCard", () => {
        it("should return null for an empty candidate list", () => {
            expect(pickBestMpcCard([], new Set(), new Set())).toBeNull();
        });

        it("should prioritize exact DFC face matches over unrelated high-DPI cards", () => {
            const frontFace = createMpcCard({
                identifier: "front",
                name: "Peter Parker",
                dpi: 300,
            });
            const backFace = createMpcCard({
                identifier: "back",
                name: "Amazing Spider-Man",
                dpi: 400,
            });
            const unrelated = createMpcCard({
                identifier: "unrelated",
                name: "Other Card",
                dpi: 2000,
            });

            expect(
                pickBestMpcCard(
                    [unrelated, frontFace],
                    new Set(),
                    new Set(),
                    "Peter Parker // Amazing Spider-Man"
                )?.identifier
            ).toBe("front");
            expect(
                pickBestMpcCard(
                    [unrelated, backFace],
                    new Set(),
                    new Set(),
                    "Peter Parker // Amazing Spider-Man"
                )?.identifier
            ).toBe("back");
            expect(
                pickBestMpcCard(
                    [
                        createMpcCard({
                            identifier: "dfc-card",
                            name: "Peter Parker // Amazing Spider-Man",
                        }),
                        unrelated,
                    ],
                    new Set(),
                    new Set(),
                    "Amazing Spider-Man"
                )?.identifier
            ).toBe("dfc-card");
        });

        it("should continue past DFC cards whose faces do not match the query", () => {
            const unmatchedDfc = createMpcCard({
                identifier: "unmatched-dfc",
                name: "Peter Parker // Amazing Spider-Man",
                dpi: 2000,
            });
            const exact = createMpcCard({
                identifier: "exact",
                name: "Miles Morales",
                dpi: 300,
            });

            expect(
                pickBestMpcCard([unmatchedDfc, exact], new Set(), new Set(), "Miles Morales")
                    ?.identifier
            ).toBe("exact");
        });

        it("should score favorite source, tag, and DPI preferences with OR filtering", () => {
            const sourceFavorite = createMpcCard({
                identifier: "source",
                sourceName: "Favorite Source",
                dpi: 300,
            });
            const tagFavorite = createMpcCard({
                identifier: "tag",
                sourceName: "Other Source",
                tags: ["Showcase"],
                dpi: 300,
            });
            const dpiFavorite = createMpcCard({
                identifier: "dpi",
                sourceName: "Other Source",
                tags: [],
                dpi: 1200,
            });
            const ignored = createMpcCard({
                identifier: "ignored",
                sourceName: "Other Source",
                tags: [],
                dpi: 300,
            });

            const result = pickBestMpcCard(
                [ignored, dpiFavorite, tagFavorite, sourceFavorite],
                new Set(["Favorite Source"]),
                new Set(["Showcase"]),
                "Test Card",
                1000
            );

            expect(result?.identifier).toBe("source");
        });

        it("should fall back to all candidates when no preference filters match", () => {
            const low = createMpcCard({
                identifier: "low",
                sourceName: "Other Source",
                tags: undefined,
                dpi: 300,
            });
            const high = createMpcCard({
                identifier: "high",
                sourceName: "Other Source",
                tags: [],
                dpi: 600,
            });

            expect(
                pickBestMpcCard(
                    [low, high],
                    new Set(["Missing Source"]),
                    new Set(["Missing Tag"]),
                    undefined,
                    1000
                )?.identifier
            ).toBe("high");
        });

        it("should treat missing DPI as zero when filtering and scoring preferences", () => {
            const noDpi = createMpcCard({
                identifier: "no-dpi",
                dpi: undefined as never,
            });

            expect(
                pickBestMpcCard(
                    [noDpi],
                    new Set(["Missing Source"]),
                    new Set(),
                    undefined,
                    1000
                )?.identifier
            ).toBe("no-dpi");
        });
    });

    describe("parseMpcCardLogic", () => {
        it("should parse card name from MPC format with set in brackets", () => {
            const mpcCard = createMpcCard({ name: "Forest [THB] {254}" });

            const result = parseMpcCardLogic(mpcCard);

            expect(result.name).toBe("Forest");
            expect(result.hasBuiltInBleed).toBe(true);
            expect(result.needsEnrichment).toBe(true);
        });

        it("should parse card name from MPC format with parentheses", () => {
            const mpcCard = createMpcCard({ name: "Lightning Bolt (M21)" });

            const result = parseMpcCardLogic(mpcCard);

            expect(result.name).toBe("Lightning Bolt");
        });

        it("should parse card name with curly braces", () => {
            const mpcCard = createMpcCard({ name: "Sol Ring {C21}" });

            const result = parseMpcCardLogic(mpcCard);

            expect(result.name).toBe("Sol Ring");
        });

        it("should handle simple card name without extra info", () => {
            const mpcCard = createMpcCard({ name: "Lightning Bolt" });

            const result = parseMpcCardLogic(mpcCard);

            expect(result.name).toBe("Lightning Bolt");
        });

        it("should fallback to MPC name if parsing fails", () => {
            const mpcCard = createMpcCard({ name: "" });

            const result = parseMpcCardLogic(mpcCard, "Original Name");

            expect(result.name).toBe("Original Name");
        });

        it("should handle empty name", () => {
            const mpcCard = createMpcCard({ name: "" });

            const result = parseMpcCardLogic(mpcCard);

            expect(result.name).toBe("");
        });

        it("should fallback to the raw MPC name when prefix parsing does not match", () => {
            const mpcCard = createMpcCard({ name: "[No parsed prefix]" });

            const result = parseMpcCardLogic(mpcCard, "Original Name");

            expect(result.name).toBe("[No parsed prefix]");
        });

        it("should trim whitespace from parsed name", () => {
            const mpcCard = createMpcCard({ name: "  Forest  [SET]" });

            const result = parseMpcCardLogic(mpcCard);

            expect(result.name).toBe("Forest");
        });
    });
});
