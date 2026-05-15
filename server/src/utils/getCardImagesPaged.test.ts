import { vi, describe, beforeEach, afterEach, it, expect, type Mock } from 'vitest';
import axios from "axios";
import {
  batchFetchCards,
  getCardsWithImagesForCardInfo,
  getImagesForCardInfo,
  getCardDataForCardInfo,
  getScryfallPngImagesForCard,
  getScryfallPngImagesForCardPrints,
  lookupCardFromBatch,
  type ScryfallApiCard,
} from "./getCardImagesPaged";

const dbMocks = vi.hoisted(() => ({
  lookupCardBySetNumber: vi.fn(),
  lookupCardByName: vi.fn(),
  insertOrUpdateCard: vi.fn(),
}));

vi.mock("../db/proxxiedCardLookup.js", () => dbMocks);

vi.mock("axios", () => {
  const mockGet = vi.fn();
  const mockPost = vi.fn();
  const mockInstance = { get: mockGet, post: mockPost };
  const mockCreate = vi.fn(() => mockInstance);
  return {
    create: mockCreate,
    get: mockGet,
    post: mockPost,
    default: {
      create: mockCreate,
      get: mockGet,
      post: mockPost,
    },
  };
});

// Access the mocked instance's get method
// Since create() returns the same mockInstance, we can grab it here.
const mockedAxiosInstance = axios.create() as unknown as { get: Mock; post: Mock };
const mockedAxios = {
  get: mockedAxiosInstance.get,
  post: mockedAxiosInstance.post,
  create: axios.create as Mock,
};

describe("getCardImagesPaged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAxios.create.mockClear();
    mockedAxios.get.mockReset();
    mockedAxios.post.mockReset();
    dbMocks.lookupCardBySetNumber.mockReset();
    dbMocks.lookupCardByName.mockReset();
    dbMocks.insertOrUpdateCard.mockReset();
  });

  // Mock Scryfall API response
  const mockScryfallResponse = (data: unknown[], has_more = false, next_page = "") => ({
    data: {
      object: "list",
      total_cards: data.length,
      has_more,
      next_page,
      data,
    },
  });

  const singleFaceCard = {
    name: "Sol Ring",
    image_uris: { png: "sol_ring_url" },
  };

  const doubleFaceCard = {
    name: "Valki // Tibalt",
    card_faces: [
      { image_uris: { png: "valki_url" } },
      { image_uris: { png: "tibalt_url" } },
    ],
  };

  describe("getImagesForCardInfo", () => {
    it("returns direct-id pngs before query strategies", async () => {
      mockedAxios.get.mockResolvedValue({ data: { id: "direct-id", image_uris: { png: "direct.png" } } });

      const urls = await getImagesForCardInfo({ name: "Direct", scryfallId: "direct-id" });

      expect(urls).toEqual(["direct.png"]);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
      expect(mockedAxios.get).toHaveBeenCalledWith("https://api.scryfall.com/cards/direct-id");
    });

    it("returns direct-id face pngs for double-faced cards", async () => {
      mockedAxios.get.mockResolvedValue({
        data: {
          id: "dfc-id",
          card_faces: [
            { image_uris: { png: "front.png" } },
            { image_uris: { png: "back.png" } },
          ],
        },
      });

      const urls = await getImagesForCardInfo({ name: "Valki", scryfallId: "dfc-id" });

      expect(urls).toEqual(["front.png", "back.png"]);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it("should fetch image by exact print first", async () => {
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([singleFaceCard]));
      const cardInfo = { name: "Sol Ring", set: "cmr", number: "332" };
      await getImagesForCardInfo(cardInfo, "prints");

      const expectedUrl =
        "https://api.scryfall.com/cards/search?q=set%3Acmr%20number%3A332%20name%3A%22Sol%20Ring%22%20include%3Aextras%20unique%3Aprints%20lang%3Aen";
      expect(mockedAxios.get).toHaveBeenCalledWith(expectedUrl);
    });

    it("should fall back to name-only query if set+number fails", async () => {
      mockedAxios.get
        .mockResolvedValueOnce(mockScryfallResponse([])) // Exact fails
        .mockResolvedValueOnce(mockScryfallResponse([singleFaceCard])); // name-only succeeds

      const cardInfo = { name: "Sol Ring", set: "cmr", number: "999" };
      await getImagesForCardInfo(cardInfo, "prints");

      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
      // First call for set+number+name
      expect(mockedAxios.get.mock.calls[0]?.[0]).toEqual(expect.stringContaining("set%3Acmr%20number%3A999"));
      // Second call for name-only
      expect(mockedAxios.get.mock.calls[1]?.[0]).toEqual(expect.stringContaining("!%22Sol%20Ring%22"));
    });

    it("should fall back to name-only query when set is not provided", async () => {
      mockedAxios.get.mockResolvedValueOnce(mockScryfallResponse([singleFaceCard])); // Name-only succeeds

      const cardInfo = { name: "Sol Ring", number: "999" };
      await getImagesForCardInfo(cardInfo, "prints");

      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
      expect(mockedAxios.get.mock.calls[0]?.[0]).toEqual(expect.stringContaining("!%22Sol%20Ring%22"));
    });

    it("should respect language preference", async () => {
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([singleFaceCard]));
      const cardInfo = { name: "Sol Ring" };
      await getImagesForCardInfo(cardInfo, "art", "de");

      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining("lang%3Ade"));
    });

    it("should fall back to english if language not found", async () => {
      mockedAxios.get
        .mockResolvedValueOnce(mockScryfallResponse([])) // German fails
        .mockResolvedValueOnce(mockScryfallResponse([singleFaceCard])); // English succeeds

      const cardInfo = { name: "Sol Ring" };
      await getImagesForCardInfo(cardInfo, "art", "de");

      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
      expect(mockedAxios.get.mock.calls[0]?.[0]).toEqual(expect.stringContaining("lang%3Ade"));
      expect(mockedAxios.get.mock.calls[1]?.[0]).toEqual(expect.stringContaining("lang%3Aen"));
    });

    it("should handle double-faced cards", async () => {
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([doubleFaceCard]));
      const cardInfo = { name: "Valki" };
      const urls = await getImagesForCardInfo(cardInfo);

      expect(urls).toEqual(["valki_url", "tibalt_url"]);
    }, 60000);

    it("should handle pagination", async () => {
      mockedAxios.get.mockClear();
      const page1 = [{ image_uris: { png: "page1_url" } }];
      const page2 = [{ image_uris: { png: "page2_url" } }];

      mockedAxios.get
        .mockResolvedValueOnce(mockScryfallResponse(page1, true, "next_page_url"))
        .mockResolvedValueOnce(mockScryfallResponse(page2));

      const cardInfo = { name: "Sol Ring" };
      const urls = await getImagesForCardInfo(cardInfo);

      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
      expect(mockedAxios.get.mock.calls[1]?.[0]).toBe("next_page_url");
      expect(urls).toEqual(["page1_url", "page2_url"]);
    }, 30000);

    it("should not fall back to English if fallbackToEnglish is false", async () => {
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([])); // Language query fails
      const cardInfo = { name: "Sol Ring" };
      await getImagesForCardInfo(cardInfo, "art", "de", false);

      expect(mockedAxios.get).toHaveBeenCalledTimes(1); // Only called for German
      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining("lang%3Ade"));
    });
  });

  describe("getCardDataForCardInfo", () => {
    it("should return a single card object", async () => {
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([singleFaceCard]));
      const cardInfo = { name: "Sol Ring" };
      const data = await getCardDataForCardInfo(cardInfo);

      expect(data).toEqual(singleFaceCard);
    }, 60000);

    it("should return null if no card is found", async () => {
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([]));
      const cardInfo = { name: "Nonexistent Card" };
      const data = await getCardDataForCardInfo(cardInfo);

      expect(data).toBeNull();
    });

    it("should prefer direct Scryfall id lookup for ambiguous token names", async () => {
      mockedAxios.get.mockResolvedValue({
        data: {
          id: "bba307eb-814c-4c87-acdf-b54c87d04f82",
          name: "Demon",
          set: "tdsk",
          collector_number: "9",
          image_uris: { png: "unholy_annex_demon_url" },
          type_line: "Token Creature — Demon",
          power: "6",
          toughness: "6",
        },
      });

      const cardInfo = {
        name: "Demon",
        isToken: true,
        scryfallId: "bba307eb-814c-4c87-acdf-b54c87d04f82",
      };

      const data = await getCardDataForCardInfo(cardInfo);
      expect(data).toEqual(expect.objectContaining({
        id: "bba307eb-814c-4c87-acdf-b54c87d04f82",
        set: "tdsk",
        collector_number: "9",
      }));
      expect(mockedAxios.get).toHaveBeenCalledWith(
        "https://api.scryfall.com/cards/bba307eb-814c-4c87-acdf-b54c87d04f82"
      );
    });
  });

  describe("lookupCardFromBatch", () => {
    it("should resolve by scryfallId before name fallback", () => {
      const batchResults = new Map<string, ScryfallApiCard>([
        ["demon", { id: "wrong-token-id", name: "Demon", set: "tfoo", collector_number: "1" }],
        ["id:bba307eb-814c-4c87-acdf-b54c87d04f82", { id: "bba307eb-814c-4c87-acdf-b54c87d04f82", name: "Demon", set: "tdsk", collector_number: "9" }],
      ]);

      const found = lookupCardFromBatch(batchResults, {
        name: "Demon",
        isToken: true,
        scryfallId: "bba307eb-814c-4c87-acdf-b54c87d04f82",
      });

      expect(found).toEqual(expect.objectContaining({
        id: "bba307eb-814c-4c87-acdf-b54c87d04f82",
        set: "tdsk",
        collector_number: "9",
      }));
    });
  });

  describe("getScryfallPngImagesForCard", () => {
    it("should call with unique=art by default", async () => {
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([singleFaceCard]));
      await getScryfallPngImagesForCard("Sol Ring");
      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining("unique%3Aart"));
    }, 60000);

    it("should respect the unique parameter", async () => {
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([singleFaceCard]));
      await getScryfallPngImagesForCard("Sol Ring", "prints");
      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining("unique%3Aprints"));
    }, 60000);
  });

  describe("getScryfallPngImagesForCardPrints", () => {
    it("should call with unique=prints", async () => {
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([singleFaceCard]));
      await getScryfallPngImagesForCardPrints("Sol Ring");
      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining("unique%3Aprints"));
    }, 60000);
  });

  describe("Error Handling", () => {
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.useFakeTimers();
      consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    });

    afterEach(() => {
      vi.useRealTimers();
      consoleWarnSpy.mockRestore();
    });

    it("getImagesForCardInfo should return an empty array on API error", async () => {
      mockedAxios.get.mockClear();
      mockedAxios.get.mockRejectedValue(new Error("Scryfall API is down"));
      const cardInfo = { name: "Sol Ring" };

      // Run the function and advance timers to resolve the delay
      const promise = getImagesForCardInfo(cardInfo);
      await vi.runAllTimersAsync();
      const urls = await promise;

      expect(urls).toEqual([]);
      expect(consoleWarnSpy).toHaveBeenCalled();
    });


    it("getCardDataForCardInfo should return null on API error", async () => {
      mockedAxios.get.mockClear();
      mockedAxios.get.mockRejectedValue(new Error("Scryfall API is down"));
      const cardInfo = { name: "Sol Ring" };

      // Run the function and advance timers to resolve the delay
      const promise = getCardDataForCardInfo(cardInfo);
      await vi.runAllTimersAsync();
      const data = await promise;

      expect(data).toBeNull();
      expect(consoleWarnSpy).toHaveBeenCalled();
    });
  });

  describe("Additional Strategies", () => {
    it("getImagesForCardInfo should use Set + Name strategy when number is missing", async () => {
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([singleFaceCard]));
      const cardInfo = { name: "Sol Ring", set: "cmr" };
      await getImagesForCardInfo(cardInfo, "prints");

      const expectedUrlPart = "set%3Acmr%20name%3A%22Sol%20Ring%22";
      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining(expectedUrlPart));
    }, 60000);

    it("getCardDataForCardInfo should use Set + Number strategy", async () => {
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([singleFaceCard]));
      const cardInfo = { name: "Sol Ring", set: "cmr", number: "332" };
      await getCardDataForCardInfo(cardInfo);

      const expectedUrlPart = "set%3Acmr%20number%3A332";
      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining(expectedUrlPart));
    }, 60000);

    it("getCardDataForCardInfo should use Set + Name strategy", async () => {
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([singleFaceCard]));
      const cardInfo = { name: "Sol Ring", set: "cmr" };
      await getCardDataForCardInfo(cardInfo);

      const expectedUrlPart = "set%3Acmr%20name%3A%22Sol%20Ring%22";
      expect(mockedAxios.get).toHaveBeenCalledWith(expect.stringContaining(expectedUrlPart));
    });

    it("getCardDataForCardInfo should handle null cardInfo", async () => {
      mockedAxios.get.mockClear();
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([]));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await getCardDataForCardInfo(null as any);
      expect(result).toBeNull();
    });

    it("getCardDataForCardInfo should return null if strategy 1 returns empty", async () => {
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([]));
      const cardInfo = { name: "Card", set: "SET", number: "123" };
      const result = await getCardDataForCardInfo(cardInfo);
      expect(result).toBeNull();
    }, 60000);

    it("getCardDataForCardInfo should return null if strategy 2 returns empty", async () => {
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([]));
      const cardInfo = { name: "Card", set: "SET" };
      const result = await getCardDataForCardInfo(cardInfo);
      expect(result).toBeNull();
    });

    it("getCardDataForCardInfo should filter art-series exact hits and return fuzzy real cards", async () => {
      const artSeriesTypeLine: ScryfallApiCard = {
        name: "Sol Ring",
        type_line: "Card // Card",
        set: "asld",
        rarity: "common",
        cmc: 0,
      };
      const artSeriesSet: ScryfallApiCard = {
        name: "Sol Ring",
        type_line: "Artifact",
        set: "aclt",
        rarity: "common",
        cmc: 0,
      };
      const realFuzzy: ScryfallApiCard = {
        name: "Sol Ring",
        type_line: "Artifact",
        set: "cmr",
        rarity: "uncommon",
        cmc: 1,
      };
      mockedAxios.get
        .mockResolvedValueOnce(mockScryfallResponse([artSeriesTypeLine, artSeriesSet]))
        .mockResolvedValueOnce(mockScryfallResponse([realFuzzy]));

      const result = await getCardDataForCardInfo({ name: "Sol Ring" });

      expect(result).toBe(realFuzzy);
      expect(mockedAxios.get.mock.calls[1]?.[0]).toEqual(expect.stringContaining("name%3A%22Sol%20Ring%22"));
    });

    it("getImagesForCardInfo should return empty array if strategy 1 returns empty", async () => {
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([]));
      const cardInfo = { name: "Card", set: "SET", number: "123" };
      const result = await getImagesForCardInfo(cardInfo);
      expect(result).toEqual([]);
    });

    it("getImagesForCardInfo should return empty array if strategy 2 returns empty", async () => {
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([]));
      const cardInfo = { name: "Card", set: "SET" };
      const result = await getImagesForCardInfo(cardInfo, "prints");
      expect(result).toEqual([]);
    }, 60000);
  });

  describe("batchFetchCards", () => {
    it("returns an empty map for empty input without hitting the database or network", async () => {
      const result = await batchFetchCards([]);

      expect(result.size).toBe(0);
      expect(dbMocks.lookupCardByName).not.toHaveBeenCalled();
      expect(mockedAxios.get).not.toHaveBeenCalled();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("uses local set/number cache hits and indexes names, print ids, and face names", async () => {
      const cachedCard: ScryfallApiCard = {
        id: "cached-id",
        name: "Valki // Tibalt",
        set: "khm",
        collector_number: "114",
        card_faces: [{ name: "Valki" }, { name: "Tibalt" }],
      };
      dbMocks.lookupCardBySetNumber.mockReturnValue(cachedCard);

      const result = await batchFetchCards([
        { name: "Valki", set: "KHM", number: "114" },
      ]);

      expect(dbMocks.lookupCardBySetNumber).toHaveBeenCalledWith("KHM", "114", "en");
      expect(result.get("valki // tibalt")).toBe(cachedCard);
      expect(result.get("khm:114")).toBe(cachedCard);
      expect(result.get("id:cached-id")).toBe(cachedCard);
      expect(result.get("valki")).toBe(cachedCard);
      expect(result.get("tibalt")).toBe(cachedCard);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("uses local name cache hits with the requested language", async () => {
      const cachedCard: ScryfallApiCard = {
        id: "cached-name-id",
        name: "Sonnenring",
        lang: "de",
      };
      dbMocks.lookupCardByName.mockReturnValue(cachedCard);

      const result = await batchFetchCards([{ name: "Sol Ring" }], "DE");

      expect(dbMocks.lookupCardByName).toHaveBeenCalledWith("Sol Ring", "de");
      expect(result.get("sonnenring")).toBe(cachedCard);
      expect(result.get("id:cached-name-id")).toBe(cachedCard);
      expect(mockedAxios.get).not.toHaveBeenCalled();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("fetches regular cards through the collection API and caches all lookup aliases", async () => {
      dbMocks.lookupCardByName.mockReturnValue(null);
      const fetchedCard: ScryfallApiCard = {
        id: "sol-id",
        name: "Sol Ring",
        set: "cmr",
        collector_number: "332",
        image_uris: { png: "sol.png" },
      };
      mockedAxios.post.mockResolvedValue({ data: { data: [fetchedCard], not_found: [] } });

      const result = await batchFetchCards([
        { name: "Sol Ring", set: "CMR", number: "332" },
        { name: "Island" },
        { name: "By Id", scryfallId: "uuid-1" },
      ]);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        "https://api.scryfall.com/cards/collection",
        {
          identifiers: [
            { set: "cmr", collector_number: "332" },
            { name: "Island" },
            { id: "uuid-1" },
          ],
        }
      );
      expect(result.get("sol ring")).toBe(fetchedCard);
      expect(result.get("cmr:332")).toBe(fetchedCard);
      expect(result.get("id:sol-id")).toBe(fetchedCard);
      expect(dbMocks.insertOrUpdateCard).toHaveBeenCalledWith(fetchedCard);
    });

    it("indexes regular double-faced collection cards by face names", async () => {
      dbMocks.lookupCardByName.mockReturnValue(null);
      const fetchedCard: ScryfallApiCard = {
        id: "dfc-id",
        name: "Valki // Tibalt",
        set: "khm",
        collector_number: "114",
        card_faces: [{ name: "Valki" }, { name: "Tibalt" }],
      };
      mockedAxios.post.mockResolvedValue({ data: { data: [fetchedCard], not_found: [] } });

      const result = await batchFetchCards([{ name: "Valki", set: "KHM" }]);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        "https://api.scryfall.com/cards/collection",
        { identifiers: [{ name: "Valki", set: "khm" }] }
      );
      expect(result.get("valki")).toBe(fetchedCard);
      expect(result.get("tibalt")).toBe(fetchedCard);
    });

    it("fetches successful token batches and ignores duplicate names or nameless rows", async () => {
      dbMocks.lookupCardByName.mockReturnValue(null);
      const firstToken: ScryfallApiCard = {
        id: "first-token",
        name: "Goblin",
        type_line: "Token Creature — Goblin",
      };
      const duplicateToken: ScryfallApiCard = {
        id: "duplicate-token",
        name: "Goblin",
        type_line: "Token Creature — Goblin",
      };
      mockedAxios.get.mockResolvedValue({
        data: { data: [firstToken, duplicateToken, { id: "nameless" }] },
      });

      const result = await batchFetchCards([{ name: 'Goblin "Rabblemaster"', isToken: true }]);

      expect(mockedAxios.get).toHaveBeenCalledWith(
        "https://api.scryfall.com/cards/search",
        {
          params: {
            q: '(name:"Goblin \\"Rabblemaster\\"") type:token include:extras',
            unique: "prints",
          },
        }
      );
      expect(result.get("goblin")).toBe(firstToken);
      expect(result.get("id:first-token")).toBe(firstToken);
      expect(result.get("id:duplicate-token")).toBeUndefined();
      expect(dbMocks.insertOrUpdateCard).toHaveBeenCalledTimes(1);
    });

    it("fetches token batches with type filters and falls back to individual token queries on batch failure", async () => {
      dbMocks.lookupCardByName.mockReturnValue(null);
      const goblinToken: ScryfallApiCard = {
        id: "goblin-id",
        name: "Goblin",
        type_line: "Token Creature — Goblin",
      };

      mockedAxios.get
        .mockRejectedValueOnce(new Error("query too long"))
        .mockResolvedValueOnce({ data: { data: [goblinToken] } })
        .mockRejectedValueOnce(new Error("still down"));

      const result = await batchFetchCards([
        { name: "Goblin", isToken: true },
        { name: "Soldier", isToken: true },
      ]);

      expect(mockedAxios.get).toHaveBeenNthCalledWith(
        1,
        "https://api.scryfall.com/cards/search",
        {
          params: {
            q: '(name:"Goblin" OR name:"Soldier") type:token include:extras',
            unique: "prints",
          },
        }
      );
      expect(mockedAxios.get).toHaveBeenNthCalledWith(
        2,
        "https://api.scryfall.com/cards/search",
        {
          params: {
            q: '!"Goblin" type:token include:extras',
            unique: "prints",
          },
        }
      );
      expect(result.get("goblin")).toBe(goblinToken);
      expect(result.get("id:goblin-id")).toBe(goblinToken);
      expect(dbMocks.insertOrUpdateCard).toHaveBeenCalledWith(goblinToken);
    });

    it("replaces English batch results with localized cards when requested", async () => {
      dbMocks.lookupCardByName.mockReturnValue(null);
      const englishCard: ScryfallApiCard = {
        id: "english-id",
        name: "Sol Ring",
        set: "cmr",
        collector_number: "332",
        lang: "en",
        image_uris: { png: "english.png" },
      };
      const localizedCard: ScryfallApiCard = {
        id: "german-id",
        name: "Sonnenring",
        set: "cmr",
        collector_number: "332",
        lang: "de",
        image_uris: { png: "german.png" },
      };
      mockedAxios.post.mockResolvedValue({ data: { data: [englishCard], not_found: [] } });
      mockedAxios.get.mockResolvedValue({ data: localizedCard });

      const result = await batchFetchCards([{ name: "Sol Ring" }], "de");

      expect(mockedAxios.get).toHaveBeenCalledWith("https://api.scryfall.com/cards/cmr/332/de");
      expect(result.get("Scryfall Batch")).toBeUndefined();
      expect(result.get("sonnenring")).toBe(localizedCard);
      expect(result.get("cmr:332")).toBe(localizedCard);
      expect(result.get("id:german-id")).toBe(localizedCard);
      expect(dbMocks.insertOrUpdateCard).toHaveBeenCalledWith(localizedCard);
    });

    it("skips localization lookups for cards already in the requested language", async () => {
      dbMocks.lookupCardByName.mockReturnValue(null);
      const germanCard: ScryfallApiCard = {
        id: "german-id",
        name: "Sonnenring",
        set: "cmr",
        collector_number: "332",
        lang: "de",
        image_uris: { png: "german.png" },
      };
      mockedAxios.post.mockResolvedValue({ data: { data: [germanCard], not_found: [] } });

      const result = await batchFetchCards([{ name: "Sol Ring" }], "de");

      expect(mockedAxios.get).not.toHaveBeenCalled();
      expect(result.get("sonnenring")).toBe(germanCard);
    });

    it("keeps English aliases when a localization response has no png", async () => {
      dbMocks.lookupCardByName.mockReturnValue(null);
      const englishCard: ScryfallApiCard = {
        id: "english-id",
        name: "Sol Ring",
        set: "cmr",
        collector_number: "332",
        lang: "en",
        image_uris: { png: "english.png" },
      };
      mockedAxios.post.mockResolvedValue({ data: { data: [englishCard], not_found: [] } });
      mockedAxios.get.mockResolvedValue({ data: { ...englishCard, id: "no-png", image_uris: undefined } });

      const result = await batchFetchCards([{ name: "Sol Ring" }], "de");

      expect(result.get("sol ring")).toBe(englishCard);
      expect(result.get("cmr:332")).toBe(englishCard);
      expect(result.get("id:no-png")).toBeUndefined();
    });

    it("keeps English results when collection or localization calls fail", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
      dbMocks.lookupCardByName.mockReturnValue(null);
      mockedAxios.post.mockRejectedValueOnce(new Error("collection down"));

      const failedCollection = await batchFetchCards([{ name: "Sol Ring" }]);

      expect(failedCollection.size).toBe(0);
      expect(consoleErrorSpy).toHaveBeenCalledWith("[Scryfall Batch] Batch 1 failed:", "collection down");

      const englishCard: ScryfallApiCard = {
        id: "english-id",
        name: "Sol Ring",
        set: "cmr",
        collector_number: "332",
        lang: "en",
        image_uris: { png: "english.png" },
      };
      mockedAxios.post.mockReset();
      mockedAxios.get.mockReset();
      consoleErrorSpy.mockClear();
      mockedAxios.post.mockResolvedValue({ data: { data: [englishCard], not_found: [] } });
      mockedAxios.get.mockRejectedValueOnce(new Error("no localized print"));

      const localizedFallback = await batchFetchCards([{ name: "Sol Ring" }], "de");

      expect(localizedFallback.get("sol ring")).toBe(englishCard);
      expect(localizedFallback.get("cmr:332")).toBe(englishCard);
      consoleErrorSpy.mockRestore();
    });
  });

  describe("lookupCardFromBatch fallback order", () => {
    it("uses set/number before lower-case name fallback and returns undefined when absent", () => {
      const byName: ScryfallApiCard = { id: "name-id", name: "Sol Ring" };
      const byPrint: ScryfallApiCard = {
        id: "print-id",
        name: "Sol Ring",
        set: "cmr",
        collector_number: "332",
      };
      const batchResults = new Map<string, ScryfallApiCard>([
        ["sol ring", byName],
        ["cmr:332", byPrint],
      ]);

      expect(lookupCardFromBatch(batchResults, { name: "Sol Ring", set: "CMR", number: "332" })).toBe(byPrint);
      expect(lookupCardFromBatch(batchResults, { name: "Sol Ring" })).toBe(byName);
      expect(lookupCardFromBatch(batchResults, { name: "Island" })).toBeUndefined();
    });
  });

  describe("getCardsWithImagesForCardInfo", () => {
    it("prefers direct Scryfall id lookups and returns a single card", async () => {
      const card: ScryfallApiCard = { id: "direct-id", name: "Direct Card" };
      mockedAxios.get.mockResolvedValue({ data: card });

      const result = await getCardsWithImagesForCardInfo({ name: "Direct Card", scryfallId: "direct-id" });

      expect(result).toEqual([card]);
      expect(mockedAxios.get).toHaveBeenCalledWith("https://api.scryfall.com/cards/direct-id");
    });

    it("falls through from failed direct id to exact print search", async () => {
      const card: ScryfallApiCard = { id: "print-id", name: "Sol Ring", set: "cmr", collector_number: "332" };
      mockedAxios.get
        .mockRejectedValueOnce(new Error("direct id gone"))
        .mockResolvedValueOnce(mockScryfallResponse([card]));

      const result = await getCardsWithImagesForCardInfo({
        name: "Sol Ring",
        set: "cmr",
        number: "332",
        scryfallId: "direct-id",
      });

      expect(result).toEqual([card]);
      expect(mockedAxios.get.mock.calls[1]?.[0]).toEqual(expect.stringContaining("set%3Acmr%20number%3A332"));
    });

    it("uses set/name strategy and then name-only token strategy when broader fallback is needed", async () => {
      const tokenCard: ScryfallApiCard = { id: "token-id", name: "Goblin", type_line: "Token Creature — Goblin" };
      mockedAxios.get
        .mockResolvedValueOnce(mockScryfallResponse([]))
        .mockResolvedValueOnce(mockScryfallResponse([tokenCard]));

      const result = await getCardsWithImagesForCardInfo({ name: "Goblin", set: "tfoo", isToken: true }, "prints");

      expect(result).toEqual([tokenCard]);
      expect(mockedAxios.get.mock.calls[0]?.[0]).toEqual(expect.stringContaining("set%3Atfoo%20name%3A%22Goblin%22%20type%3Atoken"));
      expect(mockedAxios.get.mock.calls[1]?.[0]).toEqual(expect.stringContaining("!%22Goblin%22%20type%3Atoken"));
    });

    it("sorts exact and face-name matches ahead of art series results", async () => {
      const artSeries: ScryfallApiCard = { id: "art-id", name: "Sol Ring", layout: "art_series" };
      const unrelated: ScryfallApiCard = { id: "other-id", name: "Some Other Card" };
      const faceMatch: ScryfallApiCard = { id: "face-id", name: "Valki // Tibalt" };
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([artSeries, unrelated, faceMatch]));

      const result = await getCardsWithImagesForCardInfo({ name: "Valki" });

      expect(result.map((card) => card.id)).toEqual(["face-id", "other-id", "art-id"]);
    });

    it("scores DFC query names against one-faced result names", async () => {
      const frontOnly: ScryfallApiCard = { id: "front-id", name: "Valki" };
      const unrelated: ScryfallApiCard = { id: "other-id", name: "Some Other Card" };
      mockedAxios.get.mockResolvedValue(mockScryfallResponse([unrelated, frontOnly]));

      const result = await getCardsWithImagesForCardInfo({ name: "Valki // Tibalt" });

      expect(result.map((card) => card.id)).toEqual(["front-id", "other-id"]);
    });

    it("deduplicates concurrent identical card searches", async () => {
      let resolveSearch: (value: unknown) => void = () => { };
      mockedAxios.get.mockReturnValue(
        new Promise((resolve) => {
          resolveSearch = resolve;
        })
      );

      const first = getCardsWithImagesForCardInfo({ name: "Sol Ring" });
      const second = getCardsWithImagesForCardInfo({ name: "Sol Ring" });

      resolveSearch(mockScryfallResponse([singleFaceCard]));

      await expect(Promise.all([first, second])).resolves.toEqual([[singleFaceCard], [singleFaceCard]]);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });
  });
});
