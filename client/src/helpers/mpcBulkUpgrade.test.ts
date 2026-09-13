import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMpcBulkLogMessage } from "../../../shared/mpcBulkUpgradeLogging";

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
const mockBatchSearchMpcAutofill = vi.hoisted(() => vi.fn());
const mockGetMpcAutofillImageUrl = vi.hoisted(() => vi.fn());
const mockAddRemoteImage = vi.hoisted(() => vi.fn());
const mockInferImageSource = vi.hoisted(() => vi.fn());
const mockInferSourceFromUrl = vi.hoisted(() => vi.fn());
const mockLoadImage = vi.hoisted(() => vi.fn());
const mockGetPreferenceProfile = vi.hoisted(() => vi.fn());
const mockListDefaultCalibrationCases = vi.hoisted(() => vi.fn());
const mockHarvestCandidates = vi.hoisted(() => vi.fn());
const mockBuildVisualProfiles = vi.hoisted(() => vi.fn());
const mockBuildVisualScoreMap = vi.hoisted(() => vi.fn());

vi.mock("@/db", () => ({ db: mockDb }));

vi.mock("./mpcAutofillApi", () => ({
  searchMpcAutofill: mockSearchMpcAutofill,
  batchSearchMpcAutofill: mockBatchSearchMpcAutofill,
  getMpcAutofillImageUrl: mockGetMpcAutofillImageUrl,
}));

vi.mock("./dbUtils", () => ({
  addRemoteImage: mockAddRemoteImage,
}));

vi.mock("./imageSourceUtils", () => ({
  inferImageSource: mockInferImageSource,
  inferSourceFromUrl: mockInferSourceFromUrl,
}));

vi.mock("./imageProcessing", () => ({
  loadImage: mockLoadImage,
}));

vi.mock("./mpcPreferenceBootstrap", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./mpcPreferenceBootstrap")>();
  return {
    ...actual,
    hydrateMpcPreferences: vi.fn(async () => undefined),
    ensureBootstrapPreferenceDataset: vi.fn(async () => undefined),
    harvestSourcePreferenceCandidates: mockHarvestCandidates,
    BOOTSTRAP_PREFERENCE_SEED_CARD_NAMES: ["Windborn Muse"],
  };
});

vi.mock("./mpcVisualPreference", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mpcVisualPreference")>();
  return {
    ...actual,
    buildMpcSourceVisualProfiles: mockBuildVisualProfiles,
    buildMpcVisualPreferenceScoreMap: mockBuildVisualScoreMap,
  };
});

vi.mock("./mpcCalibrationStorage", () => ({
  getMpcCalibrationPreferredIdentifier: vi.fn(),
  getMpcCalibrationPreferenceProfile: mockGetPreferenceProfile,
  listDefaultMpcCalibrationCases: mockListDefaultCalibrationCases,
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

function makeCalibrationCase(
  name: string,
  expectedIdentifier: string,
  sourceName: string
) {
  return {
    id: crypto.randomUUID(),
    datasetId: "dataset-1",
    createdAt: 1,
    updatedAt: 1,
    source: { name },
    candidates: [
      {
        identifier: expectedIdentifier,
        name,
        rawName: `${name} (Preferred)`,
        smallThumbnailUrl: "",
        mediumThumbnailUrl: "",
        imageUrl: `fixture://${expectedIdentifier}`,
        dpi: 800,
        tags: [],
        sourceName,
        source: sourceName,
        extension: "png",
        size: 100,
      },
      {
        identifier: `${expectedIdentifier}-other`,
        name,
        rawName: `${name} [SET] {1}`,
        smallThumbnailUrl: "",
        mediumThumbnailUrl: "",
        imageUrl: `fixture://${expectedIdentifier}-other`,
        dpi: 1200,
        tags: ["Borderless"],
        sourceName:
          sourceName === "Hathwellcrisping" ? "Chilli_Axe" : "Hathwellcrisping",
        source:
          sourceName === "Hathwellcrisping" ? "Chilli_Axe" : "Hathwellcrisping",
        extension: "png",
        size: 100,
      },
    ],
    expectedIdentifier,
  };
}

function makeBitmap(): ImageBitmap {
  return {
    width: 8,
    height: 8,
    close: vi.fn(),
  } as unknown as ImageBitmap;
}

function makeMpcCard(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
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
    mockInferSourceFromUrl.mockReturnValue(undefined);
    mockLoadImage.mockResolvedValue(makeBitmap());
    mockGetPreferenceProfile.mockResolvedValue(undefined);
    mockListDefaultCalibrationCases.mockResolvedValue([]);
    mockHarvestCandidates.mockResolvedValue([]);
    mockBuildVisualProfiles.mockResolvedValue({});
    mockBuildVisualScoreMap.mockResolvedValue({});
    mockBatchSearchMpcAutofill.mockImplementation(
      async (queries: string[], cardType: "CARD" | "TOKEN") =>
        Object.fromEntries(
          await Promise.all(
            queries.map(async (query) => [
              query,
              (await mockSearchMpcAutofill(query, cardType, true)) ?? [],
            ])
          )
        )
    );
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

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("batches Lich Lord Scryfall fronts without live bootstrap searches", async () => {
    const cards = [
      makeCardOption({
        uuid: "varina",
        name: "Varina, Lich Queen",
        imageId: "scryfall-varina",
        order: 0,
      }),
      makeCardOption({
        uuid: "dreadhorde-invasion",
        name: "Dreadhorde Invasion",
        imageId: "mpc-existing",
        hasBuiltInBleed: true,
        order: 1,
      }),
      makeCardOption({
        uuid: "murderous-rider",
        name: "Murderous Rider",
        imageId: "scryfall-murderous-rider",
        order: 2,
      }),
    ];
    mockDbCards.toArray.mockResolvedValue(cards);
    mockDbImages.bulkGet.mockResolvedValue([
      { source: "scryfall" },
      { source: "mpc" },
      { source: "scryfall" },
    ]);
    mockListDefaultCalibrationCases.mockResolvedValue([
      makeCalibrationCase("Windborn Muse", "seed-1", "Hathwellcrisping"),
      makeCalibrationCase("Talrand, Sky Summoner", "seed-2", "Hathwellcrisping"),
      makeCalibrationCase("Thassa, Deep-Dwelling", "seed-3", "Chilli_Axe"),
    ]);
    mockSearchMpcAutofill.mockResolvedValue([]);
    mockBatchSearchMpcAutofill.mockResolvedValue({
      "Varina, Lich Queen": [
        makeMpcCard({
          identifier: "varina-match",
          name: "Varina, Lich Queen",
          rawName: "Varina, Lich Queen [C18] {48}",
        }),
      ],
      "Murderous Rider": [
        makeMpcCard({
          identifier: "murderous-rider-match",
          name: "Murderous Rider",
          rawName: "Murderous Rider [ELD] {97}",
        }),
      ],
    });
    mockGetMpcAutofillImageUrl.mockImplementation(
      (identifier: string) => `https://mpc.test/${identifier}`
    );
    mockAddRemoteImage.mockImplementation(
      async ([url]: string[]) => `stored:${url}`
    );
    mockDbImages.get.mockResolvedValue({ refCount: 1 });

    const result = await bulkUpgradeToMpcAutofill({ projectId: "proj-1" });

    expect(mockBatchSearchMpcAutofill).toHaveBeenCalledTimes(1);
    expect(mockBatchSearchMpcAutofill).toHaveBeenCalledWith(
      ["Varina, Lich Queen", "Murderous Rider"],
      "CARD"
    );
    expect(mockSearchMpcAutofill).not.toHaveBeenCalled();
    expect(mockHarvestCandidates).not.toHaveBeenCalled();
    expect(result).toEqual({
      totalCards: 3,
      upgraded: 2,
      skipped: 1,
      errors: 0,
    });
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

  it("uses stored calibration preferences to override a higher-dpi fallback", async () => {
    const card = makeCardOption({
      uuid: "card-calibration",
      name: "Aven Mindcensor",
      set: "AKH",
      number: "5",
    });
    mockDbCards.toArray.mockResolvedValue([card]);
    mockDbImages.bulkGet.mockResolvedValue([{ source: "scryfall" }]);

    mockSearchMpcAutofill.mockResolvedValue([
      {
        identifier: "default-pick",
        name: "Aven Mindcensor",
        rawName: "Aven Mindcensor [AKH] {5}",
        smallThumbnailUrl: "",
        mediumThumbnailUrl: "",
        dpi: 1200,
        tags: ["Borderless"],
        sourceName: "Default Artist",
        source: "default",
        extension: "png",
        size: 1000,
      },
      {
        identifier: "preferred-pick",
        name: "Aven Mindcensor",
        rawName: "Aven Mindcensor (Rebecca Guay)",
        smallThumbnailUrl: "",
        mediumThumbnailUrl: "",
        dpi: 600,
        tags: [],
        sourceName: "MrTeferi",
        source: "preferred",
        extension: "png",
        size: 1000,
      },
    ]);
    mockGetMpcAutofillImageUrl.mockImplementation(
      (identifier: string) => `https://mpc.test/${identifier}`
    );
    mockGetPreferenceProfile.mockResolvedValue({
      sourceName: "MrTeferi",
      tags: [],
      rawName: "Aven Mindcensor (Rebecca Guay)",
      hasBracketSet: false,
      parenText: "rebecca guay",
    });
    mockAddRemoteImage.mockResolvedValue("new-image-id");
    mockDbImages.get.mockResolvedValue({ refCount: 1 });

    const result = await bulkUpgradeToMpcAutofill();

    expect(result.upgraded).toBe(1);
    expect(mockAddRemoteImage).toHaveBeenCalledWith(
      ["https://mpc.test/preferred-pick"],
      1
    );
  });

  it("uses visual unseen preference scores when no replay data exists", async () => {
    const card = makeCardOption({
      uuid: "card-unseen",
      name: "Windborn Muse",
      set: "M10",
      number: "31",
    });
    mockDbCards.toArray.mockResolvedValue([card]);
    mockDbImages.bulkGet.mockResolvedValue([{ source: "scryfall" }]);

    mockSearchMpcAutofill.mockResolvedValue([
      {
        identifier: "default-pick",
        name: "Windborn Muse",
        rawName: "Windborn Muse [M10] {31}",
        smallThumbnailUrl: "thumb-default",
        mediumThumbnailUrl: "",
        dpi: 1200,
        tags: ["Borderless"],
        sourceName: "Default Artist",
        source: "default",
        extension: "png",
        size: 1000,
      },
      {
        identifier: "visual-pick",
        name: "Windborn Muse",
        rawName: "Windborn Muse",
        smallThumbnailUrl: "thumb-visual",
        mediumThumbnailUrl: "",
        dpi: 600,
        tags: [],
        sourceName: "Hathwellcrisping",
        source: "Hathwellcrisping",
        extension: "png",
        size: 1000,
      },
    ]);
    mockListDefaultCalibrationCases.mockResolvedValue([
      makeCalibrationCase("Windborn Muse", "seed-1", "Hathwellcrisping"),
      makeCalibrationCase(
        "Talrand, Sky Summoner",
        "seed-2",
        "Hathwellcrisping"
      ),
      makeCalibrationCase("Thassa, Deep-Dwelling", "seed-3", "Chilli_Axe"),
    ]);
    mockBuildVisualProfiles.mockResolvedValue({
      Hathwellcrisping: {
        sourceName: "Hathwellcrisping",
        descriptor: { meanLuma: 0.4, variance: 0.2, edgeDensity: 0.1 },
        sampleCount: 1,
      },
    });
    mockBuildVisualScoreMap.mockResolvedValue({
      "visual-pick": 8,
    });
    mockAddRemoteImage.mockResolvedValue("new-image-id");
    mockDbImages.get.mockResolvedValue({ refCount: 1 });

    const controller = new AbortController();
    const result = await bulkUpgradeToMpcAutofill({ signal: controller.signal });

    expect(result.upgraded).toBe(1);
    expect(mockHarvestCandidates).not.toHaveBeenCalled();
    expect(mockBuildVisualProfiles).toHaveBeenCalledWith(
      expect.any(Array),
      controller.signal
    );
    expect(mockBuildVisualScoreMap).toHaveBeenCalled();
    expect(mockAddRemoteImage).toHaveBeenCalledWith(
      ["https://mpc.test/visual-pick"],
      1
    );
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
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
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
    expect(info.mock.calls.map(([message]) => parseMpcBulkLogMessage(message))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "group-completed", cardName: "Sol Ring", candidateCount: 1, exactMatchCount: 0, reason: "no-exact-match", skipped: 1 }),
      ])
    );
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

  it("returns an empty summary when every card is filtered before processing", async () => {
    mockDbCards.toArray.mockResolvedValue([
      makeCardOption({ uuid: "no-image", imageId: undefined }),
      makeCardOption({ uuid: "default-back", usesDefaultCardback: true }),
      makeCardOption({
        uuid: "library-back",
        imageId: "cardback_builtin_blank",
      }),
    ]);

    const result = await bulkUpgradeToMpcAutofill();

    expect(result).toEqual({
      totalCards: 0,
      upgraded: 0,
      skipped: 0,
      errors: 0,
    });
    expect(mockDbImages.bulkGet).not.toHaveBeenCalled();
    expect(mockSearchMpcAutofill).not.toHaveBeenCalled();
  });

  it("uses project filtering, sorted progress, and skipped counts when uploads fail", async () => {
    const progress: string[] = [];
    const first = makeCardOption({
      uuid: "first",
      name: "Arcane Signet",
      imageId: "img-first",
      order: undefined,
    });
    const second = makeCardOption({
      uuid: "second",
      name: "Sol Ring",
      imageId: "img-second",
      order: 2,
    });
    const third = makeCardOption({
      uuid: "third",
      name: "Thought Vessel",
      imageId: "img-third",
      order: 1,
    });
    mockDbCards.toArray.mockResolvedValue([second, first, third]);
    mockDbImages.bulkGet.mockResolvedValue([
      { source: "scryfall" },
      { source: "scryfall" },
      { source: "scryfall" },
    ]);
    mockSearchMpcAutofill.mockImplementation(async (name: string) => [
      makeMpcCard({
        identifier: `match-${name}`,
        name,
        rawName: `${name} [C21] {267}`,
      }),
    ]);
    mockGetMpcAutofillImageUrl.mockImplementation(
      (identifier: string) => `https://mpc.test/${identifier}`
    );
    mockAddRemoteImage.mockResolvedValue(null);

    const result = await bulkUpgradeToMpcAutofill({
      projectId: "proj-1",
      onProgress: ({ currentCardName }) => progress.push(currentCardName),
    });

    expect(mockDbCards.where).toHaveBeenCalledWith("projectId");
    expect(mockDbCards.equals).toHaveBeenCalledWith("proj-1");
    expect(progress.slice(0, 3)).toEqual([
      "Arcane Signet",
      "Thought Vessel",
      "Sol Ring",
    ]);
    expect(result).toEqual({
      totalCards: 3,
      upgraded: 0,
      skipped: 3,
      errors: 0,
    });
  });

  it("uses source URL inference and decrements old image refs when copies remain", async () => {
    const card = makeCardOption({ uuid: "source-url-card" });
    mockDbCards.toArray.mockResolvedValue([card]);
    mockDbImages.bulkGet.mockResolvedValue([
      {
        sourceUrl:
          "https://cards.scryfall.io/png/front/1/2/source-url-card.png",
      },
    ]);
    mockInferSourceFromUrl.mockReturnValue("scryfall");
    mockSearchMpcAutofill.mockResolvedValue([makeMpcCard()]);
    mockGetMpcAutofillImageUrl.mockImplementation(
      (identifier: string) => `https://mpc.test/${identifier}`
    );
    mockAddRemoteImage.mockResolvedValue("new-image-id");
    mockDbImages.get.mockResolvedValue({ refCount: 3 });

    const result = await bulkUpgradeToMpcAutofill();

    expect(result.upgraded).toBe(1);
    expect(mockInferSourceFromUrl).toHaveBeenCalledWith(
      "https://cards.scryfall.io/png/front/1/2/source-url-card.png"
    );
    expect(mockDbImages.update).toHaveBeenCalledWith("scryfall-img-001", {
      refCount: 2,
    });
    expect(mockDbImages.delete).not.toHaveBeenCalled();
  });

  it("uses image id source inference and records transaction failures as errors", async () => {
    const card = makeCardOption({ uuid: "transaction-error" });
    mockDbCards.toArray.mockResolvedValue([card]);
    mockDbImages.bulkGet.mockResolvedValue([{}]);
    mockSearchMpcAutofill.mockResolvedValue([makeMpcCard()]);
    mockGetMpcAutofillImageUrl.mockImplementation(
      (identifier: string) => `https://mpc.test/${identifier}`
    );
    mockAddRemoteImage.mockResolvedValue("new-image-id");
    mockDb.transaction.mockRejectedValueOnce(new Error("write failed"));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const result = await bulkUpgradeToMpcAutofill();

    expect(result).toEqual({
      totalCards: 1,
      upgraded: 0,
      skipped: 0,
      errors: 1,
    });
    expect(mockInferImageSource).toHaveBeenCalledWith("scryfall-img-001");
    expect(info.mock.calls.map(([message]) => parseMpcBulkLogMessage(message))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "group-completed", reason: "persistence", errorName: "Error", errors: 1 }),
        expect.objectContaining({ event: "failed", reason: "group-errors", errors: 1 }),
      ])
    );
  });

  it("skips token cards when MPC returns no searchable results", async () => {
    const card = makeCardOption({
      uuid: "token-card",
      type_line: "Token Creature — Goblin",
    });
    mockDbCards.toArray.mockResolvedValue([card]);
    mockDbImages.bulkGet.mockResolvedValue([{ source: "scryfall" }]);
    mockSearchMpcAutofill.mockResolvedValue(undefined);

    const result = await bulkUpgradeToMpcAutofill();

    expect(mockSearchMpcAutofill).toHaveBeenCalledWith("Sol Ring", "TOKEN", true);
    expect(result).toEqual({
      totalCards: 1,
      upgraded: 0,
      skipped: 1,
      errors: 0,
    });
  });

  it("does not touch image refs when the uploaded image id is unchanged", async () => {
    const card = makeCardOption({ uuid: "same-image" });
    mockDbCards.toArray.mockResolvedValue([card]);
    mockDbImages.bulkGet.mockResolvedValue([{ source: "scryfall" }]);
    mockSearchMpcAutofill.mockResolvedValue([makeMpcCard()]);
    mockGetMpcAutofillImageUrl.mockImplementation(
      (identifier: string) => `https://mpc.test/${identifier}`
    );
    mockAddRemoteImage.mockResolvedValue("scryfall-img-001");

    const result = await bulkUpgradeToMpcAutofill();

    expect(result.upgraded).toBe(1);
    expect(mockDbImages.get).not.toHaveBeenCalled();
    expect(mockDbImages.update).not.toHaveBeenCalled();
    expect(mockDbImages.delete).not.toHaveBeenCalled();
  });

  it("leaves old image refs untouched when the previous image record is missing", async () => {
    const card = makeCardOption({ uuid: "missing-old-image" });
    mockDbCards.toArray.mockResolvedValue([card]);
    mockDbImages.bulkGet.mockResolvedValue([{ source: "scryfall" }]);
    mockSearchMpcAutofill.mockResolvedValue([makeMpcCard()]);
    mockGetMpcAutofillImageUrl.mockImplementation(
      (identifier: string) => `https://mpc.test/${identifier}`
    );
    mockAddRemoteImage.mockResolvedValue("new-image-id");
    mockDbImages.get.mockResolvedValue(undefined);

    const result = await bulkUpgradeToMpcAutofill();

    expect(result.upgraded).toBe(1);
    expect(mockDbImages.get).toHaveBeenCalledWith("scryfall-img-001");
    expect(mockDbImages.update).not.toHaveBeenCalled();
    expect(mockDbImages.delete).not.toHaveBeenCalled();
  });

  it("stops before processing when the abort signal is already aborted", async () => {
    const card = makeCardOption({ uuid: "aborted" });
    const controller = new AbortController();
    controller.abort();
    mockDbCards.toArray.mockResolvedValue([card]);
    mockDbImages.bulkGet.mockResolvedValue([{ source: "scryfall" }]);

    const result = await bulkUpgradeToMpcAutofill({ signal: controller.signal });

    expect(result).toEqual({
      totalCards: 1,
      upgraded: 0,
      skipped: 0,
      errors: 0,
    });
    expect(mockSearchMpcAutofill).not.toHaveBeenCalled();
  });

  it("logs and heartbeats before the initial card read settles", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let resolveCards!: (cards: ReturnType<typeof makeCardOption>[]) => void;
    mockDbCards.toArray.mockImplementationOnce(() => new Promise(resolve => { resolveCards = resolve; }));
    const run = bulkUpgradeToMpcAutofill({ projectId: "proj-1" });
    await vi.advanceTimersByTimeAsync(10_000);
    const pending = info.mock.calls.map(([message]) => parseMpcBulkLogMessage(message));
    resolveCards([]);
    await run;
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "started", projectId: "proj-1" }),
      expect.objectContaining({ event: "heartbeat", phase: "card-loading" }),
    ]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("retains the actual failure phase and group while image acquisition rejects (aborted=%s)", async (aborted) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const controller = new AbortController();
    mockDbCards.toArray.mockResolvedValue([makeCardOption({ uuid: "failed-image" })]);
    mockDbImages.bulkGet.mockResolvedValue([{ source: "scryfall" }]);
    mockBatchSearchMpcAutofill.mockResolvedValue({ "Sol Ring": [makeMpcCard()] });
    const error = new Error("private failure text https://private.example/token");
    if (aborted) error.name = "AbortError";
    mockAddRemoteImage.mockImplementationOnce(async () => {
      if (aborted) controller.abort();
      throw error;
    });
    await expect(bulkUpgradeToMpcAutofill({ signal: controller.signal })).rejects.toBe(error);
    const events = info.mock.calls.map(([message]) => parseMpcBulkLogMessage(message));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: aborted ? "cancelled" : "failed", phase: "image-acquisition", cardName: "Sol Ring", groupIndex: 1,
        reason: aborted ? "aborted" : "image-acquisition", processedImages: 0,
      }),
    ]));
    expect(JSON.stringify(info.mock.calls)).not.toContain(error.message);
  });

  it("emits correlated phases, matching details, and one completed terminal event", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const card = makeCardOption({ uuid: "logged-card", set: "C21", number: "267" });
    mockDbCards.toArray.mockResolvedValue([card]);
    mockDbImages.bulkGet.mockResolvedValue([{ source: "scryfall" }]);
    mockBatchSearchMpcAutofill.mockResolvedValue({ "Sol Ring": [makeMpcCard()] });
    mockGetMpcAutofillImageUrl.mockImplementation((identifier: string) => `https://mpc.test/${identifier}`);
    mockAddRemoteImage.mockResolvedValue("logged-image");
    mockDbImages.get.mockResolvedValue({ refCount: 1 });

    await bulkUpgradeToMpcAutofill({ projectId: "proj-1" });

    const events = info.mock.calls.map(([message]) => parseMpcBulkLogMessage(message));
    const nonNullEvents = events.filter((event) => event !== null);
    const runIds = new Set(nonNullEvents.map((event) => event.runId));
    expect(runIds.size).toBe(1);
    expect(nonNullEvents.map((event) => event.event)).toEqual(expect.arrayContaining([
      "started", "phase-started", "phase-completed", "group-started", "group-completed", "completed",
    ]));
    expect(nonNullEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "phase-completed", phase: "card-loading", inputCards: 1, eligibleCards: 1, totalImages: 1 }),
      expect.objectContaining({ event: "group-started", cardName: "Sol Ring", candidateCount: 1, exactMatchCount: 1 }),
      expect.objectContaining({ event: "group-completed", selectedIdentifier: "match-1", sourceName: "test", dpi: 600, reason: expect.stringMatching(/^set_collector_/) }),
      expect.objectContaining({ event: "completed", outcome: "completed", processedImages: 1, totalCards: 1, upgraded: 1, skipped: 0, errors: 0 }),
    ]));
    expect(nonNullEvents.filter((event) => ["completed", "cancelled", "failed"].includes(event.event))).toHaveLength(1);
  });

  it("emits heartbeat during a deferred prefetch and no heartbeat after late cancellation settles", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const controller = new AbortController();
    const card = makeCardOption({ uuid: "deferred-card" });
    mockDbCards.toArray.mockResolvedValue([card]);
    mockDbImages.bulkGet.mockResolvedValue([{ source: "scryfall" }]);
    let resolveSearch!: (value: Record<string, ReturnType<typeof makeMpcCard>[]>) => void;
    mockBatchSearchMpcAutofill.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSearch = resolve;
    }));

    const run = bulkUpgradeToMpcAutofill({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10_000);
    const duringPrefetch = info.mock.calls
      .map(([message]) => parseMpcBulkLogMessage(message))
      .filter((event) => event !== null);
    expect(duringPrefetch).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "heartbeat", phase: "prefetch", processedImages: 0, totalImages: 1 }),
    ]));

    controller.abort();
    resolveSearch({ "Sol Ring": [makeMpcCard()] });
    await vi.advanceTimersByTimeAsync(0);
    await expect(run).resolves.toEqual({ totalCards: 1, upgraded: 0, skipped: 0, errors: 0 });
    const beforeExtraTime = info.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    const events = info.mock.calls.map(([message]) => parseMpcBulkLogMessage(message)).filter((event) => event !== null);
    expect(info.mock.calls).toHaveLength(beforeExtraTime);
    expect(events.filter((event) => event.event === "cancel-requested")).toHaveLength(1);
    expect(events.filter((event) => event.event === "cancelled")).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "cancelled", outcome: "cancelled", processedImages: 0 }),
    ]));
    expect(events.filter((event) => ["completed", "cancelled", "failed"].includes(event.event))).toHaveLength(1);
  });

  it("emits terminal outcomes for empty, pre-aborted, and callback failure paths", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mockDbCards.toArray.mockResolvedValue([]);
    await bulkUpgradeToMpcAutofill();

    const controller = new AbortController();
    controller.abort();
    mockDbCards.toArray.mockResolvedValue([makeCardOption({ uuid: "pre-aborted" })]);
    await bulkUpgradeToMpcAutofill({ signal: controller.signal });

    mockDbCards.toArray.mockResolvedValue([makeCardOption({ uuid: "callback-throws" })]);
    mockDbImages.bulkGet.mockResolvedValue([{ source: "scryfall" }]);
    mockBatchSearchMpcAutofill.mockResolvedValue({ "Sol Ring": [makeMpcCard()] });
    await expect(bulkUpgradeToMpcAutofill({ onProgress: () => { throw new Error("callback failed"); } })).rejects.toThrow("callback failed");

    const events = info.mock.calls.map(([message]) => parseMpcBulkLogMessage(message)).filter((event) => event !== null);
    const terminalsByRun = new Map<string, string[]>();
    for (const event of events) {
      if (["completed", "cancelled", "failed"].includes(event.event)) {
        terminalsByRun.set(event.runId, [...(terminalsByRun.get(event.runId) ?? []), event.event]);
      }
    }
    expect(Array.from(terminalsByRun.values())).toEqual([["completed"], ["cancelled"], ["failed"]]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "failed", outcome: "failed", errorName: "Error", reason: "callback" }),
    ]));
  });
});
