import { describe, expect, it } from "vitest";
import {
  CALIBRATION_HARNESS_FORMAT_VERSION,
  CalibrationHarnessValidationError,
  canonicalHarnessJson,
  validateCalibrationHarnessSnapshot,
  type CalibrationHarnessCase,
  type CalibrationHarnessDataset,
  type CalibrationHarnessRun,
  type CalibrationHarnessSnapshot,
} from "./calibrationHarness";
import {
  mergeCalibrationHarnessSnapshots,
  type CalibrationHarnessMergeResult,
} from "./calibrationHarnessMerge";

const candidate = {
  identifier: "candidate-1",
  name: "Candidate",
  rawName: "Candidate",
  smallThumbnailUrl: "fixture://candidate/small",
  mediumThumbnailUrl: "fixture://candidate/medium",
  imageUrl: "fixture://candidate",
  dpi: 300,
  tags: ["fixture"],
  sourceName: "fixture-source",
  source: "fixture",
  extension: "png",
  size: 1,
};

function dataset(id = "dataset-1"): CalibrationHarnessDataset {
  return {
    id,
    name: id,
    targetCaseCount: 1,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
  };
}

function calibrationCase(id = "case-1", datasetId = "dataset-1"): CalibrationHarnessCase {
  return {
    id,
    datasetId,
    createdAt: 1,
    updatedAt: 1,
    source: { name: id },
    candidates: [{ ...candidate }],
    expectedIdentifier: "candidate-1",
  };
}

function run(id: string): CalibrationHarnessRun {
  return {
    id,
    datasetId: "dataset-1",
    algorithmId: "fixture-algorithm",
    createdAt: 1,
    summary: { totalCases: 0, matchedCases: 0, mismatchedCases: 0, accuracy: 0 },
    results: [],
  };
}

function snapshot(overrides: Partial<CalibrationHarnessSnapshot> = {}): CalibrationHarnessSnapshot {
  return {
    version: CALIBRATION_HARNESS_FORMAT_VERSION,
    datasets: [dataset()],
    cases: [calibrationCase()],
    assets: [],
    runs: [],
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergedSnapshot(result: CalibrationHarnessMergeResult): CalibrationHarnessSnapshot {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) {
    throw new Error(`expected a publishable merge, got ${JSON.stringify(result.conflicts)}`);
  }
  return result.snapshot;
}

describe("mergeCalibrationHarnessSnapshots", () => {
  it("publishes the common-base merge function", () => {
    expect(mergeCalibrationHarnessSnapshots).toBeTypeOf("function");
  });

  it("merges disjoint case edits and additions while retaining unknown root metadata", () => {
    const base = snapshot() as CalibrationHarnessSnapshot & Record<string, unknown>;
    base.baseMetadata = { preserved: true };
    const left = clone(base) as CalibrationHarnessSnapshot & Record<string, unknown>;
    left.cases[0] = { ...left.cases[0], notes: "edited on left", nestedMetadata: { left: [1, 2] } };
    left.leftRootMetadata = { source: "left" };
    const right = clone(base) as CalibrationHarnessSnapshot & Record<string, unknown>;
    right.cases.push({ ...calibrationCase("case-2"), nestedMetadata: { right: ["kept"] } });
    right.rightRootMetadata = { source: "right" };

    const first = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, left, right));
    const second = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, left, right));
    const reversed = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, right, left));

    expect(first.cases).toMatchObject([
      { id: "case-1", notes: "edited on left", nestedMetadata: { left: [1, 2] } },
      { id: "case-2", nestedMetadata: { right: ["kept"] } },
    ]);
    expect(first).toMatchObject({
      baseMetadata: { preserved: true },
      leftRootMetadata: { source: "left" },
      rightRootMetadata: { source: "right" },
    });
    expect(canonicalHarnessJson(first)).toBe(canonicalHarnessJson(second));
    expect(canonicalHarnessJson(first)).toBe(canonicalHarnessJson(reversed));
  });

  it("reports divergent same-record edits without publishing a partial snapshot", () => {
    const base = snapshot();
    const left = clone(base);
    left.cases[0].notes = "left";
    const right = clone(base);
    right.cases[0].notes = "right";

    const result = mergeCalibrationHarnessSnapshots(base, left, right);

    expect(result).toEqual({
      ok: false,
      conflicts: [
        expect.objectContaining({ collection: "cases", id: "case-1", kind: "divergent-edit" }),
      ],
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("unions immutable run additions in stable id order and rejects same-id run changes", () => {
    const base = snapshot();
    const left = clone(base);
    left.runs.push(run("run-z"), run("run-same"));
    const right = clone(base);
    right.runs.push(run("run-a"), run("run-same"));

    const union = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, left, right));
    expect(union.runs.map((entry) => entry.id)).toEqual(["run-a", "run-same", "run-z"]);

    const immutableBase = snapshot({ runs: [run("run-base")] });
    const changed = clone(immutableBase);
    changed.runs[0].algorithmLabel = "mutated";
    const collision = mergeCalibrationHarnessSnapshots(immutableBase, changed, clone(immutableBase));
    expect(collision).toMatchObject({
      ok: false,
      conflicts: [expect.objectContaining({ collection: "runs", id: "run-base", kind: "immutable-run-change" })],
    });
    expect(collision).not.toHaveProperty("snapshot");
  });

  it("fails closed for deletions and independent asset-slot divergence", () => {
    const base = snapshot();
    const deletion = mergeCalibrationHarnessSnapshots(base, { ...clone(base), cases: [] }, clone(base));
    expect(deletion).toMatchObject({
      ok: false,
      conflicts: [expect.objectContaining({ collection: "cases", id: "case-1", kind: "unsupported-deletion" })],
    });

    const left = clone(base);
    left.assets.push({
      id: "asset-left",
      datasetId: "dataset-1",
      caseId: "case-1",
      role: "source",
      mimeType: "image/png",
      createdAt: 1,
      sha256: "a".repeat(64),
      byteLength: 1,
    });
    const right = clone(base);
    right.assets.push({
      ...left.assets[0],
      id: "asset-right",
      sha256: "b".repeat(64),
    });
    const assetDivergence = mergeCalibrationHarnessSnapshots(base, left, right);
    expect(assetDivergence).toMatchObject({
      ok: false,
      conflicts: [expect.objectContaining({ collection: "assets", kind: "asset-divergence" })],
    });
    expect(assetDivergence).not.toHaveProperty("snapshot");
  });

  it("does not mutate sources and preserves nested candidate and result ordering", () => {
    const base = snapshot({ runs: [run("run-history")] }) as CalibrationHarnessSnapshot & Record<string, unknown>;
    base.unknownRoot = { retained: ["first", "second"] };
    base.cases[0].candidates.push({ ...candidate, identifier: "candidate-2", name: "Second" });
    base.cases[0].expectedIdentifier = "candidate-2";
    base.runs[0].results.push(
      { caseId: "case-1", matched: false, selectedReason: "first" },
      { caseId: "case-1", matched: true, selectedReason: "second" }
    );
    const left = clone(base);
    left.cases[0].notes = "left-only edit";
    const right = clone(base);
    right.rightUnknown = { nested: { retained: true } };
    const before = [canonicalHarnessJson(base), canonicalHarnessJson(left), canonicalHarnessJson(right)];

    const merged = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, left, right));
    merged.cases[0].candidates[0].name = "changed-output-only";
    merged.runs[0].results[0].selectedReason = "changed-output-only";

    expect(merged.cases[0].candidates.map((entry) => entry.identifier)).toEqual([
      "candidate-1",
      "candidate-2",
    ]);
    expect(merged.runs[0].results.map((entry) => entry.selectedReason)).toEqual([
      "changed-output-only",
      "second",
    ]);
    expect([canonicalHarnessJson(base), canonicalHarnessJson(left), canonicalHarnessJson(right)]).toEqual(before);
  });

  it("requires a common base and applies existing validator constraints before merge", () => {
    const source = snapshot();
    const absentBase = mergeCalibrationHarnessSnapshots(undefined, source, clone(source));
    expect(absentBase).toEqual({
      ok: false,
      conflicts: [expect.objectContaining({ collection: "root", kind: "no-common-base" })],
    });
    expect(absentBase).not.toHaveProperty("snapshot");

    const invalid = clone(source);
    invalid.cases[0].expectedIdentifier = "not-a-candidate";
    expect(() => mergeCalibrationHarnessSnapshots(source, invalid, clone(source))).toThrow(
      CalibrationHarnessValidationError
    );
    expect(() => validateCalibrationHarnessSnapshot(invalid)).toThrow(CalibrationHarnessValidationError);
  });
});
