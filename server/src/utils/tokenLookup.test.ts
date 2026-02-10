import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Note: vi.mock() is hoisted, so any referenced values must be created via vi.hoisted().
const hoisted = vi.hoisted(() => {
  const mockClient = {
    searchCards: vi.fn(),
    getCardByName: vi.fn(),
  };
  return {
    mockClient,
    mockIsMicroserviceAvailable: vi.fn(),
    mockGetScryfallClient: vi.fn(() => mockClient),
    mockBatchFetchCards: vi.fn(),
  };
});

vi.mock("../services/scryfallMicroserviceClient.js", () => ({
  getScryfallClient: hoisted.mockGetScryfallClient,
  isMicroserviceAvailable: hoisted.mockIsMicroserviceAvailable,
}));

vi.mock("./getCardImagesPaged.js", () => ({
  batchFetchCards: hoisted.mockBatchFetchCards,
}));

vi.mock("./debug.js", () => ({
  debugLog: vi.fn(),
}));

import { fetchCardsForTokenLookup } from "./tokenLookup.js";

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

    const res = await fetchCardsForTokenLookup([{ name: "Sol Ring" } as any], "en");
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
        { name: "Sol Ring", set: "cm2", number: "229" } as any,
        { name: "Karn, Scion of Urza" } as any,
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
        { name: "Mystery Card" } as any,
        { name: "Sol Ring", set: "cm2", number: "229" } as any,
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
