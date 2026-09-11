import { describe, expect, it } from "vitest";
import {
  CALIBRATION_HARNESS_FORMAT_VERSION,
  CalibrationHarnessValidationError,
  canonicalHarnessJson,
  validateCalibrationHarnessSnapshot,
  type CalibrationHarnessAsset,
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

function asset(id = "asset-1", overrides: Partial<CalibrationHarnessAsset> = {}): CalibrationHarnessAsset {
  return {
    id,
    datasetId: "dataset-1",
    caseId: "case-1",
    role: "source",
    mimeType: "image/png",
    createdAt: 1,
    sha256: "a".repeat(64),
    byteLength: 1,
    ...overrides,
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

  it("deletes unchanged base runs unilaterally and bilaterally", () => {
    const base = snapshot({ runs: [run("run-delete")] });
    const unilateral = mergedSnapshot(
      mergeCalibrationHarnessSnapshots(base, { ...clone(base), runs: [] }, clone(base))
    );
    const bilateral = mergedSnapshot(
      mergeCalibrationHarnessSnapshots(base, { ...clone(base), runs: [] }, { ...clone(base), runs: [] })
    );

    expect(unilateral.runs).toEqual([]);
    expect(bilateral.runs).toEqual([]);
  });

  it("selects an asset replacement only when the opposite side remains at the common base", () => {
    const base = snapshot({ assets: [asset()] });
    const left = clone(base);
    left.assets[0] = asset("asset-1", { sha256: "b".repeat(64), byteLength: 2 });

    const selected = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, left, clone(base)));
    const reversed = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, clone(base), left));
    const deleted = mergedSnapshot(
      mergeCalibrationHarnessSnapshots(base, { ...clone(base), assets: [] }, clone(base))
    );

    expect(selected.assets).toEqual([left.assets[0]]);
    expect(reversed.assets).toEqual([left.assets[0]]);
    expect(deleted.assets).toEqual([]);
  });

  it("retains actual case and dataset deletions across their related records and optional root metadata", () => {
    const base = snapshot({ assets: [asset()], runs: [run("run-case")] }) as CalibrationHarnessSnapshot & Record<string, unknown>;
    base.runs[0].results.push({ caseId: "case-1", matched: true });
    base.optionalRoot = { retained: true };

    const caseDeletion = clone(base) as CalibrationHarnessSnapshot & Record<string, unknown>;
    caseDeletion.cases = [];
    caseDeletion.assets = [];
    caseDeletion.runs = [];
    delete caseDeletion.optionalRoot;
    const caseMerged = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, caseDeletion, clone(base)));

    expect(caseMerged).toMatchObject({ datasets: [dataset()], cases: [], assets: [], runs: [] });
    expect(caseMerged).not.toHaveProperty("optionalRoot");

    const rootDeletedOnBoth = clone(base) as CalibrationHarnessSnapshot & Record<string, unknown>;
    delete rootDeletedOnBoth.optionalRoot;
    const rootMerged = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, rootDeletedOnBoth, clone(rootDeletedOnBoth)));
    expect(rootMerged).not.toHaveProperty("optionalRoot");

    const datasetDeletion = clone(base) as CalibrationHarnessSnapshot & Record<string, unknown>;
    datasetDeletion.datasets = [];
    datasetDeletion.cases = [];
    datasetDeletion.assets = [];
    datasetDeletion.runs = [];
    const datasetMerged = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, datasetDeletion, clone(datasetDeletion)));
    const unilateralDatasetMerged = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, datasetDeletion, clone(base)));

    expect(datasetMerged).toMatchObject({ datasets: [], cases: [], assets: [], runs: [] });
    expect(unilateralDatasetMerged).toMatchObject({ datasets: [], cases: [], assets: [], runs: [] });
  });

  it("fails closed for deletion versus changed survivors in either branch order", () => {
    const base = snapshot({ assets: [asset()], runs: [run("run-history")] }) as CalibrationHarnessSnapshot & Record<string, unknown>;
    base.optionalRoot = { value: "base" };
    const deletedCase = clone(base);
    deletedCase.cases = [];
    deletedCase.assets = [];
    const changedCase = clone(base);
    changedCase.cases[0].notes = "changed";

    const deletedAsset = clone(base);
    deletedAsset.assets = [];
    const changedAsset = clone(base);
    changedAsset.assets[0] = asset("asset-1", { sha256: "b".repeat(64), byteLength: 2 });

    const deletedRun = clone(base);
    deletedRun.runs = [];
    const changedRun = clone(base);
    changedRun.runs[0].algorithmLabel = "changed";
    const deletedRoot = clone(base) as CalibrationHarnessSnapshot & Record<string, unknown>;
    delete deletedRoot.optionalRoot;
    const changedRoot = clone(base) as CalibrationHarnessSnapshot & Record<string, unknown>;
    changedRoot.optionalRoot = { value: "changed" };

    for (const result of [
      mergeCalibrationHarnessSnapshots(base, deletedCase, changedCase),
      mergeCalibrationHarnessSnapshots(base, changedCase, deletedCase),
      mergeCalibrationHarnessSnapshots(base, deletedAsset, changedAsset),
      mergeCalibrationHarnessSnapshots(base, changedAsset, deletedAsset),
      mergeCalibrationHarnessSnapshots(base, deletedRun, changedRun),
      mergeCalibrationHarnessSnapshots(base, changedRun, deletedRun),
      mergeCalibrationHarnessSnapshots(base, deletedRoot, changedRoot),
      mergeCalibrationHarnessSnapshots(base, changedRoot, deletedRoot),
    ]) {
      expect(result).toMatchObject({ ok: false });
      expect(result).not.toHaveProperty("snapshot");
    }
  });

  it("fails validation without publishing when a deletion leaves an independently added related record", () => {
    const base = snapshot();
    const deletedCase = clone(base);
    deletedCase.cases = [];
    const addedAsset = clone(base);
    addedAsset.assets.push(asset("added-asset"));

    const result = mergeCalibrationHarnessSnapshots(base, deletedCase, addedAsset);

    expect(result).toMatchObject({
      ok: false,
      conflicts: [expect.objectContaining({ kind: "invalid-merged-snapshot" })],
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("fails incompatible asset replacements and slot collisions while retaining idempotent additions", () => {
    const base = snapshot({ assets: [asset()] });
    const leftReplacement = clone(base);
    leftReplacement.assets[0] = asset("asset-1", { sha256: "b".repeat(64), byteLength: 2 });
    const rightReplacement = clone(base);
    rightReplacement.assets[0] = asset("asset-1", { sha256: "c".repeat(64), byteLength: 3 });

    const incompatible = mergeCalibrationHarnessSnapshots(base, leftReplacement, rightReplacement);
    expect(incompatible).toMatchObject({
      ok: false,
      conflicts: [expect.objectContaining({ collection: "assets", id: "asset-1", kind: "asset-divergence" })],
    });
    expect(incompatible).not.toHaveProperty("snapshot");

    const emptyAssets = snapshot();
    const leftSlot = clone(emptyAssets);
    leftSlot.assets.push(asset("asset-left"));
    const rightSlot = clone(emptyAssets);
    rightSlot.assets.push(asset("asset-right", { sha256: "b".repeat(64) }));
    const slotCollision = mergeCalibrationHarnessSnapshots(emptyAssets, leftSlot, rightSlot);
    expect(slotCollision).toMatchObject({
      ok: false,
      conflicts: [expect.objectContaining({ collection: "assets", kind: "asset-divergence" })],
    });
    expect(slotCollision).not.toHaveProperty("snapshot");

    const sameAddition = clone(emptyAssets);
    sameAddition.assets.push(asset("asset-same"));
    const idempotent = mergedSnapshot(mergeCalibrationHarnessSnapshots(emptyAssets, sameAddition, clone(sameAddition)));
    expect(idempotent.assets).toEqual([asset("asset-same")]);

    const differingAddition = clone(sameAddition);
    differingAddition.assets[0] = asset("asset-same", { sha256: "c".repeat(64) });
    const sameIdConflict = mergeCalibrationHarnessSnapshots(emptyAssets, sameAddition, differingAddition);
    expect(sameIdConflict).toMatchObject({
      ok: false,
      conflicts: [expect.objectContaining({ collection: "assets", id: "asset-same", kind: "asset-divergence" })],
    });
    expect(sameIdConflict).not.toHaveProperty("snapshot");
  });

  it("keeps NUL and prototype-looking literal ids distinct in deterministic new-id order", () => {
    const base = snapshot({ datasets: [dataset(), dataset("__proto__")] });
    const left = clone(base);
    left.cases.push(calibrationCase("\u0000case", "__proto__"));
    const right = clone(base);
    right.cases.push(calibrationCase("constructor"));

    const merged = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, left, right));

    expect(merged.cases.map((entry) => entry.id)).toEqual(["case-1", "\u0000case", "constructor"]);
  });

  it("deletes a base case when the other side leaves it unchanged", () => {
    const base = snapshot();
    const deletion = mergedSnapshot(
      mergeCalibrationHarnessSnapshots(base, { ...clone(base), cases: [] }, clone(base))
    );

    expect(deletion.cases).toEqual([]);
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

  it("merges independent case edits when both sides only advance the parent dataset timestamp", () => {
    const base = snapshot();
    const left = clone(base);
    left.datasets[0].updatedAt = 4;
    left.cases[0].notes = "left case edit";
    const right = clone(base);
    right.datasets[0].updatedAt = 9;
    right.cases.push(calibrationCase("case-2"));
    const before = [canonicalHarnessJson(base), canonicalHarnessJson(left), canonicalHarnessJson(right)];

    const first = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, left, right));
    const repeated = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, left, right));
    const second = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, right, left));

    expect(first.datasets[0]).toEqual({ ...base.datasets[0], updatedAt: 9 });
    expect(first.cases).toMatchObject([
      { id: "case-1", notes: "left case edit" },
      { id: "case-2" },
    ]);
    expect(canonicalHarnessJson(first)).toBe(canonicalHarnessJson(repeated));
    expect(canonicalHarnessJson(first)).toBe(canonicalHarnessJson(second));
    expect([canonicalHarnessJson(base), canonicalHarnessJson(left), canonicalHarnessJson(right)]).toEqual(before);
  });

  it("preserves an exact substantive dataset edit against a peer parent timestamp update", () => {
    const base = snapshot();
    const left = clone(base) as CalibrationHarnessSnapshot & Record<string, unknown>;
    left.datasets[0] = {
      ...left.datasets[0],
      name: "substantive dataset edit",
      unknownDatasetMetadata: { nested: ["first", { retained: true }] },
      updatedAt: 4,
    };
    const right = clone(base);
    right.datasets[0].updatedAt = 11;
    const expected = clone(left.datasets[0]);
    expected.updatedAt = 11;
    const before = [canonicalHarnessJson(base), canonicalHarnessJson(left), canonicalHarnessJson(right)];

    const merged = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, left, right));
    const reversed = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, right, left));

    expect(merged.datasets).toEqual([expected]);
    expect(canonicalHarnessJson(merged)).toBe(canonicalHarnessJson(reversed));
    expect([canonicalHarnessJson(base), canonicalHarnessJson(left), canonicalHarnessJson(right)]).toEqual(before);
  });

  it("retains unchanged and idempotent dataset records while advancing only their generated timestamp", () => {
    const base = snapshot();
    const unchanged = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, clone(base), clone(base)));
    const advanced = clone(base);
    advanced.datasets[0].updatedAt = 8;

    const merged = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, advanced, clone(base)));
    const idempotent = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, advanced, clone(advanced)));

    expect(unchanged).toEqual(base);
    expect(merged.datasets[0]).toEqual({ ...base.datasets[0], updatedAt: 8 });
    expect(idempotent.datasets[0]).toEqual({ ...base.datasets[0], updatedAt: 8 });
  });

  it("retains divergent dataset edits and unknown nested-array distinctions as fail-closed conflicts", () => {
    const base = snapshot() as CalibrationHarnessSnapshot & Record<string, unknown>;
    base.datasets[0] = {
      ...base.datasets[0],
      unknownDatasetMetadata: { nested: ["base", "order"] },
    };
    const left = clone(base);
    left.datasets[0] = {
      ...left.datasets[0],
      name: "left dataset edit",
      unknownDatasetMetadata: { nested: ["left", "order"] },
      updatedAt: 4,
    };
    const right = clone(base);
    right.datasets[0] = {
      ...right.datasets[0],
      name: "right dataset edit",
      unknownDatasetMetadata: { nested: ["order", "right"] },
      updatedAt: 9,
    };

    const result = mergeCalibrationHarnessSnapshots(base, left, right);

    expect(result).toMatchObject({
      ok: false,
      conflicts: [expect.objectContaining({ collection: "datasets", id: "dataset-1", kind: "divergent-edit" })],
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("keeps dataset deletion and distinct same-id additions as conflicts despite timestamp handling", () => {
    const base = snapshot();
    const deleted = clone(base);
    deleted.datasets = [];
    deleted.cases = [];
    const timestampOnly = clone(base);
    timestampOnly.datasets[0].updatedAt = 5;
    const deletionResult = mergeCalibrationHarnessSnapshots(base, deleted, timestampOnly);

    expect(deletionResult).toMatchObject({
      ok: false,
      conflicts: [expect.objectContaining({ collection: "datasets", id: "dataset-1", kind: "divergent-edit" })],
    });
    expect(deletionResult).not.toHaveProperty("snapshot");

    const empty = snapshot({ datasets: [], cases: [] });
    const left = clone(empty);
    left.datasets.push({ ...dataset("dataset-added"), name: "left addition", updatedAt: 3 });
    const right = clone(empty);
    right.datasets.push({ ...dataset("dataset-added"), name: "right addition", updatedAt: 7 });
    const additionResult = mergeCalibrationHarnessSnapshots(empty, left, right);

    expect(additionResult).toMatchObject({
      ok: false,
      conflicts: [expect.objectContaining({ collection: "datasets", id: "dataset-added", kind: "divergent-edit" })],
    });
    expect(additionResult).not.toHaveProperty("snapshot");
  });

  it("leaves case, asset, and immutable-run semantics unchanged beside a parent timestamp update", () => {
    const base = snapshot({ assets: [asset()], runs: [run("run-base")] });
    const changedCase = clone(base);
    changedCase.datasets[0].updatedAt = 4;
    changedCase.cases[0].notes = "case edit";
    const caseMerged = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, changedCase, clone(base)));
    expect(caseMerged.cases[0].notes).toBe("case edit");

    const changedAsset = clone(base);
    changedAsset.datasets[0].updatedAt = 5;
    changedAsset.assets[0] = asset("asset-1", { sha256: "b".repeat(64), byteLength: 2 });
    const assetMerged = mergedSnapshot(mergeCalibrationHarnessSnapshots(base, changedAsset, clone(base)));
    expect(assetMerged.assets).toEqual(changedAsset.assets);

    const changedRun = clone(base);
    changedRun.datasets[0].updatedAt = 6;
    changedRun.runs[0].algorithmLabel = "changed";
    const runResult = mergeCalibrationHarnessSnapshots(base, changedRun, clone(base));
    expect(runResult).toMatchObject({
      ok: false,
      conflicts: [expect.objectContaining({ collection: "runs", id: "run-base", kind: "immutable-run-change" })],
    });
    expect(runResult).not.toHaveProperty("snapshot");
  });

  it("keeps malformed dataset timestamps under existing validation rather than coercing them", () => {
    const base = snapshot();
    const malformed = clone(base);
    (malformed.datasets[0] as unknown as { updatedAt: unknown }).updatedAt = "9";

    expect(() => mergeCalibrationHarnessSnapshots(base, malformed, clone(base))).toThrow(
      CalibrationHarnessValidationError
    );
  });
});
