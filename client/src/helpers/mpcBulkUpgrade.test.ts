import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbCards = vi.hoisted(() => ({
  where: vi.fn().mockReturnThis(),
  equals: vi.fn().mockReturnThis(),
  toArray: vi.fn(),
  bulkUpdate: vi.fn(),
}));

const mockDbImages = vi.hoisted(() => ({
  bulkGet: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));

const mockDbSettings = vi.hoisted(() => ({
  put: vi.fn(),
}));

const mockDb = vi.hoisted(() => ({
  cards: mockDbCards,
  images: mockDbImages,
  settings: mockDbSettings,
  transaction: vi.fn(),
}));

const mockSearchMpcAutofill = vi.hoisted(() => vi.fn());
const mockGetMpcAutofillImageUrl = vi.hoisted(() => vi.fn());
const mockAddRemoteImage = vi.hoisted(() => vi.fn());
const mockInferImageSource = vi.hoisted(() => vi.fn());
const mockLoadImage = vi.hoisted(() => vi.fn());

vi.mock("@/db", () => ({ db: mockDb }));

vi.mock("./mpcAutofillApi", () => ({
  searchMpcAutofill: mockSearchMpcAutofill,
  getMpcAutofillImageUrl: mockGetMpcAutofillImageUrl,
}));

vi.mock("./dbUtils", () => ({
  addRemoteImage: mockAddRemoteImage,
}));

vi.mock("./imageSourceUtils", () => ({
  inferImageSource: mockInferImageSource,
}));

vi.mock("./imageProcessing", () => ({
  loadImage: mockLoadImage,
}));

vi.mock("./imageHelper", () => ({
  toProxied: (url: string) => url,
  toArtCrop: (url: string) =>
    url.includes("cards.scryfall.io")
      ? url.replace("/png/", "/art_crop/").replace(/\.png(\?|$)/, ".jpg$1")
      : null,
}));

import { bulkUpgradeToMpcAutofill } from "./mpcBulkUpgrade";
import type { CardOption } from "@/types";

function makeCardOption(overrides: Partial<CardOption> = {}): CardOption {
  return {
    uuid: `uuid-${Math.random().toString(36).slice(2, 8)}`,
    name: "Sol Ring",
    order: 0,
    imageId: "scryfall-img-001",
    isUserUpload: false,
    hasBuiltInBleed: false,
    projectId: "proj-1",
    ...overrides,
  } as CardOption;
}

function makeBitmap(): ImageBitmap {
  return {
    width: 8,
    height: 8,
    close: vi.fn(),
  } as unknown as ImageBitmap;
}

function installCanvasStub() {
  const drawImage = vi.fn();
  const getImageData = vi.fn(
    (_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4).fill(200),
      width,
      height,
    })
  );

  vi.stubGlobal("document", {
    createElement: vi.fn(() => ({
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        drawImage,
        getImageData,
      })),
    })),
  });
}

describe("bulkUpgradeToMpcAutofill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installCanvasStub();
    mockInferImageSource.mockReturnValue("scryfall");
    mockLoadImage.mockResolvedValue(makeBitmap());
    mockDb.transaction.mockImplementation(
      async (
        _mode: string,
        _cards: unknown,
        _images: unknown,
        _settingsOrCallback: unknown,
        maybeCallback?: () => Promise<void>
      ) => {
        const callback =
          typeof maybeCallback === "function"
            ? maybeCallback
            : (_settingsOrCallback as () => Promise<void>);
        return callback();
      }
    );
  });

  it("uses deterministic fallback selection when multiple exact-name matches remain", async () => {
    const card = makeCardOption({
      uuid: "card-1",
      set: "C21",
      number: "267",
    });
    mockDbCards.toArray.mockResolvedValue([card]);
    mockDbImages.bulkGet.mockResolvedValue([{ source: "scryfall" }]);

    const mpcCards = [
      {
        identifier: "a",
        name: "Sol Ring",
        rawName: "Sol Ring [C21] {267}",
        smallThumbnailUrl: "",
        mediumThumbnailUrl: "",
        dpi: 300,
        tags: [],
        sourceName: "test",
        source: "test",
        extension: "png",
        size: 1000,
      },
      {
        identifier: "b",
        name: "Sol Ring",
        rawName: "Sol Ring [C21] {267}",
        smallThumbnailUrl: "",
        mediumThumbnailUrl: "",
        dpi: 600,
        tags: [],
        sourceName: "test",
        source: "test",
        extension: "png",
        size: 1000,
      },
    ];

    mockSearchMpcAutofill.mockResolvedValue(mpcCards);
    mockGetMpcAutofillImageUrl.mockImplementation(
      (identifier: string) => `https://mpc.test/${identifier}`
    );
    mockAddRemoteImage.mockResolvedValue("new-image-id");
    mockDbImages.get.mockResolvedValue({ refCount: 1 });

    const result = await bulkUpgradeToMpcAutofill();

    expect(result).toEqual({
      totalCards: 1,
      upgraded: 1,
      skipped: 0,
      errors: 0,
    });
    expect(mockAddRemoteImage).toHaveBeenCalledWith(["https://mpc.test/b"], 1);
    expect(mockDbCards.bulkUpdate).toHaveBeenCalled();
  });

  it("updates cards and image refs when an upgrade succeeds", async () => {
    const card = makeCardOption({
      uuid: "card-2",
      set: "C21",
      number: "267",
    });
    mockDbCards.toArray.mockResolvedValue([card]);
    mockDbImages.bulkGet.mockResolvedValue([{ source: "scryfall" }]);

    const mpcCard = {
      identifier: "match-1",
      name: "Sol Ring",
      rawName: "Sol Ring [C21] {267}",
      smallThumbnailUrl: "",
      mediumThumbnailUrl: "",
      dpi: 600,
      tags: [],
      sourceName: "test",
      source: "test",
      extension: "png",
      size: 1000,
    };

    mockSearchMpcAutofill.mockResolvedValue([mpcCard]);
    mockGetMpcAutofillImageUrl.mockImplementation(
      (identifier: string) => `https://mpc.test/${identifier}`
    );
    mockAddRemoteImage.mockResolvedValue("new-image-id");
    mockDbImages.get.mockResolvedValue({ refCount: 1 });

    const result = await bulkUpgradeToMpcAutofill();

    expect(result).toEqual({
      totalCards: 1,
      upgraded: 1,
      skipped: 0,
      errors: 0,
    });
    expect(mockAddRemoteImage).toHaveBeenCalledWith(
      ["https://mpc.test/match-1"],
      1
    );
    expect(mockDbCards.bulkUpdate).toHaveBeenCalledWith([
      expect.objectContaining({
        key: "card-2",
        changes: expect.objectContaining({
          imageId: "new-image-id",
          isUserUpload: false,
          hasBuiltInBleed: true,
        }),
      }),
    ]);
  });

  it("uses MPC small URLs for matching and the full URL for the applied upgrade", async () => {
    const card = makeCardOption({
      uuid: "card-2b",
      set: "C21",
      number: "267",
    });
    mockDbCards.toArray.mockResolvedValue([card]);
    mockDbImages.bulkGet.mockResolvedValue([
      {
        source: "scryfall",
        sourceUrl:
          "https://cards.scryfall.io/png/front/1/2/12345678-1234-1234-1234-123456789abc.png?version",
      },
    ]);

    mockSearchMpcAutofill.mockResolvedValue([
      {
        identifier: "a",
        name: "Sol Ring",
        rawName: "Sol Ring [C21] {267}",
        smallThumbnailUrl: "",
        mediumThumbnailUrl: "",
        dpi: 300,
        tags: [],
        sourceName: "test",
        source: "test",
        extension: "png",
        size: 1000,
      },
      {
        identifier: "b",
        name: "Sol Ring",
        rawName: "Sol Ring [C21] {267}",
        smallThumbnailUrl: "",
        mediumThumbnailUrl: "",
        dpi: 600,
        tags: [],
        sourceName: "test",
        source: "test",
        extension: "png",
        size: 1000,
      },
    ]);
    mockGetMpcAutofillImageUrl.mockImplementation(
      (identifier: string, size?: string) =>
        size === "small"
          ? `https://mpc.test/${identifier}-small`
          : `https://mpc.test/${identifier}`
    );

    mockAddRemoteImage.mockResolvedValue("new-image-id");
    mockDbImages.get.mockResolvedValue({ refCount: 1 });

    await bulkUpgradeToMpcAutofill();

    expect(mockGetMpcAutofillImageUrl).toHaveBeenCalledWith("a", "small");
    expect(mockGetMpcAutofillImageUrl).toHaveBeenCalledWith("b", "small");
    expect(mockAddRemoteImage).toHaveBeenCalledWith(["https://mpc.test/b"], 1);
  });

  it("records a no-match outcome when MPC search results do not exactly match the card name", async () => {
    const card = makeCardOption({
      uuid: "card-3",
      name: "Sol Ring",
      set: "C21",
      number: "267",
    });
    mockDbCards.toArray.mockResolvedValue([card]);
    mockDbImages.bulkGet.mockResolvedValue([{ source: "scryfall" }]);
    mockSearchMpcAutofill.mockResolvedValue([
      {
        identifier: "other-card",
        name: "Arcane Signet",
        rawName: "Arcane Signet [C21] {237}",
        smallThumbnailUrl: "",
        mediumThumbnailUrl: "",
        dpi: 300,
        tags: [],
        sourceName: "test",
        source: "test",
        extension: "png",
        size: 1000,
      },
    ]);

    const result = await bulkUpgradeToMpcAutofill();

    expect(result).toEqual({
      totalCards: 1,
      upgraded: 0,
      skipped: 1,
      errors: 0,
    });
    expect(mockAddRemoteImage).not.toHaveBeenCalled();
    expect(mockDbCards.bulkUpdate).not.toHaveBeenCalled();
  });

  it("skips non-Scryfall images before attempting an MPC search", async () => {
    const card = makeCardOption({ uuid: "card-4" });
    mockDbCards.toArray.mockResolvedValue([card]);
    mockDbImages.bulkGet.mockResolvedValue([{ source: "custom" }]);

    const result = await bulkUpgradeToMpcAutofill();

    expect(result).toEqual({
      totalCards: 1,
      upgraded: 0,
      skipped: 1,
      errors: 0,
    });
    expect(mockSearchMpcAutofill).not.toHaveBeenCalled();
  });
});
