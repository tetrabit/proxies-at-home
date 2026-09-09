import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  axiosGet: vi.fn(),
  axiosPost: vi.fn(),
  axiosCreate: vi.fn(),
  isAxiosError: vi.fn(() => false),
  isMicroserviceAvailable: vi.fn(() => Promise.resolve(false)),
  getScryfallClient: vi.fn(),
  dbGet: vi.fn(() => undefined),
  dbRun: vi.fn(),
  dbPrepare: vi.fn(),
  lookupCardBySetNumber: vi.fn(() => undefined),
  lookupCardByName: vi.fn(() => undefined),
  insertOrUpdateCard: vi.fn(),
  debugLog: vi.fn(),
}));

vi.mock("axios", () => {
  const axios = {
    get: mocks.axiosGet,
    post: mocks.axiosPost,
    create: mocks.axiosCreate,
    isAxiosError: mocks.isAxiosError,
  };
  mocks.axiosCreate.mockImplementation(() => axios);
  return { default: axios };
});

vi.mock("../db/db.js", () => ({
  getDatabase: vi.fn(() => ({
    prepare: mocks.dbPrepare.mockImplementation(() => ({
      get: mocks.dbGet,
      run: mocks.dbRun,
    })),
  })),
}));

vi.mock("../db/proxxiedCardLookup.js", () => ({
  lookupCardBySetNumber: mocks.lookupCardBySetNumber,
  lookupCardByName: mocks.lookupCardByName,
  insertOrUpdateCard: mocks.insertOrUpdateCard,
  batchInsertCards: vi.fn(),
  getCardCount: vi.fn(),
}));

vi.mock("../utils/debug.js", () => ({ debugLog: mocks.debugLog }));
vi.mock("../services/scryfallMicroserviceClient.js", () => ({
  isMicroserviceAvailable: mocks.isMicroserviceAvailable,
  getScryfallClient: mocks.getScryfallClient,
}));

import { getBulkDataInfo } from "../services/bulkDataService.js";
import { scryfallRouter } from "../routes/scryfallRouter.js";
import { getImagesForCardInfo } from "./getCardImagesPaged.js";
import { initCatalogs } from "./scryfallCatalog.js";
import { resolveLatestTokenParts } from "./tokenLookup.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settlePromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe("cross-caller Scryfall broker integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    vi.clearAllMocks();
    mocks.isMicroserviceAvailable.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("serializes catalog, router, token, bulk, and enrichment cache misses with physical dispatch spacing", async () => {
    const firstCatalogResponse = deferred<{ json(): Promise<{ data: string[] }> }>();
    const dispatches: Array<{ caller: string; at: number }> = [];
    let active = 0;
    let maximumActive = 0;
    let catalogRequests = 0;
    let enrichmentAttempts = 0;

    const recordPhysicalDispatch = <T>(caller: string, value: T): Promise<T> => new Promise((resolve) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      dispatches.push({ caller, at: Date.now() });
      queueMicrotask(() => {
        active -= 1;
        resolve(value);
      });
    });

    vi.stubGlobal("fetch", vi.fn((url: string) => {
      expect(url).toMatch(/^https:\/\/api\.scryfall\.com\/catalog\//);
      catalogRequests += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      dispatches.push({ caller: "catalog", at: Date.now() });
      if (catalogRequests === 1) {
        return firstCatalogResponse.promise.finally(() => {
          active -= 1;
        });
      }
      return new Promise((resolve) => {
        queueMicrotask(() => {
          active -= 1;
          resolve({ json: () => Promise.resolve({ data: [] }) });
        });
      });
    }));

    mocks.axiosGet.mockImplementation((url: string) => {
      if (url === "https://api.scryfall.com/bulk-data/all-cards") {
        return recordPhysicalDispatch("bulk", {
          data: { download_uri: "https://cdn.scryfall.invalid/all-cards.json", size: 1 },
        });
      }
      if (url === "/cards/autocomplete") {
        return recordPhysicalDispatch("router", {
          data: { object: "catalog", data: ["Router cache miss"] },
        });
      }
      if (url === "https://api.scryfall.com/cards/token-direct-id") {
        return recordPhysicalDispatch("token", {
          data: { id: "token-direct-id", name: "Token cache miss" },
        });
      }
      if (url.startsWith("https://api.scryfall.com/cards/search")) {
        enrichmentAttempts += 1;
        return recordPhysicalDispatch("enrichment", {
          data: {
            data: enrichmentAttempts === 1 ? [] : [{ image_uris: { png: "enrichment.png" } }],
            has_more: false,
            next_page: null,
          },
        });
      }
      throw new Error(`Unexpected direct Scryfall URL: ${url}`);
    });
    mocks.axiosPost.mockImplementation((url: string) => {
      if (url === "https://api.scryfall.com/cards/collection") {
        return recordPhysicalDispatch("token-collection", {
          data: {
            data: [{ id: "token-direct-id", name: "Token cache miss" }],
            not_found: [],
          },
        });
      }
      throw new Error(`Unexpected collection Scryfall URL: ${url}`);
    });

    const app = express();
    app.use("/api/scryfall", scryfallRouter);

    const catalog = initCatalogs();
    const router = request(app)
      .get("/api/scryfall/autocomplete?q=router")
      .then((response) => response);
    const token = resolveLatestTokenParts([{ id: "token-direct-id", name: "Token cache miss" }]);
    const bulk = getBulkDataInfo();
    const enrichment = getImagesForCardInfo({ name: "Enrichment cache miss" }, "art", "fr", true);

    await settlePromises();
    await vi.advanceTimersByTimeAsync(500);
    expect(dispatches).toEqual([{ caller: "catalog", at: 0 }]);
    expect(active).toBe(1);
    expect(maximumActive).toBe(1);

    firstCatalogResponse.resolve({ json: () => Promise.resolve({ data: [] }) });
    await vi.runAllTimersAsync();

    const [catalogResult, routerResult, tokenResult, bulkResult, enrichmentResult] = await Promise.all([
      catalog,
      router,
      token,
      bulk,
      enrichment,
    ]);

    expect(catalogResult).toBeUndefined();
    expect(routerResult.status).toBe(200);
    expect(routerResult.body).toEqual({ object: "catalog", data: ["Router cache miss"] });
    expect(tokenResult).toEqual([{ id: "token-direct-id", name: "Token cache miss" }]);
    expect(bulkResult).toEqual({ download_uri: "https://cdn.scryfall.invalid/all-cards.json", size: 1 });
    expect(enrichmentResult).toEqual(["enrichment.png"]);

    expect(mocks.axiosPost).toHaveBeenCalledWith(
      "https://api.scryfall.com/cards/collection",
      { identifiers: [{ id: "token-direct-id" }] }
    );
    expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    expect(
      mocks.axiosGet.mock.calls.some(([url]) => url === "https://api.scryfall.com/cards/token-direct-id")
    ).toBe(false);

    expect(maximumActive).toBe(1);
    expect(dispatches.filter(({ caller }) => caller === "catalog")).toHaveLength(9);
    expect(dispatches.map(({ caller }) => caller)).toContain("router");
    expect(dispatches.filter(({ caller }) => caller === "token-collection")).toHaveLength(1);
    expect(dispatches.map(({ caller }) => caller)).toContain("bulk");
    expect(dispatches.filter(({ caller }) => caller === "enrichment")).toHaveLength(2);
    expect(enrichmentAttempts).toBe(2);
    for (let index = 1; index < dispatches.length; index += 1) {
      expect(dispatches[index]!.at - dispatches[index - 1]!.at).toBeGreaterThanOrEqual(100);
    }
  });
});
