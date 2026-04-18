import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MpcCalibrationCaseRecord,
  MpcCalibrationDatasetRecord,
} from "@/db";

const mockSearchMpcAutofill = vi.hoisted(() => vi.fn());
const mockHarvestCandidates = vi.hoisted(() => vi.fn());
const mockBuildVisualProfiles = vi.hoisted(() => vi.fn());
const mockBuildVisualScoreMap = vi.hoisted(() => vi.fn());

vi.mock("./mpcAutofillApi", () => ({
  searchMpcAutofill: mockSearchMpcAutofill,
}));

vi.mock("./mpcPreferenceBootstrap", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./mpcPreferenceBootstrap")>();
  return {
    ...actual,
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

import {
  evaluateHeldOutCalibrationDataset,
  evaluateMpcCalibrationCase,
  evaluateMpcCalibrationDataset,
} from "./mpcCalibrationRunner";

const dataset: MpcCalibrationDatasetRecord = {
  id: "dataset-1",
  name: "Regression",
  targetCaseCount: 9,
  createdAt: 1,
  updatedAt: 1,
  version: 1,
};

const calibrationCase: MpcCalibrationCaseRecord = {
  id: "case-1",
  datasetId: dataset.id,
  createdAt: 1,
  updatedAt: 1,
  source: {
    name: "Sol Ring",
    set: "C21",
    collectorNumber: "267",
    sourceImageUrl: "fixture://source/sol-ring",
    sourceArtImageUrl: "fixture://art/sol-ring",
  },
  expectedIdentifier: "art-match",
  candidates: [
    {
      identifier: "exact-print",
      name: "Sol Ring",
      rawName: "Sol Ring [C21] {267}",
      smallThumbnailUrl: "",
      mediumThumbnailUrl: "",
      imageUrl: "fixture://candidate/exact-print",
      dpi: 300,
      tags: [],
      sourceName: "Source A",
      source: "source-a",
      extension: "png",
      size: 100,
    },
    {
      identifier: "art-match",
      name: "Sol Ring",
      rawName: "Sol Ring (Alt Art)",
      smallThumbnailUrl: "",
      mediumThumbnailUrl: "",
      imageUrl: "fixture://candidate/art-match",
      dpi: 600,
      tags: [],
      sourceName: "Source B",
      source: "source-b",
      extension: "png",
      size: 100,
    },
  ],
  comparisonHints: {
    fullCard: {
      "exact-print": 0.8,
      "art-match": 0.95,
    },
    artMatch: {
      "exact-print": 0.7,
      "art-match": 0.98,
    },
  },
};

describe("mpcCalibrationRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHarvestCandidates.mockResolvedValue([]);
    mockBuildVisualProfiles.mockResolvedValue({});
    mockBuildVisualScoreMap.mockResolvedValue({});
    mockSearchMpcAutofill.mockResolvedValue([]);
  });

  it("evaluates a single case with comparison hints", async () => {
    const result = await evaluateMpcCalibrationCase(calibrationCase, {
      id: "baseline",
      usePreferenceProfile: false,
    });

    expect(result.predictedIdentifier).toBe("art-match");
    expect(result.matched).toBe(true);
    expect(result.recommendations.artMatch[0]?.card.identifier).toBe(
      "art-match"
    );
  });

  it("evaluates a dataset and returns x/9-style summary", async () => {
    const result = await evaluateMpcCalibrationDataset(
      dataset,
      [calibrationCase],
      { id: "baseline", label: "Baseline", usePreferenceProfile: false }
    );

    expect(result.summary.totalCases).toBe(1);
    expect(result.summary.matchedCases).toBe(1);
    expect(result.summary.accuracy).toBe(1);
  });

  it("uses the stored expected case profile as a learned preference by default", async () => {
    const result = await evaluateMpcCalibrationCase(
      {
        ...calibrationCase,
        expectedIdentifier: "exact-print",
      },
      { id: "learned" }
    );

    expect(result.predictedIdentifier).toBe("exact-print");
    expect(result.matched).toBe(true);
  });

  it("uses visual/source-profile scoring in held-out unseen evaluation", async () => {
    const heldOut = {
      ...calibrationCase,
      id: "case-2",
      expectedIdentifier: "art-match",
    };
    const thirdCase = {
      ...calibrationCase,
      id: "case-3",
      expectedIdentifier: "art-match",
    };

    mockHarvestCandidates.mockResolvedValue([
      {
        cardName: "Windborn Muse",
        sourceName: "Hathwellcrisping",
        candidates: [],
      },
    ]);
    mockBuildVisualProfiles.mockResolvedValue({
      Hathwellcrisping: {
        sourceName: "Hathwellcrisping",
        descriptor: { meanLuma: 0.4, variance: 0.1, edgeDensity: 0.2 },
        sampleCount: 1,
      },
    });
    mockBuildVisualScoreMap.mockResolvedValue({
      "exact-print": 0,
      "art-match": 5,
    });

    const result = await evaluateHeldOutCalibrationDataset(
      dataset,
      [calibrationCase, heldOut, thirdCase],
      {
        emphasizedSources: ["Hathwellcrisping", "Chilli_Axe"],
        minCaseCount: 1,
      }
    );

    expect(result.summary.totalCases).toBe(3);
    expect(result.summary.matchedCases).toBe(3);
  });
});
