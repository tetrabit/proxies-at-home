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
});
