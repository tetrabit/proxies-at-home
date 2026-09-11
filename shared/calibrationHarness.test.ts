import { describe, expect, it, vi } from "vitest";
import {
  CALIBRATION_HARNESS_FORMAT_VERSION,
  CALIBRATION_HARNESS_LIMITS,
  CalibrationHarnessValidationError,
  canonicalHarnessJson,
  validateCalibrationHarnessSnapshot,
  type CalibrationHarnessJsonValue,
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

function snapshotFixture(): CalibrationHarnessSnapshot {
  return JSON.parse(JSON.stringify(representativeSnapshot)) as CalibrationHarnessSnapshot;
}

describe("validateCalibrationHarnessSnapshot", () => {
  it("retains valid full metadata, unknown fields, and historical rows without mutation", () => {
    const snapshot = snapshotFixture() as CalibrationHarnessSnapshot & Record<string, unknown>;
    snapshot.retainedEnvelopeMetadata = {
      nested: [true, { literalIdentifier: "preserve-me" }],
      omittedByJson: undefined,
    };
    snapshot.runs[0].results.push({
      caseId: "historical-case-no-longer-present",
      expectedIdentifier: "old-expected",
      predictedIdentifier: "old-prediction",
      matched: false,
      historicalMetadata: { retained: true },
    });
    const before = canonicalHarnessJson(snapshot);

    const validated = validateCalibrationHarnessSnapshot(snapshot);

    expect(validated).toBe(snapshot);
    expect(canonicalHarnessJson(validated)).toBe(before);
    expect(validated.runs).toHaveLength(25);
    expect(validated.retainedEnvelopeMetadata).toEqual({
      nested: [true, { literalIdentifier: "preserve-me" }],
      omittedByJson: undefined,
    });
  });

  it("rejects malformed required nested values", () => {
    const snapshot = snapshotFixture();
    snapshot.cases[0].candidates[0].tags = ["valid", 2] as unknown as string[];

    expect(() => validateCalibrationHarnessSnapshot(snapshot)).toThrow(
      CalibrationHarnessValidationError
    );
  });

  it("rejects malformed table rows with a validation error", () => {
    const snapshot = snapshotFixture();
    snapshot.datasets = [null] as unknown as CalibrationHarnessSnapshot["datasets"];

    expect(() => validateCalibrationHarnessSnapshot(snapshot)).toThrow(
      CalibrationHarnessValidationError
    );
  });

  it("rejects duplicate identifiers in each identity scope", () => {
    const duplicateCase = snapshotFixture();
    duplicateCase.cases.push({ ...duplicateCase.cases[0] });
    const duplicateCandidate = snapshotFixture();
    duplicateCandidate.cases[0].candidates.push({
      ...duplicateCandidate.cases[0].candidates[0],
    });

    expect(() => validateCalibrationHarnessSnapshot(duplicateCase)).toThrow(/duplicate case id/i);
    expect(() => validateCalibrationHarnessSnapshot(duplicateCandidate)).toThrow(
      /duplicate candidate identifier/i
    );
  });

  it("rejects invalid asset hashes and byte sizes", () => {
    const invalidHash = snapshotFixture();
    invalidHash.assets[0].sha256 = "A".repeat(64);
    const invalidSize = snapshotFixture();
    invalidSize.assets[0].byteLength = CALIBRATION_HARNESS_LIMITS.maxAssetBytes + 1;

    expect(() => validateCalibrationHarnessSnapshot(invalidHash)).toThrow(/sha256/i);
    expect(() => validateCalibrationHarnessSnapshot(invalidSize)).toThrow(/byteLength/i);
  });

  it("rejects cross-dataset assets and invalid current candidate references", () => {
    const crossDataset = snapshotFixture();
    crossDataset.datasets.push({
      ...crossDataset.datasets[0],
      id: "dataset-other",
    });
    crossDataset.assets[0].datasetId = "dataset-other";
    const missingCandidate = snapshotFixture();
    missingCandidate.assets[1].candidateIdentifier = "not-in-this-case";
    const invalidExpected = snapshotFixture();
    invalidExpected.cases[0].expectedIdentifier = "not-in-this-case";

    expect(() => validateCalibrationHarnessSnapshot(crossDataset)).toThrow(/datasetId/i);
    expect(() => validateCalibrationHarnessSnapshot(missingCandidate)).toThrow(
      /candidateIdentifier/i
    );
    expect(() => validateCalibrationHarnessSnapshot(invalidExpected)).toThrow(
      /expectedIdentifier/i
    );
  });

  it("rejects over-budget payloads and excessive nesting before canonical output", () => {
    const excessivePayload = snapshotFixture() as CalibrationHarnessSnapshot & Record<string, unknown>;
    excessivePayload.unknownPayload = "x".repeat(CALIBRATION_HARNESS_LIMITS.maxMetadataBytes);
    const excessiveDepth = snapshotFixture() as CalibrationHarnessSnapshot;
    let cursor: Record<string, unknown> = {};
    (excessiveDepth as unknown as Record<string, unknown>).unknownMetadata = cursor;
    for (let depth = 0; depth <= CALIBRATION_HARNESS_LIMITS.maxDepth; depth += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }

    expect(() => validateCalibrationHarnessSnapshot(excessivePayload)).toThrow(/metadata bytes/i);
    expect(() => validateCalibrationHarnessSnapshot(excessiveDepth)).toThrow(/depth/i);
  });

  it("counts JSON string bytes exactly without materializing a large escaped value", () => {
    const encodedByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;
    const stringSamples = [
      ["plain", 7],
      ["\u0000\b\t\n\f\r\u001f", 24],
      ["😀", 6],
      ["\ud800", 8],
      ["\udc00", 8],
    ] as const;
    for (const [sample, expectedSerializedBytes] of stringSamples) {
      expect(encodedByteLength(JSON.stringify(sample))).toBe(expectedSerializedBytes);
      expect(() =>
        validateCalibrationHarnessSnapshot({
          version: 1,
          datasets: [],
          cases: [],
          assets: [],
          runs: [],
          unknownMetadata: sample,
        })
      ).not.toThrow();
    }

    const encodeSpy = vi.spyOn(TextEncoder.prototype, "encode");
    const controlPayload = "\u0000".repeat(1024 * 1024);
    try {
      expect(() =>
        validateCalibrationHarnessSnapshot({
          version: 1,
          datasets: [],
          cases: [],
          assets: [],
          runs: [],
          unknownMetadata: controlPayload,
        })
      ).not.toThrow();
      expect(Math.max(...encodeSpy.mock.calls.map(([value]) => (value ?? "").length))).toBeLessThan(
        1024
      );
    } finally {
      encodeSpy.mockRestore();
    }
  });

  it("keeps NUL-containing asset-slot tuples distinct while rejecting a true duplicate", () => {
    const snapshot = snapshotFixture();
    const firstIdentifier = "x\u0000candidate-small\u0000y";
    const secondCaseId = "a\u0000candidate-small\u0000x";
    snapshot.cases = [
      {
        ...snapshot.cases[0],
        id: "a",
        candidates: [{ ...snapshot.cases[0].candidates[0], identifier: firstIdentifier }],
        expectedIdentifier: firstIdentifier,
      },
      {
        ...snapshot.cases[0],
        id: secondCaseId,
        candidates: [{ ...snapshot.cases[0].candidates[0], identifier: "y" }],
        expectedIdentifier: "y",
      },
    ];
    snapshot.assets = [
      {
        ...snapshot.assets[1],
        id: "asset-nul-one",
        caseId: "a",
        candidateIdentifier: firstIdentifier,
      },
      {
        ...snapshot.assets[1],
        id: "asset-nul-two",
        caseId: secondCaseId,
        candidateIdentifier: "y",
      },
    ];

    expect(validateCalibrationHarnessSnapshot(snapshot)).toBe(snapshot);
    snapshot.assets.push({ ...snapshot.assets[1], id: "asset-nul-duplicate" });
    expect(() => validateCalibrationHarnessSnapshot(snapshot)).toThrow(/duplicate asset slot/i);
  });

  it("rejects accessor, hidden, sparse, and custom-iterator properties without invoking them", () => {
    const accessor = snapshotFixture() as CalibrationHarnessSnapshot & Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(accessor, "volatileMetadata", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "not data";
      },
    });
    expect(() => validateCalibrationHarnessSnapshot(accessor)).toThrow(/data property|accessor/i);
    expect(getterCalls).toBe(0);

    const hiddenRequired = snapshotFixture();
    const version = hiddenRequired.version;
    delete (hiddenRequired as Partial<CalibrationHarnessSnapshot>).version;
    Object.defineProperty(hiddenRequired, "version", { enumerable: false, value: version });
    expect(() => validateCalibrationHarnessSnapshot(hiddenRequired)).toThrow(/enumerable data/i);

    const sparse = snapshotFixture() as CalibrationHarnessSnapshot & Record<string, unknown>;
    sparse.unknownMetadata = ["present", , "present"] as unknown as CalibrationHarnessJsonValue;
    expect(() => validateCalibrationHarnessSnapshot(sparse)).toThrow(/sparse arrays/i);

    const arrayAccessor = snapshotFixture() as CalibrationHarnessSnapshot & Record<string, unknown>;
    let arrayGetterCalls = 0;
    const accessorArray = ["data"];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get() {
        arrayGetterCalls += 1;
        return "not data";
      },
    });
    arrayAccessor.unknownMetadata = accessorArray;
    expect(() => validateCalibrationHarnessSnapshot(arrayAccessor)).toThrow(/data array index/i);
    expect(arrayGetterCalls).toBe(0);

    const customIterator = snapshotFixture() as CalibrationHarnessSnapshot & Record<string, unknown>;
    let iteratorCalls = 0;
    const metadataArray = ["data"];
    Object.defineProperty(metadataArray, Symbol.iterator, {
      enumerable: true,
      value: function* () {
        iteratorCalls += 1;
        yield "altered";
      },
    });
    customIterator.unknownMetadata = metadataArray;
    expect(() => validateCalibrationHarnessSnapshot(customIterator)).toThrow(/symbol|array/i);
    expect(iteratorCalls).toBe(0);

    const nullPrototype = Object.assign(Object.create(null), snapshotFixture());
    expect(validateCalibrationHarnessSnapshot(nullPrototype)).toBe(nullPrototype);
  });
});
