/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import axios from "axios";

// Mock dependencies
vi.mock("../db/db.js", () => ({
  getDatabase: vi.fn(() => ({
    prepare: vi.fn(() => ({
      get: vi.fn(() => undefined),
      run: vi.fn(),
    })),
  })),
}));

vi.mock("../utils/debug.js", () => ({
  debugLog: vi.fn(),
}));

// Mock axios - not strictly needed as we mock getCardsWithImagesForCardInfo, but scryfallRouter imports it
vi.mock("axios", () => {
  const mockAxios = {
    create: vi.fn(() => mockAxios),
    get: vi.fn(),
    isAxiosError: vi.fn((err) => err?.isAxiosError === true),
  };
  return { default: mockAxios };
});

// Mock microservice client - always unavailable in tests
vi.mock("../services/scryfallMicroserviceClient.js", () => ({
  getScryfallClient: vi.fn(),
  isMicroserviceAvailable: vi.fn(() => Promise.resolve(false)),
}));

// Mock getCardsWithImagesForCardInfo
vi.mock("../utils/getCardImagesPaged.js", () => ({
  getCardsWithImagesForCardInfo: vi.fn(),
}));

import { scryfallRouter } from "./scryfallRouter.js";
import { getCardsWithImagesForCardInfo } from "../utils/getCardImagesPaged.js";
import { getScryfallClient, isMicroserviceAvailable } from "../services/scryfallMicroserviceClient.js";
import { getDatabase } from "../db/db.js";

describe("scryfallRouter - /prints", () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use("/api/scryfall", scryfallRouter);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("should populate faceName for single-faced cards when mixed with DFCs", async () => {
    // Mock data representing a mixed result (e.g., "Treasure" token)
    const mockPrints: Partial<any>[] = [
      {
        // Single-faced Treasure Token
        name: "Treasure",
        set: "tcmr",
        collector_number: "11",
        rarity: "common",
        lang: "en",
        image_uris: { png: "https://example.com/treasure.png" },
      },
      {
        // DFC: Dinosaur // Treasure
        name: "Dinosaur // Treasure",
        set: "trix",
        collector_number: "2",
        rarity: "common",
        lang: "en",
        card_faces: [
          {
            name: "Dinosaur",
            image_uris: { png: "https://example.com/dinosaur.png" },
          },
          {
            name: "Treasure",
            image_uris: { png: "https://example.com/treasure_back.png" },
          },
        ],
      },
    ];

    vi.mocked(getCardsWithImagesForCardInfo).mockResolvedValue(
      mockPrints as unknown as any
    );

    const res = await request(app).get("/api/scryfall/prints?name=Treasure");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3); // 1 single-faced + 2 faces of DFC

    const prints = res.body.prints;

    // Verify single-faced card has faceName populated
    const singleFaced = prints.find(
      (p: { imageUrl: string; faceName?: string }) =>
        p.imageUrl === "https://example.com/treasure.png"
    );
    expect(singleFaced).toBeDefined();
    expect(singleFaced.faceName).toBe("Treasure");

    // Verify DFC faces
    const dinosaurFace = prints.find(
      (p: { imageUrl: string; faceName?: string }) => p.faceName === "Dinosaur"
    );
    expect(dinosaurFace).toBeDefined();
    expect(dinosaurFace.imageUrl).toBe("https://example.com/dinosaur.png");

    const treasureFace = prints.find(
      (p: { imageUrl: string; faceName?: string }) =>
        p.imageUrl === "https://example.com/treasure_back.png"
    );
    expect(treasureFace).toBeDefined();
    expect(treasureFace.faceName).toBe("Treasure");
  });

  it("should handle only single-faced cards correctly", async () => {
    const mockPrints = [
      {
        name: "Sol Ring",
        set: "cmd",
        collector_number: "1",
        image_uris: { png: "https://example.com/solring.png" },
      },
    ];
    vi.mocked(getCardsWithImagesForCardInfo).mockResolvedValue(
      mockPrints as unknown as any
    );

    const res = await request(app).get("/api/scryfall/prints?name=Sol Ring");

    expect(res.status).toBe(200);
    expect(res.body.prints[0].faceName).toBe("Sol Ring");
  });

  it("should support oracle_id query when name is unavailable", async () => {
    const mockPrints = [
      {
        id: "print-1",
        oracle_id: "oracle-123",
        name: "Sheoldred, Whispering One",
        set: "mul",
        collector_number: "76",
        rarity: "mythic",
        lang: "en",
        image_uris: { png: "https://example.com/sheoldred.png" },
      },
    ];
    vi.mocked(axios.get).mockResolvedValue({
      data: { data: mockPrints },
    } as unknown as any);

    const res = await request(app).get(
      "/api/scryfall/prints?oracle_id=oracle-123&lang=en"
    );

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.oracle_id).toBe("oracle-123");
    expect(res.body.prints[0].scryfall_id).toBe("print-1");
    expect(res.body.prints[0].oracle_id).toBe("oracle-123");
  });

  it("filters foil-only prints when nonfoil art exists for same image", async () => {
    const mockPrints = [
      {
        id: "nonfoil-1",
        name: "Test Card",
        set: "seta",
        collector_number: "1",
        rarity: "rare",
        lang: "en",
        nonfoil: true,
        foil: true,
        image_uris: { png: "https://example.com/art-a.png" },
      },
      {
        id: "foil-only-duplicate-art",
        name: "Test Card",
        set: "setb",
        collector_number: "2",
        rarity: "rare",
        lang: "en",
        nonfoil: false,
        foil: true,
        image_uris: { png: "https://example.com/art-a.png" },
      },
      {
        id: "foil-only-unique-art",
        name: "Test Card",
        set: "setc",
        collector_number: "3",
        rarity: "rare",
        lang: "en",
        nonfoil: false,
        foil: true,
        image_uris: { png: "https://example.com/art-b.png" },
      },
    ];

    vi.mocked(getCardsWithImagesForCardInfo).mockResolvedValue(
      mockPrints as unknown as any
    );

    const res = await request(app).get("/api/scryfall/prints?name=Test Card");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const urls = res.body.prints.map((p: { imageUrl: string }) => p.imageUrl);
    expect(urls).toContain("https://example.com/art-a.png");
    expect(urls).toContain("https://example.com/art-b.png");
    expect(
      res.body.prints.find(
        (p: { scryfall_id?: string }) =>
          p.scryfall_id === "foil-only-duplicate-art"
      )
    ).toBeUndefined();
    expect(
      res.body.prints.find(
        (p: { scryfall_id?: string }) =>
          p.scryfall_id === "foil-only-unique-art"
      )
    ).toBeDefined();
  });

  it("validates prints inputs and supports set+number plus non-English oracle searches", async () => {
    const missing = await request(app).get("/api/scryfall/prints");
    expect(missing.status).toBe(400);

    vi.mocked(axios.get).mockResolvedValueOnce({ data: { data: [{ name: "Set Print", set: "abc", collector_number: "7", image_uris: { png: "set.png" } }] } } as unknown as any);
    const bySet = await request(app).get("/api/scryfall/prints?set=ABC&number=7");
    expect(bySet.status).toBe(200);
    expect(bySet.body.prints[0]).toMatchObject({ imageUrl: "set.png", set: "abc", number: "7" });
    expect(axios.get).toHaveBeenLastCalledWith('/cards/search', { params: { q: 'set:abc number:7 include:extras' } });

    vi.mocked(axios.get).mockResolvedValueOnce({ data: { data: [] } } as unknown as any);
    const nonEnglish = await request(app).get("/api/scryfall/prints?oracle_id=oracle-fr&lang=fr");
    expect(nonEnglish.status).toBe(200);
    expect(axios.get).toHaveBeenLastCalledWith('/cards/search', { params: { q: 'oracleid:oracle-fr unique:prints include:extras lang:fr' } });
  });

  it("uses the microservice for English oracle-id prints when available", async () => {
    vi.mocked(isMicroserviceAvailable).mockResolvedValueOnce(true);
    vi.mocked(getScryfallClient).mockReturnValueOnce({
      searchCards: vi.fn().mockResolvedValue({
        success: true,
        data: { data: [{ id: 'micro-print', oracle_id: 'oracle-micro', name: 'Micro', set: 'mic', collector_number: '1', image_uris: { png: 'micro.png' } }] },
      }),
    } as never);

    const res = await request(app).get("/api/scryfall/prints?oracle_id=oracle-micro");
    expect(res.status).toBe(200);
    expect(res.body.prints[0].scryfall_id).toBe('micro-print');
    expect(axios.get).not.toHaveBeenCalledWith('/cards/search', { params: { q: expect.stringContaining('oracle-micro') } });
  });

  it("returns cached print responses without hitting Scryfall", async () => {
    const cachedResponse = {
      name: "Cached",
      oracle_id: null,
      lang: "en",
      total: 1,
      prints: [{ imageUrl: "cached.png", set: "abc", number: "1", faceName: "Cached" }],
    };
    vi.mocked(getDatabase).mockReturnValueOnce({
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({
          response: JSON.stringify(cachedResponse),
          expires_at: Date.now() + 60_000,
        })),
        run: vi.fn(),
      })),
    } as never);

    const res = await request(app).get("/api/scryfall/prints?name=Cached");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(cachedResponse);
    expect(getCardsWithImagesForCardInfo).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("forwards print axios errors and handles plain failures", async () => {
    vi.mocked(axios.get).mockRejectedValueOnce({ isAxiosError: true, response: { status: 503, data: { error: 'upstream down' } } });
    vi.mocked(axios.isAxiosError).mockReturnValueOnce(true);
    const upstream = await request(app).get("/api/scryfall/prints?oracle_id=oracle-error&lang=fr");
    expect(upstream.status).toBe(503);
    expect(upstream.body).toEqual({ error: 'upstream down' });

    vi.mocked(getCardsWithImagesForCardInfo).mockRejectedValueOnce(new Error('plain prints failure'));
    const failed = await request(app).get("/api/scryfall/prints?name=Plain%20Failure%20Prints");
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe('Failed to fetch prints');
  });

});
