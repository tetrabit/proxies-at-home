import { describe, expect, it } from "vitest";
import type {
  MpcCalibrationCaseRecord,
  MpcCalibrationDatasetRecord,
} from "@/db";
import {
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
  it("evaluates a single case with comparison hints", async () => {
    const result = await evaluateMpcCalibrationCase(calibrationCase, {
      id: "baseline",
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
      { id: "baseline", label: "Baseline" }
    );

    expect(result.summary.totalCases).toBe(1);
    expect(result.summary.matchedCases).toBe(1);
    expect(result.summary.accuracy).toBe(1);
  });
});
