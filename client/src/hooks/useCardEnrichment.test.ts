import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { useCardEnrichment } from "./useCardEnrichment";

const mockFetch = vi.hoisted(() => vi.fn());
const mockShowMetadataToast = vi.hoisted(() => vi.fn());
const mockHideMetadataToast = vi.hoisted(() => vi.fn());
const mockMarkEnrichmentComplete = vi.hoisted(() => vi.fn());
const mockGetCurrentSession = vi.hoisted(() => vi.fn(() => ({ markEnrichmentComplete: mockMarkEnrichmentComplete })));
const mockGetAbortController = vi.hoisted(() => vi.fn());
const mockSearchMpcAutofill = vi.hoisted(() => vi.fn());
const mockGetMpcAutofillImageUrl = vi.hoisted(() => vi.fn());
const mockAddRemoteImage = vi.hoisted(() => vi.fn());
const mockPickBestMpcCard = vi.hoisted(() => vi.fn());
const mockIsCardbackId = vi.hoisted(() => vi.fn(() => false));
const mockUseSettingsGetState = vi.hoisted(() => vi.fn(() => ({
  preferredArtSource: "scryfall",
  favoriteMpcSources: [],
  favoriteMpcTags: [],
})));

const mockCardsToArray = vi.hoisted(() => vi.fn());
const mockCardsCount = vi.hoisted(() => vi.fn());
const mockCardsBulkUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCardsBulkAdd = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCardsBulkGet = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockCardsWhere = vi.hoisted(() => vi.fn());
const mockCardsHook = vi.hoisted(() => vi.fn());
const mockMetadataWhere = vi.hoisted(() => vi.fn());
const mockMetadataUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockMetadataBulkPut = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockTransaction = vi.hoisted(() => vi.fn(async (_mode: unknown, _table: unknown, fn: () => Promise<void>) => fn()));
let lastCreatingHookHandler: ((...args: unknown[]) => unknown) | null = null;

vi.mock("../db", () => ({
  METADATA_CACHE_VERSION: 1,
  db: {
    cards: {
      toArray: mockCardsToArray,
      where: mockCardsWhere,
      bulkUpdate: mockCardsBulkUpdate,
      bulkAdd: mockCardsBulkAdd,
      bulkGet: mockCardsBulkGet,
      hook: mockCardsHook,
    },
    cardMetadataCache: {
      where: mockMetadataWhere,
      update: mockMetadataUpdate,
      bulkPut: mockMetadataBulkPut,
    },
    transaction: mockTransaction,
  },
}));

vi.mock("../helpers/importSession", () => ({
  getCurrentSession: mockGetCurrentSession,
}));

vi.mock("../helpers/cancellationService", () => ({
  getEnrichmentAbortController: mockGetAbortController,
}));

vi.mock("../helpers/cardbackLibrary", () => ({
  isCardbackId: mockIsCardbackId,
}));

vi.mock("../helpers/mpcAutofillApi", () => ({
  searchMpcAutofill: mockSearchMpcAutofill,
  getMpcAutofillImageUrl: mockGetMpcAutofillImageUrl,
}));

vi.mock("../helpers/dbUtils", () => ({
  addRemoteImage: mockAddRemoteImage,
}));

vi.mock("../helpers/mpcImportIntegration", () => ({
  pickBestMpcCard: mockPickBestMpcCard,
}));

vi.mock("../store", () => ({
  useSettingsStore: { getState: mockUseSettingsGetState },
}));

vi.mock("../store/toast", () => ({
  useToastStore: {
    getState: () => ({
      showMetadataToast: mockShowMetadataToast,
      hideMetadataToast: mockHideMetadataToast,
    }),
  },
}));

vi.mock("../constants", () => ({
  API_BASE: "https://example.test",
}));

vi.stubGlobal("fetch", mockFetch);

describe("useCardEnrichment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    lastCreatingHookHandler = null;
    mockGetAbortController.mockReturnValue({
      signal: { aborted: false },
      abort: vi.fn(),
    });
    mockCardsToArray.mockResolvedValue([]);
    mockCardsCount.mockResolvedValue(0);
    mockCardsWhere.mockReturnValue({
      equals: () => ({
        count: mockCardsCount,
      }),
    });
    mockMetadataWhere.mockReturnValue({
      equals: () => ({
        and: () => ({
          first: vi.fn().mockResolvedValue(null),
        }),
      }),
    });
    mockCardsHook.mockImplementation(() => ({
      unsubscribe: vi.fn(),
    }));
    mockCardsHook.mockImplementation((event: string, handler?: (...args: unknown[]) => unknown) => {
      if (event === "creating" && handler) {
        lastCreatingHookHandler = handler;
      }
      return {
        unsubscribe: vi.fn(),
      };
    });
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([]),
    } as Response);
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => "uuid-1"),
    });
  });

  it("does nothing when there are no cards awaiting enrichment", async () => {
    const { result } = renderHook(() => useCardEnrichment());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
    });

    expect(mockCardsCount).toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockShowMetadataToast).not.toHaveBeenCalled();
    expect(result.current.enrichmentProgress).toBeNull();
  });

  it("fetches enrichment data, updates cards, and marks completion", async () => {
    const card = {
      uuid: "card-1",
      name: "Sample Card",
      set: "SET",
      number: "1",
      order: 1,
      needsEnrichment: 1,
      linkedFrontId: null,
      linkedBackId: null,
      imageId: null,
      isUserUpload: false,
      enrichmentRetryCount: 0,
    };

    mockCardsToArray.mockResolvedValue([card]);
    mockCardsCount.mockResolvedValue(1);
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{
        name: "Sample Card",
        set: "SET",
        number: "1",
        colors: ["U"],
        cmc: 2,
        rarity: "common",
        lang: "en",
        type_line: "Creature — Test",
      }]),
    } as Response);

    const { result } = renderHook(() => useCardEnrichment());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockCardsBulkUpdate).toHaveBeenCalled();
    expect(mockHideMetadataToast).toHaveBeenCalled();

    expect(mockShowMetadataToast).toHaveBeenCalled();
    expect(mockMarkEnrichmentComplete).toHaveBeenCalled();
    expect(mockMetadataBulkPut).toHaveBeenCalledTimes(1);
    expect(mockTransaction).toHaveBeenCalled();
    expect(result.current.enrichmentProgress).toBeNull();
  });

  it("skips cards that are already processed or linked to a front face", async () => {
    mockCardsToArray.mockResolvedValue([
      {
        uuid: "card-processed",
        name: "Processed Card",
        set: "SET",
        number: "1",
        order: 1,
        needsEnrichment: 1,
        linkedFrontId: "front-1",
        linkedBackId: null,
        imageId: null,
        isUserUpload: false,
        enrichmentRetryCount: 0,
      },
      {
        uuid: "card-cardback",
        name: "Cardback",
        set: "SET",
        number: "2",
        order: 2,
        needsEnrichment: 1,
        linkedFrontId: null,
        linkedBackId: null,
        imageId: "cardback_blank",
        isUserUpload: false,
        enrichmentRetryCount: 0,
      },
    ]);
    mockCardsCount.mockResolvedValue(2);
    mockIsCardbackId.mockReturnValue(true);

    const { result } = renderHook(() => useCardEnrichment());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockShowMetadataToast).not.toHaveBeenCalled();
    expect(result.current.enrichmentProgress).toBeNull();
  });

  it("reuses cached metadata without fetching", async () => {
    const card = {
      uuid: "card-cached",
      name: "Cached Card",
      set: "SET",
      number: "3",
      order: 1,
      needsEnrichment: 1,
      linkedFrontId: null,
      linkedBackId: null,
      imageId: null,
      isUserUpload: false,
      enrichmentRetryCount: 0,
    };

    mockCardsToArray.mockResolvedValue([card]);
    mockCardsCount.mockResolvedValue(1);
    mockMetadataWhere.mockReturnValue({
      equals: () => ({
        and: () => ({
          first: vi.fn().mockResolvedValue({
            id: "cache-1",
            cacheVersion: 1,
            data: {
              name: "Cached Card",
              set: "SET",
              number: "3",
              colors: ["G"],
              cmc: 1,
              rarity: "common",
              lang: "en",
              type_line: "Creature — Test",
            },
          }),
        }),
      }),
    });

    const { result } = renderHook(() => useCardEnrichment());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockMetadataUpdate).toHaveBeenCalledWith("cache-1", { cachedAt: expect.any(Number) });
    expect(mockCardsBulkUpdate).toHaveBeenCalled();
    expect(mockHideMetadataToast).toHaveBeenCalled();
    expect(mockShowMetadataToast).toHaveBeenCalled();
    expect(result.current.enrichmentProgress).toBeNull();
  });

  it("marks a failed batch for retry when the server rejects the request", async () => {
    const card = {
      uuid: "card-failed",
      name: "Broken Card",
      set: "SET",
      number: "4",
      order: 1,
      needsEnrichment: 1,
      linkedFrontId: null,
      linkedBackId: null,
      imageId: null,
      isUserUpload: false,
      enrichmentRetryCount: 0,
    };

    mockCardsToArray.mockResolvedValue([card]);
    mockCardsCount.mockResolvedValue(1);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: vi.fn(),
    } as Response);

    renderHook(() => useCardEnrichment());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(mockCardsBulkUpdate).toHaveBeenCalledWith([
      expect.objectContaining({
        key: "card-failed",
        changes: expect.objectContaining({
          needsEnrichment: false,
          enrichmentRetryCount: 1,
        }),
      }),
    ]);
  });

  it("covers DFC art lookup, existing back card updates, and back-face import cleanup", async () => {
    const card = {
      uuid: "card-dfc",
      name: "Back Face",
      set: "SET",
      number: "5",
      order: 1,
      needsEnrichment: 1,
      linkedFrontId: null,
      linkedBackId: "back-1",
      imageId: null,
      isUserUpload: false,
      enrichmentRetryCount: 0,
    };
    const existingBack = {
      uuid: "back-1",
      name: "Old Back",
      set: "SET",
      number: "5",
      order: 2,
      linkedFrontId: "card-dfc",
      linkedBackId: null,
      imageId: null,
      usesDefaultCardback: true,
      isUserUpload: false,
    };

    mockUseSettingsGetState.mockReturnValue({
      preferredArtSource: "scryfall",
      favoriteMpcSources: [],
      favoriteMpcTags: [],
    });
    mockCardsToArray.mockResolvedValue([card]);
    mockCardsCount.mockResolvedValue(1);
    mockCardsBulkGet.mockResolvedValue([existingBack]);
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([
        {
          name: "Front Face",
          set: "SET",
          number: "5",
          colors: ["G"],
          cmc: 4,
          rarity: "rare",
          lang: "en",
          type_line: "Creature — Front",
          layout: "transform",
          card_faces: [
            {
              name: "Front Face",
              type_line: "Creature — Front",
              mana_cost: "{2}{G}",
              colors: ["G"],
              image_uris: {
                large: "https://example.test/front-large.png",
              },
            },
            {
              name: "Back Face",
              type_line: "Creature — Back",
              mana_cost: "{3}{U}",
              colors: ["U"],
              image_uris: {
                large: "https://example.test/back-large.png",
              },
            },
          ],
        },
      ]),
    } as Response);
    mockAddRemoteImage
      .mockResolvedValueOnce("front-image")
      .mockResolvedValueOnce("back-image");

    renderHook(() => useCardEnrichment());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
    });

    expect(mockCardsBulkGet).toHaveBeenCalledWith(["back-1"]);
    expect(mockAddRemoteImage).toHaveBeenNthCalledWith(1, ["https://example.test/back-large.png"], 1);
    expect(mockAddRemoteImage).toHaveBeenNthCalledWith(2, ["https://example.test/front-large.png"], 1);
    expect(mockCardsBulkAdd).not.toHaveBeenCalled();
    expect(mockCardsBulkUpdate).toHaveBeenCalled();
    expect(mockHideMetadataToast).toHaveBeenCalled();
    expect(mockMarkEnrichmentComplete).toHaveBeenCalled();
  });

  it("marks a card finished when retry attempts are exhausted", async () => {
    const card = {
      uuid: "card-exhausted",
      name: "Exhausted Card",
      set: "SET",
      number: "6",
      order: 1,
      needsEnrichment: 1,
      linkedFrontId: null,
      linkedBackId: null,
      imageId: null,
      isUserUpload: false,
      enrichmentRetryCount: 2,
    };

    mockCardsToArray.mockResolvedValue([card]);
    mockCardsCount.mockResolvedValue(1);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: vi.fn(),
    } as Response);

    renderHook(() => useCardEnrichment());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
    });

    expect(mockCardsBulkUpdate).toHaveBeenCalledWith([
      expect.objectContaining({
        key: "card-exhausted",
        changes: expect.objectContaining({
          needsEnrichment: false,
          enrichmentRetryCount: 3,
        }),
      }),
    ]);
  });

  it("cleans up the db hook timeout and cancels enrichment", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const abortSpy = vi.fn();
    mockGetAbortController.mockReturnValue({
      signal: { aborted: false },
      abort: abortSpy,
    });

    const { result, unmount } = renderHook(() => useCardEnrichment());

    expect(typeof lastCreatingHookHandler).toBe("function");

    act(() => {
      lastCreatingHookHandler?.();
    });

    await act(async () => {
      unmount();
    });

    act(() => {
      result.current.cancelEnrichment();
    });

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(abortSpy).toHaveBeenCalled();
    expect(mockHideMetadataToast).not.toHaveBeenCalled();
  });
});
