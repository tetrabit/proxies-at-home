import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  isMicroserviceAvailable: vi.fn(() => Promise.resolve(false)),
  getScryfallClient: vi.fn(),
}));

vi.mock("axios", () => {
  const mockAxios = {
    create: vi.fn(() => mockAxios),
    get: mocks.get,
    isAxiosError: vi.fn(() => false),
  };
  return { default: mockAxios };
});

vi.mock("../db/db.js", () => ({
  getDatabase: vi.fn(() => ({
    prepare: vi.fn(() => ({
      get: vi.fn(() => undefined),
      run: vi.fn(),
    })),
  })),
}));

vi.mock("../utils/debug.js", () => ({ debugLog: vi.fn() }));

vi.mock("../services/scryfallMicroserviceClient.js", () => ({
  isMicroserviceAvailable: mocks.isMicroserviceAvailable,
  getScryfallClient: mocks.getScryfallClient,
}));

vi.mock("../utils/getCardImagesPaged.js", () => ({
  getCardsWithImagesForCardInfo: vi.fn(),
}));

import { scryfallRouter } from "./scryfallRouter.js";

describe("scryfallRouter direct Scryfall broker dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMicroserviceAvailable.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes concurrent direct fallbacks in FIFO order with 100ms physical dispatch spacing", async () => {
    const app = express();
    app.use("/api/scryfall", scryfallRouter);
    const dispatches: Array<{ url: string; at: number }> = [];
    let active = 0;
    let maxActive = 0;

    mocks.get.mockImplementation(async (url: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      dispatches.push({ url, at: Date.now() });
      try {
        if (url === "/cards/search") {
          return { data: { data: [{ name: "Print" }] } };
        }
        return { data: { name: url, object: "catalog", data: [] } };
      } finally {
        active -= 1;
      }
    });

    const responses = [
      request(app).get("/api/scryfall/autocomplete?q=alpha"),
      request(app).get("/api/scryfall/named?exact=Named"),
      request(app).get("/api/scryfall/search?q=Search"),
      request(app).get("/api/scryfall/cards/abc/1?lang=fr"),
      request(app).get("/api/scryfall/prints?oracle_id=oracle-1&lang=fr"),
    ];

    const completed = await Promise.all(responses);

    expect(completed.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(dispatches.map(({ url }) => url)).toEqual([
      "/cards/autocomplete",
      "/cards/named",
      "/cards/search",
      "/cards/abc/1/fr",
      "/cards/search",
    ]);
    for (let index = 1; index < dispatches.length; index += 1) {
      expect(dispatches[index].at - dispatches[index - 1].at).toBeGreaterThanOrEqual(100);
    }
    expect(maxActive).toBe(1);
  });

  it("uses the microservice without submitting a direct Scryfall request", async () => {
    const app = express();
    app.use("/api/scryfall", scryfallRouter);
    const autocomplete = vi.fn().mockResolvedValue({ object: "catalog", data: ["Micro Ring"] });
    mocks.isMicroserviceAvailable.mockResolvedValue(true);
    mocks.getScryfallClient.mockReturnValue({ autocomplete });

    const response = await request(app).get("/api/scryfall/autocomplete?q=micro");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ object: "catalog", data: ["Micro Ring"] });
    expect(autocomplete).toHaveBeenCalledWith({ q: "micro" });
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
