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
});
