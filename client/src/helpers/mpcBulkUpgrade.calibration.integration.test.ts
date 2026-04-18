import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "@/db";
import {
  createMpcCalibrationDataset,
  saveMpcCalibrationCase,
} from "./mpcCalibrationStorage";
import { bulkUpgradeToMpcAutofill } from "./mpcBulkUpgrade";
import type { CardOption } from "@/types";

const mockSearchMpcAutofill = vi.hoisted(() => vi.fn());
const mockGetMpcAutofillImageUrl = vi.hoisted(() => vi.fn());
const mockAddRemoteImage = vi.hoisted(() => vi.fn());
const mockInferImageSource = vi.hoisted(() => vi.fn());
const mockLoadImage = vi.hoisted(() => vi.fn());

vi.mock("./mpcAutofillApi", () => ({
  searchMpcAutofill: mockSearchMpcAutofill,
  getMpcAutofillImageUrl: mockGetMpcAutofillImageUrl,
}));

vi.mock("./dbUtils", () => ({
  addRemoteImage: mockAddRemoteImage,
}));

vi.mock("./imageSourceUtils", () => ({
  inferImageSource: mockInferImageSource,
  inferSourceFromUrl: vi.fn(() => "scryfall"),
}));

vi.mock("./imageProcessing", () => ({
  loadImage: mockLoadImage,
  toProxiedBase: (url: string) => url,
}));

vi.mock("./imageHelper", () => ({
  toProxied: (url: string) => url,
  toArtCrop: (url: string) =>
    url.includes("cards.scryfall.io")
      ? url.replace("/png/", "/art_crop/").replace(/\.png(\?|$)/, ".jpg$1")
      : null,
}));

vi.mock("./mpcPreferenceBootstrap", () => ({
  hydrateMpcPreferences: vi.fn(async () => undefined),
  ensureBootstrapPreferenceDataset: vi.fn(async () => undefined),
  harvestSourcePreferenceCandidates: vi.fn(async () => []),
  BOOTSTRAP_PREFERENCE_SEED_CARD_NAMES: ["Sol Ring"],
}));

vi.mock("./mpcVisualPreference", () => ({
  buildMpcSourceVisualProfiles: vi.fn(async () => ({})),
  buildMpcVisualPreferenceScoreMap: vi.fn(async () => ({})),
}));

type FixtureCase = {
  name: string;
  expectedIdentifier: string;
  predictedIdentifier: string;
  candidates: Array<Record<string, unknown>>;
};

type Fixture = { cases: FixtureCase[] };

/** One card per type/color to keep integration tests fast. */
const REPRESENTATIVE_CARD_NAMES = [
  "Thalia, Guardian of Thraben", // white creature
  "Snapcaster Mage", // blue creature
  "Sheoldred, the Apocalypse", // black creature
  "Dockside Extortionist", // red creature
  "Craterhoof Behemoth", // green creature
  "Wurmcoil Engine", // colorless artifact creature
  "Path to Exile", // white instant
  "Counterspell", // blue instant
  "Lightning Bolt", // red instant
  "Wrath of God", // white sorcery
  "Demonic Tutor", // black sorcery
  "Sol Ring", // artifact
  "Rhystic Study", // enchantment
  "Jace, the Mind Sculptor", // planeswalker
  "Command Tower", // land
];

function fixturePath() {
  return path.resolve(
    process.cwd(),
    "tests/fixtures/mpc-preference-defaults.v1.json"
  );
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(fixturePath(), "utf8")) as Fixture;
}

function pickRepresentativeCases(fixture: Fixture): Fixture {
  const nameSet = new Set(REPRESENTATIVE_CARD_NAMES);
  return {
    cases: fixture.cases.filter((c) => nameSet.has(c.name)),
  };
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

describe("bulkUpgradeToMpcAutofill calibration integration", () => {
  async function seedCards(fixture: Fixture) {
    const cards: CardOption[] = fixture.cases.map((calibrationCase, index) => ({
      uuid: `card-${index + 1}`,
      name: calibrationCase.name,
      order: index,
      imageId: `image-${index + 1}`,
      isUserUpload: false,
      hasBuiltInBleed: false,
      projectId: "proj-1",
    }));

    await db.cards.bulkAdd(cards);
    await db.images.bulkAdd(
      cards.map((card, index) => ({
        id: card.imageId!,
        refCount: 1,
        sourceUrl: `https://cards.scryfall.io/png/front/${index}/a/${crypto.randomUUID()}.png?fixture=${index}`,
      }))
    );

    mockSearchMpcAutofill.mockImplementation(async (query: string) => {
      const calibrationCase = fixture.cases.find((item) => item.name === query);
      return calibrationCase
        ? calibrationCase.candidates.map((candidate) => ({
            ...candidate,
            imageUrl: `https://mpc.test/${candidate.identifier}`,
            smallThumbnailUrl: `https://mpc.test/${candidate.identifier}-small`,
            mediumThumbnailUrl: `https://mpc.test/${candidate.identifier}-medium`,
          }))
        : [];
    });

    return cards;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    installCanvasStub();
    mockInferImageSource.mockReturnValue("scryfall");
    mockLoadImage.mockResolvedValue(makeBitmap());
    mockAddRemoteImage.mockImplementation(
      async ([url]: string[]) => `image:${url}`
    );
    mockGetMpcAutofillImageUrl.mockImplementation(
      (identifier: string, size?: string) =>
        size === "small"
          ? `https://mpc.test/${identifier}-small`
          : `https://mpc.test/${identifier}`
    );

    await db.mpcCalibrationRuns.clear();
    await db.mpcCalibrationAssets.clear();
    await db.mpcCalibrationCases.clear();
    await db.mpcCalibrationDatasets.clear();
    await db.cards.clear();
    await db.images.clear();
    await db.settings.clear();
  });

  it("replays a representative calibration set through the production bulk upgrader with stored preferences", async () => {
    const fullFixture = loadFixture();
    const fixture = pickRepresentativeCases(fullFixture);
    const replayFixture: Fixture = {
      cases: fixture.cases.map((calibrationCase) => ({
        ...calibrationCase,
        candidates: calibrationCase.candidates.filter((candidate) => {
          const typed = candidate as { identifier?: string };
          return (
            typed.identifier === calibrationCase.expectedIdentifier ||
            typed.identifier === calibrationCase.predictedIdentifier
          );
        }),
      })),
    };

    const dataset = await createMpcCalibrationDataset({
      name: "MPC Calibration Harness",
    });

    await seedCards(replayFixture);

    for (const calibrationCase of replayFixture.cases) {
      await saveMpcCalibrationCase({
        id: crypto.randomUUID(),
        datasetId: dataset.id,
        source: {
          name: calibrationCase.name,
        },
        candidates: calibrationCase.candidates as never,
        expectedIdentifier: calibrationCase.expectedIdentifier,
      });
    }

    const totalCases = replayFixture.cases.length;
    const result = await bulkUpgradeToMpcAutofill();

    expect(result).toEqual({
      totalCards: totalCases,
      upgraded: totalCases,
      skipped: 0,
      errors: 0,
    });

    const calledUrls = mockAddRemoteImage.mock.calls.map((call) => call[0][0]);
    for (const calibrationCase of replayFixture.cases) {
      expect(calledUrls).toContain(
        `https://mpc.test/${calibrationCase.expectedIdentifier}`
      );
    }
  });

  it("does not naturally resolve all cards to the expected identifier without stored preferences", async () => {
    const fullFixture = loadFixture();
    const fixture = pickRepresentativeCases(fullFixture);

    await seedCards(fixture);

    const totalCases = fixture.cases.length;
    const result = await bulkUpgradeToMpcAutofill();

    expect(result).toEqual({
      totalCards: totalCases,
      upgraded: totalCases,
      skipped: 0,
      errors: 0,
    });

    const calledUrls = mockAddRemoteImage.mock.calls.map((call) => call[0][0]);
    const matchedExpected = fixture.cases.filter((calibrationCase) =>
      calledUrls.includes(
        `https://mpc.test/${calibrationCase.expectedIdentifier}`
      )
    ).length;

    expect(matchedExpected).toBeLessThan(fixture.cases.length);
  });
});
