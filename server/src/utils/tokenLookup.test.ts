import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CardInfo, TokenPart } from "../../../shared/types.js";

// Note: vi.mock() is hoisted, so any referenced values must be created via vi.hoisted().
const hoisted = vi.hoisted(() => {
  const mockClient = {
    searchCards: vi.fn(),
    getCardByName: vi.fn(),
    getCard: vi.fn(),
  };
  return {
    mockClient,
    mockIsMicroserviceAvailable: vi.fn(),
    mockGetScryfallClient: vi.fn(() => mockClient),
    mockBatchFetchCards: vi.fn(),
    mockGetCardDataForCardInfo: vi.fn(),
    mockGetCardsWithImagesForCardInfo: vi.fn(),
    mockAxiosGet: vi.fn(),
  };
});

vi.mock("axios", () => {
  const create = vi.fn(() => ({
    get: hoisted.mockAxiosGet,
  }));
  return {
    create,
    default: { create },
  };
});

vi.mock("../services/scryfallMicroserviceClient.js", () => ({
  getScryfallClient: hoisted.mockGetScryfallClient,
  isMicroserviceAvailable: hoisted.mockIsMicroserviceAvailable,
}));

vi.mock("./getCardImagesPaged.js", () => ({
  batchFetchCards: hoisted.mockBatchFetchCards,
  getCardDataForCardInfo: hoisted.mockGetCardDataForCardInfo,
  getCardsWithImagesForCardInfo: hoisted.mockGetCardsWithImagesForCardInfo,
}));

vi.mock("./debug.js", () => ({
  debugLog: vi.fn(),
}));

import { fetchCardsForTokenLookup, resolveLatestTokenParts } from "./tokenLookup.js";

function resetHoistedMocks() {
  hoisted.mockClient.searchCards.mockReset();
  hoisted.mockClient.getCardByName.mockReset();
  hoisted.mockClient.getCard.mockReset();
  hoisted.mockIsMicroserviceAvailable.mockReset();
  hoisted.mockGetScryfallClient.mockReset().mockReturnValue(hoisted.mockClient);
  hoisted.mockBatchFetchCards.mockReset();
  hoisted.mockGetCardDataForCardInfo.mockReset();
  hoisted.mockGetCardsWithImagesForCardInfo.mockReset();
  hoisted.mockAxiosGet.mockReset();
}

describe("fetchCardsForTokenLookup", () => {
  const env = { ...process.env };

  beforeEach(() => {
    resetHoistedMocks();
    process.env = { ...env };
    delete process.env.SCRYFALL_CACHE_URL;
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it("falls back to batchFetchCards when SCRYFALL_CACHE_URL is not configured", async () => {
    hoisted.mockBatchFetchCards.mockResolvedValueOnce(new Map([["sol ring", { name: "Sol Ring" }]]));

    const res = await fetchCardsForTokenLookup([{ name: "Sol Ring" } as CardInfo], "en");
    expect(res.usedMicroservice).toBe(false);
    expect(hoisted.mockBatchFetchCards).toHaveBeenCalledTimes(1);
    expect(hoisted.mockIsMicroserviceAvailable).toHaveBeenCalledTimes(0);
  });

  it("uses microservice for hits and does not call batchFetchCards", async () => {
    process.env.SCRYFALL_CACHE_URL = "http://localhost:8080";
    hoisted.mockIsMicroserviceAvailable.mockResolvedValueOnce(true);

    hoisted.mockClient.searchCards.mockResolvedValueOnce({
      success: true,
      data: {
        data: [{ name: "Sol Ring", set: "cm2", collector_number: "229" }],
      },
    });

    hoisted.mockClient.getCardByName.mockResolvedValueOnce({
      success: true,
      data: { name: "Karn, Scion of Urza", set: "dom", collector_number: "1" },
    });

    const res = await fetchCardsForTokenLookup(
      [
        { name: "Sol Ring", set: "cm2", number: "229" } as CardInfo,
        { name: "Karn, Scion of Urza" } as CardInfo,
      ],
      "en"
    );

    expect(res.usedMicroservice).toBe(true);
    expect(hoisted.mockBatchFetchCards).toHaveBeenCalledTimes(0);
    expect(hoisted.mockClient.searchCards).toHaveBeenCalledTimes(1);
    expect(hoisted.mockClient.getCardByName).toHaveBeenCalledTimes(1);

    expect(res.cards.get("sol ring")?.name).toBe("Sol Ring");
    expect(res.cards.get("cm2:229")?.name).toBe("Sol Ring");
    expect(res.cards.get("karn, scion of urza")?.name).toBe("Karn, Scion of Urza");
    expect(res.cards.get("dom:1")?.name).toBe("Karn, Scion of Urza");
  });

  it("falls back for microservice misses (and only fetches misses via batchFetchCards)", async () => {
    process.env.SCRYFALL_CACHE_URL = "http://localhost:8080";
    hoisted.mockIsMicroserviceAvailable.mockResolvedValueOnce(true);

    // First card is a miss (no data), second is a hit.
    hoisted.mockClient.getCardByName
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: false }); // fuzzy attempt

    hoisted.mockClient.searchCards.mockResolvedValueOnce({
      success: true,
      data: {
        data: [{ name: "Sol Ring", set: "cm2", collector_number: "229" }],
      },
    });

    hoisted.mockBatchFetchCards.mockResolvedValueOnce(
      new Map([["mystery card", { name: "Mystery Card", set: "myst", collector_number: "7" }]])
    );

    const res = await fetchCardsForTokenLookup(
      [
        { name: "Mystery Card" } as CardInfo,
        { name: "Sol Ring", set: "cm2", number: "229" } as CardInfo,
      ],
      "en"
    );

    expect(res.usedMicroservice).toBe(true);
    expect(hoisted.mockBatchFetchCards).toHaveBeenCalledTimes(1);
    // Only the miss is passed to fallback.
    expect(hoisted.mockBatchFetchCards.mock.calls[0]?.[0]?.length).toBe(1);
    expect(res.cards.get("sol ring")?.name).toBe("Sol Ring");
    expect(res.cards.get("mystery card")?.name).toBe("Mystery Card");
  });
});

describe("resolveLatestTokenParts", () => {
  beforeEach(() => {
    resetHoistedMocks();
  });

  it("resolves linked token id and selects newest print for its oracle_id", async () => {
    hoisted.mockAxiosGet.mockResolvedValueOnce({
      data: {
        id: "token-old",
        name: "Treasure",
        oracle_id: "oracle-token",
        set: "tneo",
        collector_number: "21",
        released_at: "2022-01-01",
      },
    });

    hoisted.mockGetCardsWithImagesForCardInfo.mockResolvedValueOnce([
      {
        id: "token-new",
        name: "Treasure",
        oracle_id: "oracle-token",
        set: "tfdn",
        collector_number: "42",
        released_at: "2025-09-01",
      },
      {
        id: "token-old",
        name: "Treasure",
        oracle_id: "oracle-token",
        set: "tneo",
        collector_number: "21",
        released_at: "2022-01-01",
      },
      {
        id: "token-other",
        name: "Treasure",
        oracle_id: "other-oracle",
        set: "tm21",
        collector_number: "99",
        released_at: "2026-01-01",
      },
    ]);

    const input: TokenPart[] = [
      { id: "token-old", name: "Treasure", uri: "https://api.scryfall.com/cards/token-old" },
    ];
    const result = await resolveLatestTokenParts(input, "en");

    expect(result).toEqual([
      {
        id: "token-new",
        name: "Treasure",
        uri: "https://api.scryfall.com/cards/tfdn/42",
      },
    ]);
  });

  it("falls back to name lookup when id lookup fails and dedupes by token identity", async () => {
    hoisted.mockAxiosGet.mockResolvedValueOnce({ data: null });
    hoisted.mockGetCardDataForCardInfo.mockResolvedValueOnce({
      id: "soldier-id",
      name: "Soldier",
      oracle_id: "oracle-soldier",
      set: "tznr",
      collector_number: "1",
      released_at: "2020-09-25",
    });
    hoisted.mockGetCardsWithImagesForCardInfo.mockResolvedValueOnce([
      {
        id: "soldier-latest",
        name: "Soldier",
        oracle_id: "oracle-soldier",
        set: "tmh3",
        collector_number: "8",
        released_at: "2024-06-14",
      },
    ]);

    const input: TokenPart[] = [
      { name: "Soldier" },
      { name: "Soldier" },
    ];
    const result = await resolveLatestTokenParts(input, "en");

    expect(result).toEqual([
      {
        id: "soldier-latest",
        name: "Soldier",
        uri: "https://api.scryfall.com/cards/tmh3/8",
      },
    ]);
  });
});

describe("fetchCardsForTokenLookup additional branches", () => {
  const env = { ...process.env };
  beforeEach(() => {
    resetHoistedMocks();
    process.env = { ...env };
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it("returns an empty result for empty inputs", async () => {
    await expect(fetchCardsForTokenLookup([], "en")).resolves.toEqual({ cards: new Map(), usedMicroservice: false });
    await expect(fetchCardsForTokenLookup(undefined as unknown as CardInfo[], "en")).resolves.toEqual({ cards: new Map(), usedMicroservice: false });
  });

  it("falls back when configured microservice is unavailable", async () => {
    process.env.SCRYFALL_CACHE_URL = "http://localhost:8080";
    hoisted.mockIsMicroserviceAvailable.mockResolvedValueOnce(false);
    hoisted.mockBatchFetchCards.mockResolvedValueOnce(new Map([["fallback", { name: "Fallback" }]]));

    const result = await fetchCardsForTokenLookup([{ name: "Fallback" } as CardInfo], "en");

    expect(result.usedMicroservice).toBe(false);
    expect(result.cards.get("fallback")?.name).toBe("Fallback");
    expect(hoisted.mockClient.getCardByName).not.toHaveBeenCalled();
  });

  it("uses fuzzy microservice results after exact name misses and stores face aliases", async () => {
    process.env.SCRYFALL_CACHE_URL = "http://localhost:8080";
    hoisted.mockIsMicroserviceAvailable.mockResolvedValueOnce(true);
    hoisted.mockClient.getCardByName
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({
        success: true,
        data: {
          name: "Bala Ged Recovery // Bala Ged Sanctuary",
          set: "znr",
          collector_number: "180",
          card_faces: [{ name: "Bala Ged Recovery" }, { name: "Bala Ged Sanctuary" }],
        },
      });

    const result = await fetchCardsForTokenLookup([{ name: "Bala Ged Recovery" } as CardInfo], "en");

    expect(result.cards.get("bala ged recovery")?.name).toContain("//");
    expect(result.cards.get("bala ged sanctuary")?.name).toContain("//");
    expect(hoisted.mockBatchFetchCards).not.toHaveBeenCalled();
  });

  it("falls back for microservice errors and deduplicates repeated card infos", async () => {
    process.env.SCRYFALL_CACHE_URL = "http://localhost:8080";
    hoisted.mockIsMicroserviceAvailable.mockResolvedValueOnce(true);
    hoisted.mockClient.getCardByName.mockRejectedValueOnce(new Error("boom"));
    hoisted.mockBatchFetchCards.mockResolvedValueOnce(new Map([["err", { name: "Err" }]]));

    const result = await fetchCardsForTokenLookup([{ name: "Err" } as CardInfo, { name: "Err" } as CardInfo], "en");

    expect(hoisted.mockClient.getCardByName).toHaveBeenCalledTimes(1);
    expect(hoisted.mockBatchFetchCards.mock.calls[0]?.[0]).toHaveLength(2);
    expect(result.cards.get("err")?.name).toBe("Err");
  });

  it("queues microservice lookups beyond the concurrency limit", async () => {
    process.env.SCRYFALL_CACHE_URL = "http://localhost:8080";
    hoisted.mockIsMicroserviceAvailable.mockResolvedValueOnce(true);

    const deferred: Array<{ resolve: (value: unknown) => void }> = [];
    hoisted.mockClient.getCardByName.mockImplementation(({ exact }: { exact: string }) => (
      new Promise((resolve) => {
        deferred.push({ resolve });
        resolve({ success: true, data: { name: exact, set: "tst", collector_number: String(deferred.length) } });
      })
    ));

    const result = await fetchCardsForTokenLookup(
      Array.from({ length: 9 }, (_, idx) => ({ name: `Queued ${idx}` } as CardInfo)),
      "en"
    );

    expect(hoisted.mockClient.getCardByName).toHaveBeenCalledTimes(9);
    expect(result.cards.get("queued 8")?.collector_number).toBe("9");
  });
});

describe("resolveLatestTokenParts additional branches", () => {
  beforeEach(() => {
    resetHoistedMocks();
  });

  it("returns empty for missing token part inputs and skips nameless tokens", async () => {
    await expect(resolveLatestTokenParts(undefined, "en")).resolves.toEqual([]);
    await expect(resolveLatestTokenParts([], "en")).resolves.toEqual([]);
    await expect(resolveLatestTokenParts([{ id: "no-name" }], "en")).resolves.toEqual([]);
  });

  it("resolves exact token print from a set/number uri when id lookup misses", async () => {
    hoisted.mockAxiosGet.mockResolvedValueOnce({ data: undefined });
    hoisted.mockGetCardDataForCardInfo.mockResolvedValueOnce({
      id: "gold-print",
      name: "Gold",
      oracle_id: "oracle-gold",
      set: "tlci",
      collector_number: "12",
      type_line: "Token Artifact — Gold",
    });
    hoisted.mockGetCardsWithImagesForCardInfo.mockResolvedValueOnce([]);

    const result = await resolveLatestTokenParts([
      { id: "old-id", name: "Gold", uri: "https://api.scryfall.com/cards/tlci/12", type_line: "Token Artifact" },
    ], "en");

    expect(hoisted.mockGetCardDataForCardInfo).toHaveBeenCalledWith({ name: "Gold", set: "tlci", number: "12", isToken: true }, "en", true);
    expect(result).toEqual([{ id: "gold-print", name: "Gold", uri: "https://api.scryfall.com/cards/tlci/12", type_line: "Token Artifact — Gold" }]);
  });

  it("resolves token identity from a single-id Scryfall uri when no token id is present", async () => {
    hoisted.mockAxiosGet.mockResolvedValueOnce({
      data: {
        id: "uri-token",
        name: "Clue",
        set: "tmkm",
        collector_number: "15",
        type_line: "Token Artifact — Clue",
      },
    });

    const result = await resolveLatestTokenParts([
      { name: "Clue", uri: "https://api.scryfall.com/cards/uri-token" },
    ], "en");

    expect(hoisted.mockAxiosGet).toHaveBeenCalledWith("https://api.scryfall.com/cards/uri-token");
    expect(result).toEqual([
      {
        id: "uri-token",
        name: "Clue",
        uri: "https://api.scryfall.com/cards/tmkm/15",
        type_line: "Token Artifact — Clue",
      },
    ]);
  });

  it("falls back to the original token when linked lookups fail", async () => {
    hoisted.mockAxiosGet.mockResolvedValueOnce({ data: undefined });
    hoisted.mockGetCardDataForCardInfo.mockResolvedValueOnce(undefined);

    await expect(resolveLatestTokenParts([{ id: "missing", name: "Missing" }], "en")).resolves.toEqual([{ id: "missing", name: "Missing" }]);
  });

  it("falls back to name lookup when direct id requests throw", async () => {
    hoisted.mockAxiosGet.mockRejectedValueOnce(new Error("scryfall unavailable"));
    hoisted.mockGetCardDataForCardInfo.mockResolvedValueOnce({
      id: "name-token",
      name: "Food",
      oracle_id: "oracle-food",
      type_line: "Token Artifact — Food",
    });
    hoisted.mockGetCardsWithImagesForCardInfo.mockResolvedValueOnce([]);

    await expect(resolveLatestTokenParts([{ id: "bad-id", name: "Food" }], "en")).resolves.toEqual([
      { id: "name-token", name: "Food", type_line: "Token Artifact — Food" },
    ]);
  });

  it("keeps the linked token when newer-print lookup has no matching oracle id", async () => {
    hoisted.mockAxiosGet.mockResolvedValueOnce({
      data: {
        id: "linked-token",
        name: "Treasure",
        oracle_id: "oracle-linked",
        set: "tneo",
        collector_number: "21",
      },
    });
    hoisted.mockGetCardsWithImagesForCardInfo.mockResolvedValueOnce([
      {
        id: "other-token",
        name: "Treasure",
        oracle_id: "other-oracle",
        set: "tm21",
        collector_number: "99",
      },
    ]);

    await expect(resolveLatestTokenParts([{ id: "linked-token", name: "Treasure" }], "en")).resolves.toEqual([
      { id: "linked-token", name: "Treasure", uri: "https://api.scryfall.com/cards/tneo/21" },
    ]);
  });

  it("breaks newest-token ties by set code and collector number", async () => {
    hoisted.mockAxiosGet.mockResolvedValueOnce({
      data: {
        id: "old-token",
        name: "Soldier",
        oracle_id: "oracle-soldier",
        set: "taaa",
        collector_number: "1",
      },
    });
    hoisted.mockGetCardsWithImagesForCardInfo.mockResolvedValueOnce([
      {
        id: "soldier-low",
        name: "Soldier",
        oracle_id: "oracle-soldier",
        set: "taaa",
        collector_number: "20",
      },
      {
        id: "soldier-high-set",
        name: "Soldier",
        oracle_id: "oracle-soldier",
        set: "tzzz",
        collector_number: "1",
      },
      {
        id: "soldier-high-number",
        name: "Soldier",
        oracle_id: "oracle-soldier",
        set: "taaa",
        collector_number: "30",
      },
    ]);

    await expect(resolveLatestTokenParts([{ id: "old-token", name: "Soldier" }], "en")).resolves.toEqual([
      { id: "soldier-high-set", name: "Soldier", uri: "https://api.scryfall.com/cards/tzzz/1" },
    ]);
  });

  it("preserves fallback URI when a linked card has no oracle data", async () => {
    hoisted.mockAxiosGet.mockResolvedValueOnce({ data: { id: "plain", name: "Plain", type_line: "Token" } });

    await expect(resolveLatestTokenParts([{ id: "plain", name: "Plain", uri: "not a url" }], "en")).resolves.toEqual([{ id: "plain", name: "Plain", uri: "not a url", type_line: "Token" }]);
  });
});
