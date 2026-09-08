import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const pagedGet = vi.fn();
  const bulkGet = vi.fn();
  const post = vi.fn();
  const create = vi.fn(() => ({ get: pagedGet, post }));
  return { pagedGet, bulkGet, post, create };
});

vi.mock("axios", () => ({
  default: { create: mocks.create, get: mocks.bulkGet, post: mocks.post },
  create: mocks.create,
}));

vi.mock("../db/db.js", () => ({ getDatabase: vi.fn() }));
vi.mock("../db/proxxiedCardLookup.js", () => ({
  lookupCardBySetNumber: vi.fn(),
  lookupCardByName: vi.fn(),
  insertOrUpdateCard: vi.fn(),
  batchInsertCards: vi.fn(),
  getCardCount: vi.fn(),
}));

import { getBulkDataInfo } from "../services/bulkDataService.js";
import { getImagesForCardInfo } from "./getCardImagesPaged.js";
import { initCatalogs } from "./scryfallCatalog.js";

describe("shared Scryfall broker callers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps catalog, paged-card, and bulk metadata requests single-active and 100ms spaced", async () => {
    let active = 0;
    let maximumActive = 0;
    const dispatches: Array<{ caller: string; at: number }> = [];
    const physical = <T>(caller: string, value: T): Promise<T> => new Promise((resolve) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      dispatches.push({ caller, at: Date.now() });
      queueMicrotask(() => {
        active -= 1;
        resolve(value);
      });
    });

    vi.stubGlobal("fetch", vi.fn((url: string) => physical("catalog", {
      json: () => Promise.resolve({ data: [url] }),
    })));
    mocks.pagedGet.mockImplementation(() => physical("paged", {
      data: { data: [{ image_uris: { png: "paged.png" } }], has_more: false, next_page: null },
    }));
    mocks.bulkGet.mockImplementation(() => physical("bulk", {
      data: { download_uri: "https://cdn.scryfall.io/all-cards.json", size: 1 },
    }));

    const catalog = initCatalogs();
    const paged = getImagesForCardInfo({ name: "Paged" });
    const bulk = getBulkDataInfo();

    await vi.runAllTimersAsync();
    await expect(Promise.all([catalog, paged, bulk])).resolves.toEqual([
      undefined,
      ["paged.png"],
      { download_uri: "https://cdn.scryfall.io/all-cards.json", size: 1 },
    ]);

    expect(maximumActive).toBe(1);
    expect(dispatches).toHaveLength(11);
    expect(dispatches.slice(0, 9).map(({ caller }) => caller)).toEqual(Array(9).fill("catalog"));
    expect(dispatches.slice(9)).toEqual([
      { caller: "paged", at: 900 },
      { caller: "bulk", at: 1000 },
    ]);
    expect(dispatches.every((entry, index) => index === 0 || entry.at - dispatches[index - 1]!.at >= 100)).toBe(true);
  });
});
