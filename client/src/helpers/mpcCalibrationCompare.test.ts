import { describe, expect, it } from "vitest";
import type {
  MpcCalibrationCaseRecord,
  MpcCalibrationDatasetRecord,
} from "@/db";
import { compareMpcCalibrationAlgorithms } from "./mpcCalibrationCompare";

const dataset: MpcCalibrationDatasetRecord = {
  id: "dataset-1",
  name: "Comparison Dataset",
  targetCaseCount: 9,
  createdAt: 1,
  updatedAt: 1,
  version: 1,
};

const cases: MpcCalibrationCaseRecord[] = [
  {
    id: "case-1",
    datasetId: dataset.id,
    createdAt: 1,
    updatedAt: 1,
    source: {
      name: "Sol Ring",
      sourceImageUrl: "fixture://source/sol-ring",
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
    },
  },
];

describe("mpcCalibrationCompare", () => {
  it("produces per-case diffs between two algorithm configs", async () => {
    const result = await compareMpcCalibrationAlgorithms(
      dataset,
      cases,
      {
        id: "baseline",
        usePreferenceProfile: false,
      },
      {
        id: "candidate",
        usePreferenceProfile: false,
        ssimCompare: async (_source, candidateUrl) =>
          candidateUrl.includes("exact-print") ? 0.99 : 0.2,
      }
    );

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]?.changed).toBe(true);
    expect(result.diffs[0]?.baselineIdentifier).toBe("art-match");
    expect(result.diffs[0]?.candidateIdentifier).toBe("exact-print");
  });
});
