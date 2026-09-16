import { describe, expect, it } from "vitest";
import {
  validateCalibrationHarnessSnapshot,
  type CalibrationHarnessSnapshot,
} from "../../../shared/calibrationHarness";
import { unionMergeCalibrationSnapshots } from "./mpcCalibrationReconciliation";

const ASSET_HASH = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";

function candidate(identifier: string) {
  return {
    identifier,
    name: identifier,
    rawName: identifier,
    smallThumbnailUrl: "small",
    mediumThumbnailUrl: "medium",
    imageUrl: "image",
    dpi: 72,
    tags: ["tag"],
    sourceName: "source",
    source: "source",
    extension: "png",
    size: 4,
    retained: { candidate: true },
  };
}

function makeSnapshot(parts: {
  datasetId: string;
  caseId: string;
  runId: string;
  assetId: string;
  candidateIdentifier: string;
  root?: Record<string, unknown>;
}): CalibrationHarnessSnapshot {
  return {
    version: 1,
    ...(parts.root ?? {}),
    datasets: [{
      id: parts.datasetId,
      name: parts.datasetId,
      targetCaseCount: 1,
      createdAt: 1,
      updatedAt: 2,
      version: 1,
      retained: { dataset: true },
    }],
    cases: [{
      id: parts.caseId,
      datasetId: parts.datasetId,
      createdAt: 3,
      updatedAt: 4,
      source: { name: parts.caseId, retained: { source: true } },
      candidates: [candidate(parts.candidateIdentifier)],
      expectedIdentifier: parts.candidateIdentifier,
      notes: parts.caseId,
      comparisonHints: { fullCard: { [parts.candidateIdentifier]: 1 } },
      retained: { calibrationCase: true },
    }],
    assets: [{
      id: parts.assetId,
      datasetId: parts.datasetId,
      caseId: parts.caseId,
      role: "source",
      mimeType: "image/png",
      createdAt: 5,
      hash: "legacy",
      sha256: ASSET_HASH,
      byteLength: 4,
      retained: { asset: true },
    }],
    runs: [{
      id: parts.runId,
      datasetId: parts.datasetId,
      algorithmId: "algorithm",
      algorithmLabel: "Algorithm",
      createdAt: 6,
      summary: { totalCases: 1, matchedCases: 1, mismatchedCases: 0, accuracy: 1 },
      results: [{ caseId: parts.caseId, matched: true, retained: { result: true } }],
      retained: { run: true },
    }],
  } as CalibrationHarnessSnapshot;
}

const localBase = () => makeSnapshot({
  datasetId: "dataset-local",
  caseId: "case-local",
  runId: "run-local",
  assetId: "asset-local",
  candidateIdentifier: "candidate-local",
  root: { schema: "proxxied-mpc-calibration-backup/v1", databaseVersion: 210, assetBytes: 4 },
});
const remoteBase = () => makeSnapshot({
  datasetId: "dataset-remote",
  caseId: "case-remote",
  runId: "run-remote",
  assetId: "asset-remote",
  candidateIdentifier: "candidate-remote",
  root: { schema: "proxxied-mpc-calibration-backup/v1", databaseVersion: 211, assetBytes: 4 },
});

describe("unionMergeCalibrationSnapshots", () => {
  it("unites disjoint snapshots with deterministic ordering and recomputed assetBytes", () => {
    const local = localBase();
    const remote = remoteBase();
    const result = unionMergeCalibrationSnapshots(local, remote);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const merged = result.snapshot;
    expect(merged.datasets.map((record) => record.id)).toEqual(["dataset-local", "dataset-remote"]);
    expect(merged.cases.map((record) => record.id)).toEqual(["case-local", "case-remote"]);
    expect(merged.assets.map((record) => record.id)).toEqual(["asset-local", "asset-remote"]);
    expect(merged.runs.map((record) => record.id)).toEqual(["run-local", "run-remote"]);
    // Local order first, remote-only rows appended in remote order, per table.
    const localAssets = merged.assets.filter((record) => record.caseId === "case-local");
    const remoteAssets = merged.assets.filter((record) => record.caseId === "case-remote");
    expect(localAssets.map((record) => record.id)).toEqual(["asset-local"]);
    expect(remoteAssets.map((record) => record.id)).toEqual(["asset-remote"]);
    expect(result.delta).toEqual({ datasets: 1, cases: 1, runs: 1, assets: 1, localWins: 0 });
    // Root metadata comes from the remote; assetBytes is recomputed from the union.
    expect(merged.databaseVersion).toBe(211);
    expect(merged.assetBytes).toBe(8);
    validateCalibrationHarnessSnapshot(structuredClone(merged));
  });

  it("keeps the local copy when the same id exists on both sides with identical content", () => {
    const local = localBase();
    // Same ids, same content: the remote side is an exact copy of the local.
    const shared = structuredClone(local);
    const result = unionMergeCalibrationSnapshots(local, shared);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.cases).toHaveLength(1);
    expect(result.snapshot.assets).toHaveLength(1);
    expect(result.snapshot.runs).toHaveLength(1);
    expect(result.snapshot.datasets).toHaveLength(1);
    expect(result.delta).toEqual({ datasets: 0, cases: 0, runs: 0, assets: 0, localWins: 0 });
  });

  it("keeps the local copy on same-id divergence and counts the local win", () => {
    const local = localBase();
    const remote = remoteBase();
    // Point the remote rows at the same ids as the local rows with divergent content.
    for (const record of remote.datasets) record.id = "dataset-local";
    for (const record of remote.cases) {
      record.id = "case-local";
      record.datasetId = "dataset-local";
      record.notes = "remote-variant";
      record.candidates = [candidate("candidate-remote")];
      record.expectedIdentifier = "candidate-remote";
      record.comparisonHints = { fullCard: { "candidate-remote": 1 } };
    }
    for (const record of remote.assets) {
      record.datasetId = "dataset-local";
      record.caseId = "case-local";
    }
    for (const record of remote.runs) {
      record.id = "run-local";
      record.datasetId = "dataset-local";
    }

    const result = unionMergeCalibrationSnapshots(local, remote);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const merged = result.snapshot;
    expect(merged.cases).toHaveLength(1);
    expect(merged.cases[0].notes).toBe("case-local"); // local content wins
    expect(merged.cases[0].candidates[0].identifier).toBe("candidate-local");
    // Assets follow the winning (local) case: the remote asset is dropped.
    expect(merged.assets.map((record) => record.id)).toEqual(["asset-local"]);
    expect(result.delta.localWins).toBeGreaterThanOrEqual(2); // divergent case + dataset or run
  });

  it("adopts the remote case's remote assets for remote-only cases", () => {
    const local = localBase();
    const remote = remoteBase();
    const secondRemote = makeSnapshot({
      datasetId: "dataset-remote",
      caseId: "case-remote-2",
      runId: "run-remote-2",
      assetId: "asset-remote-2",
      candidateIdentifier: "candidate-remote-2",
    });
    // Two remote-only cases under the same dataset.
    remote.cases.push(structuredClone(secondRemote.cases[0]));
    remote.assets.push(structuredClone(secondRemote.assets[0]));
    remote.runs.push(structuredClone(secondRemote.runs[0]));

    const result = unionMergeCalibrationSnapshots(local, remote);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.snapshot.cases.map((record) => record.id)).toEqual(["case-local", "case-remote", "case-remote-2"]);
    const remoteAssets = result.snapshot.assets
      .filter((record) => record.caseId === "case-remote" || record.caseId === "case-remote-2")
      .map((record) => record.id);
    expect(remoteAssets.sort()).toEqual(["asset-remote", "asset-remote-2"]);
    expect(result.delta.cases).toBe(2);
    expect(result.delta.assets).toBe(2);
  });

  it("rejects an invalid local snapshot before merging", () => {
    const local = localBase();
    delete (local as Record<string, unknown>).datasets;
    const result = unionMergeCalibrationSnapshots(local, remoteBase());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid-local-snapshot");
  });

  it("rejects an invalid remote snapshot before merging", () => {
    const remote = remoteBase();
    (remote.assets[0] as { caseId: string }).caseId = "missing-case";
    const result = unionMergeCalibrationSnapshots(localBase(), remote);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid-remote-snapshot");
  });

  it("does not mutate its inputs", () => {
    const local = localBase();
    const remote = remoteBase();
    const localBefore = structuredClone(local);
    const remoteBefore = structuredClone(remote);

    unionMergeCalibrationSnapshots(local, remote);

    expect(local).toEqual(localBefore);
    expect(remote).toEqual(remoteBefore);
  });
});
