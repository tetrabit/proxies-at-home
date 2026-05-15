import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MpcCalibrationAssetRecord,
  MpcCalibrationCaseRecord,
  MpcCalibrationDatasetRecord,
} from "@/db";

const mockSearchMpcAutofill = vi.hoisted(() => vi.fn());
const mockHarvestCandidates = vi.hoisted(() => vi.fn());
const mockBuildVisualProfiles = vi.hoisted(() => vi.fn());
const mockBuildVisualScoreMap = vi.hoisted(() => vi.fn());
const mockBuildPreferenceScoreMap = vi.hoisted(() => vi.fn());

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

vi.mock("./mpcPreferenceModel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mpcPreferenceModel")>();
  return {
    ...actual,
    buildMpcPreferenceScoreMap: mockBuildPreferenceScoreMap,
  };
});

import {
  evaluateHeldOutCalibrationDataset,
  evaluateMpcCalibrationCase,
  evaluateMpcCalibrationDataset,
  toMpcCalibrationRunResults,
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

  it("returns zero accuracy for empty datasets", async () => {
    const result = await evaluateMpcCalibrationDataset(dataset, [], {
      id: "empty",
    });

    expect(result.algorithmId).toBe("empty");
    expect(result.algorithmLabel).toBeUndefined();
    expect(result.summary).toEqual({
      totalCases: 0,
      matchedCases: 0,
      mismatchedCases: 0,
      accuracy: 0,
    });
    expect(result.cases).toEqual([]);
  });

  it("uses the stored expected case profile as a learned preference by default", async () => {
    const result = await evaluateMpcCalibrationCase(
      {
        ...calibrationCase,
        expectedIdentifier: "exact-print",
        candidates: calibrationCase.candidates.map((candidate) =>
          candidate.identifier === "exact-print"
            ? { ...candidate, rawName: undefined }
            : candidate
        ),
      },
      { id: "learned" }
    );

    expect(result.predictedIdentifier).toBe("exact-print");
    expect(result.matched).toBe(true);
  });

  it("falls through to visual comparison when no expected preference exists", async () => {
    const noExpectedCase: MpcCalibrationCaseRecord = {
      ...calibrationCase,
      source: { name: "Sol Ring", sourceImageUrl: "fixture://source/sol-ring" },
      expectedIdentifier: undefined,
      comparisonHints: undefined,
    };

    const result = await evaluateMpcCalibrationCase(noExpectedCase, {
      id: "visual",
      ssimCompare: async (_sourceUrl, candidateUrl) =>
        candidateUrl.includes("art-match") ? 0.96 : 0.1,
      artMatchCompare: async () => null,
    });

    expect(result.predictedIdentifier).toBe("art-match");
    expect(result.matched).toBe(false);
    expect(result.selectedReason).toBe("name_ssim");
  });

  it("uses default comparators when no source image or comparison hints exist", async () => {
    const result = await evaluateMpcCalibrationCase(
      {
        ...calibrationCase,
        source: { name: "Sol Ring" },
        expectedIdentifier: undefined,
        comparisonHints: undefined,
      },
      { id: "defaults" }
    );

    expect(result.predictedIdentifier).toBe("art-match");
    expect(result.matched).toBe(false);
    expect(result.selectedReason).toBe("name_dpi_fallback");
  });

  it("treats null comparison hints and missing candidate image URLs as unavailable scores", async () => {
    const result = await evaluateMpcCalibrationCase(
      {
        ...calibrationCase,
        source: { name: "Sol Ring", sourceImageUrl: "fixture://source" },
        expectedIdentifier: undefined,
        candidates: [
          ...calibrationCase.candidates,
          {
            ...calibrationCase.candidates[0]!,
            identifier: "missing-url",
            imageUrl: undefined,
            dpi: 100,
          },
        ],
        comparisonHints: {
          fullCard: {
            "exact-print": null,
            "art-match": 0.96,
          },
          artMatch: {
            "exact-print": null,
            "art-match": 0.97,
          },
        },
      },
      { id: "hint-fallbacks", usePreferenceProfile: false }
    );

    expect(result.predictedIdentifier).toBe("art-match");
    expect(result.recommendations.fullCard.map((entry) => entry.card.identifier)).toEqual([
      "art-match",
    ]);
  });

  it("resolves calibration assets to object URLs and revokes them after evaluation", async () => {
    const createdUrls: string[] = [];
    const createObjectUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((blob) => {
        const url = `blob://asset-${createdUrls.length}-${(blob as Blob).type}`;
        createdUrls.push(url);
        return url;
      });
    const revokeObjectUrlSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const assets: MpcCalibrationAssetRecord[] = [
      {
        id: "source-asset",
        datasetId: dataset.id,
        caseId: calibrationCase.id,
        role: "source",
        mimeType: "image/png",
        blob: new Blob(["source"], { type: "image/png" }),
        createdAt: 1,
      },
      {
        id: "source-art-asset",
        datasetId: dataset.id,
        caseId: calibrationCase.id,
        role: "source-art",
        mimeType: "image/png",
        blob: new Blob(["source-art"], { type: "image/png" }),
        createdAt: 1,
      },
      {
        id: "candidate-asset",
        datasetId: dataset.id,
        caseId: calibrationCase.id,
        role: "candidate-small",
        candidateIdentifier: "art-match",
        mimeType: "image/png",
        blob: new Blob(["candidate"], { type: "image/png" }),
        createdAt: 1,
      },
      {
        id: "ignored-asset",
        datasetId: dataset.id,
        caseId: "other-case",
        role: "candidate-small",
        candidateIdentifier: "exact-print",
        mimeType: "image/png",
        blob: new Blob(["ignored"], { type: "image/png" }),
        createdAt: 1,
      },
      {
        id: "candidate-without-identifier",
        datasetId: dataset.id,
        caseId: calibrationCase.id,
        role: "candidate-small",
        mimeType: "image/png",
        blob: new Blob(["ignored"], { type: "image/png" }),
        createdAt: 1,
      },
    ];

    const result = await evaluateMpcCalibrationCase(
      {
        ...calibrationCase,
        source: {
          name: "Sol Ring",
          sourceImageUrl: "fixture://source/sol-ring",
          sourceArtImageUrl: "fixture://art/sol-ring",
        },
        expectedIdentifier: undefined,
        comparisonHints: undefined,
      },
      {
        id: "assets",
        ssimCompare: async (sourceUrl, candidateUrl) => {
          expect(sourceUrl).toBe(createdUrls[0]);
          return candidateUrl === createdUrls[2] ? 0.96 : 0.1;
        },
        artMatchCompare: async () => null,
      },
      assets
    );

    expect(result.predictedIdentifier).toBe("art-match");
    expect(createObjectUrlSpy).toHaveBeenCalledTimes(3);
    expect(revokeObjectUrlSpy.mock.calls.map(([url]) => url)).toEqual(
      createdUrls
    );
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

    mockHarvestCandidates.mockImplementation(async (_names, search) => {
      await search("Windborn Muse");
      return [
      {
        cardName: "Windborn Muse",
        sourceName: "Hathwellcrisping",
        candidates: [],
      },
      ];
    });
    mockBuildVisualProfiles.mockResolvedValue({
      Hathwellcrisping: {
        sourceName: "Hathwellcrisping",
        descriptor: { meanLuma: 0.4, variance: 0.1, edgeDensity: 0.2 },
        sampleCount: 1,
      },
    });
    mockBuildPreferenceScoreMap.mockImplementation(() => ({
      "exact-print": 0.2,
      "art-match": Number.NaN,
    }));
    mockBuildVisualScoreMap.mockImplementation(() => ({
      "exact-print": Number.NaN,
      "art-match": 0.9,
    }));

    const result = await evaluateHeldOutCalibrationDataset(
      dataset,
      [calibrationCase, heldOut, thirdCase],
      {
        emphasizedSources: ["Hathwellcrisping", "Chilli_Axe"],
        minCaseCount: 1,
      }
    );

    expect(result.summary.totalCases).toBe(3);
    expect(result.cases).toHaveLength(3);
    expect(result.summary.mismatchedCases).toBe(3);
    expect(result.cases.map((item) => item.predictedIdentifier)).toEqual([
      "exact-print",
      "exact-print",
      "exact-print",
    ]);
  });

  it("skips held-out cases without labels, enough candidates, or a trainable model", async () => {
    const unlabeled = {
      ...calibrationCase,
      id: "unlabeled",
      expectedIdentifier: undefined,
    };
    const singleCandidate = {
      ...calibrationCase,
      id: "single-candidate",
      candidates: [calibrationCase.candidates[0]!],
    };
    const heldOutWithoutTrainingSet = {
      ...calibrationCase,
      id: "held-out",
    };

    const result = await evaluateHeldOutCalibrationDataset(
      dataset,
      [unlabeled, singleCandidate, heldOutWithoutTrainingSet],
      { minCaseCount: 3 }
    );

    expect(result.summary).toEqual({
      totalCases: 0,
      matchedCases: 0,
      mismatchedCases: 0,
      accuracy: 0,
    });
    expect(mockHarvestCandidates).not.toHaveBeenCalled();
  });

  it("maps evaluations to persisted run result records", async () => {
    const evaluation = await evaluateMpcCalibrationCase(calibrationCase, {
      id: "baseline",
      usePreferenceProfile: false,
    });

    expect(toMpcCalibrationRunResults([evaluation])).toEqual([
      expect.objectContaining({
        caseId: "case-1",
        expectedIdentifier: "art-match",
        predictedIdentifier: "art-match",
        matched: true,
        fullProcessIdentifier: "art-match",
        artMatchIdentifier: "art-match",
        exactPrintingIdentifier: expect.any(String),
        fullCardIdentifier: "exact-print",
      }),
    ]);
  });
});
