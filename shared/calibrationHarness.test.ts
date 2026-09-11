import { describe, expect, it } from "vitest";
import {
  CALIBRATION_HARNESS_FORMAT_VERSION,
  canonicalHarnessJson,
  type CalibrationHarnessRevision,
  type CalibrationHarnessSnapshot,
} from "./calibrationHarness";

const representativeSnapshot: CalibrationHarnessSnapshot = {
  version: CALIBRATION_HARNESS_FORMAT_VERSION,
  datasets: [
    {
      id: "dataset-regression-v1",
      name: "MPC Calibration Regression v1",
      description: "Canonical regression metadata retained by the harness.",
      targetCaseCount: 9,
      createdAt: 1776297600000,
      updatedAt: 1776297600000,
      version: 1,
      importedMetadata: {
        source: "mpc-calibration-regression.v1.json",
        preserved: true,
      },
    },
  ],
  cases: [
    {
      id: "case-1",
      datasetId: "dataset-regression-v1",
      createdAt: 1776297600000,
      updatedAt: 1776297600000,
      source: {
        cardUuid: "source-card-uuid-1",
        projectId: "project-regression",
        imageId: "source-image-1",
        name: "Sol Ring",
        set: "C21",
        collectorNumber: "267",
        sourceImageUrl: "fixture://source/sol-ring-1",
        sourceArtImageUrl: "fixture://art/sol-ring-1",
      },
      candidates: [
        {
          identifier: "sol-ring-exact-1",
          name: "Sol Ring",
          rawName: "Sol Ring [C21] {267}",
          smallThumbnailUrl: "fixture://candidate/sol-ring-exact-1/small",
          mediumThumbnailUrl: "fixture://candidate/sol-ring-exact-1/medium",
          imageUrl: "fixture://candidate/sol-ring-exact-1",
          dpi: 300,
          tags: ["exact", "C21"],
          sourceName: "Source A",
          source: "source-a",
          extension: "png",
          size: 100,
        },
        {
          identifier: "sol-ring-art-1",
          name: "Sol Ring",
          rawName: "Sol Ring (Alt Art)",
          smallThumbnailUrl: "fixture://candidate/sol-ring-art-1/small",
          mediumThumbnailUrl: "fixture://candidate/sol-ring-art-1/medium",
          imageUrl: "fixture://candidate/sol-ring-art-1",
          dpi: 600,
          tags: ["alternate-art"],
          sourceName: "Source B",
          source: "source-b",
          extension: "png",
          size: 100,
        },
      ],
      expectedIdentifier: "sol-ring-art-1",
      notes: "Prefer the alternate-art printing for this source image.",
      comparisonHints: {
        fullCard: {
          "sol-ring-exact-1": 0.8,
          "sol-ring-art-1": 0.97,
        },
        artMatch: {
          "sol-ring-exact-1": 0.75,
          "sol-ring-art-1": 0.98,
        },
      },
      caseMetadata: {
        labels: ["regression", "image-match"],
        reviewed: true,
      },
    },
  ],
  assets: [
    {
      id: "asset-source-1",
      datasetId: "dataset-regression-v1",
      caseId: "case-1",
      role: "source",
      sourceUrl: "fixture://source/sol-ring-1",
      mimeType: "image/png",
      createdAt: 1776297600000,
      hash: "legacy-source-hash",
      sha256:
        "a3e7d6d6f9c2d6c24e4ccf4b2c8825bc3fc45df5665182f84e6e5ff6ce7b6a42",
      byteLength: 48192,
      assetMetadata: { storage: "offline-cache" },
    },
    {
      id: "asset-candidate-small-1",
      datasetId: "dataset-regression-v1",
      caseId: "case-1",
      role: "candidate-small",
      candidateIdentifier: "sol-ring-art-1",
      sourceUrl: "fixture://candidate/sol-ring-art-1/small",
      mimeType: "image/png",
      createdAt: 1776297600001,
      sha256:
        "40c3a9ac83ff01b46e684419e3008b2fdbd3f3b3ff454f5de0d3ecf89c6fb06f",
      byteLength: 9216,
    },
  ],
  runs: Array.from({ length: 25 }, (_, runIndex) => ({
    id: `shape-run-${runIndex + 1}`,
    datasetId: "dataset-regression-v1",
    algorithmId: "shape-only-algorithm",
    algorithmLabel: "Run shape coverage only",
    createdAt: 1776297600000 + runIndex,
    summary: {
      totalCases: 1,
      matchedCases: runIndex % 2,
      mismatchedCases: 1 - (runIndex % 2),
      accuracy: runIndex % 2,
    },
    results: [
      {
        caseId: "case-1",
        expectedIdentifier: "sol-ring-art-1",
        predictedIdentifier:
          runIndex % 2 === 0 ? "sol-ring-exact-1" : "sol-ring-art-1",
        matched: runIndex % 2 === 1,
        selectedReason: "shape-only-result",
        fullProcessIdentifier: "sol-ring-exact-1",
        artMatchIdentifier: "sol-ring-art-1",
        exactPrintingIdentifier: "sol-ring-exact-1",
        fullCardIdentifier: "sol-ring-art-1",
      },
    ],
  })),
};

describe("calibration harness wire contract", () => {
  it("serializes sparse JSON arrays with nulls rather than invalid gaps", () => {
    const sparseMetadata: string[] = new Array(3);
    sparseMetadata[1] = "middle";
    const snapshot: CalibrationHarnessSnapshot = {
      version: 1,
      datasets: [],
      cases: [],
      assets: [],
      runs: [],
      sparseMetadata,
    };

    expect(JSON.parse(canonicalHarnessJson(snapshot))).toEqual(
      JSON.parse(JSON.stringify(snapshot))
    );
  });

  it("canonicalizes all object keys while preserving array order", () => {
    const snapshot: CalibrationHarnessSnapshot = {
      version: 1,
      runs: [],
      assets: [],
      cases: [],
      datasets: [
        {
          version: 1,
          updatedAt: 2,
          targetCaseCount: 0,
          name: "ordered",
          id: "dataset-ordered",
          createdAt: 1,
          zMetadata: { z: "last", a: "first" },
          aMetadata: ["second", "first"],
        },
      ],
    };

    expect(canonicalHarnessJson(snapshot)).toBe(
      '{"assets":[],"cases":[],"datasets":[{"aMetadata":["second","first"],"createdAt":1,"id":"dataset-ordered","name":"ordered","targetCaseCount":0,"updatedAt":2,"version":1,"zMetadata":{"a":"first","z":"last"}}],"runs":[],"version":1}'
    );
  });

  it("round-trips representative metadata without blobs and retains unknown JSON metadata", () => {
    const revision: CalibrationHarnessRevision = {
      revision: 7,
      snapshot: representativeSnapshot,
    };
    const serialized = canonicalHarnessJson(revision.snapshot);

    expect(JSON.parse(serialized)).toEqual(representativeSnapshot);
    expect(representativeSnapshot.runs).toHaveLength(25);
    for (const asset of JSON.parse(serialized).assets as Array<
      Record<string, unknown>
    >) {
      expect(asset).not.toHaveProperty("blob");
      expect(asset).not.toHaveProperty("data");
      expect(asset).not.toHaveProperty("base64");
    }
    expect(serialized).not.toContain("base64");
  });

  it("uses JSON.stringify undefined semantics without changing defined metadata", () => {
    const snapshot = {
      ...representativeSnapshot,
      datasets: [
        {
          ...representativeSnapshot.datasets[0],
          description: undefined,
          transientMetadata: undefined,
          arrayMetadata: ["first", undefined, "last"],
        },
      ],
    } as unknown as CalibrationHarnessSnapshot;

    expect(
      JSON.parse(canonicalHarnessJson(snapshot)).datasets[0]
    ).toMatchObject({
      id: "dataset-regression-v1",
      arrayMetadata: ["first", null, "last"],
    });
    expect(
      JSON.parse(canonicalHarnessJson(snapshot)).datasets[0]
    ).not.toHaveProperty("description");
    expect(
      JSON.parse(canonicalHarnessJson(snapshot)).datasets[0]
    ).not.toHaveProperty("transientMetadata");
  });
});
