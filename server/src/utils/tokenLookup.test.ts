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

describe("fetchCardsForTokenLookup", () => {
  const env = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.clearAllMocks();
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
