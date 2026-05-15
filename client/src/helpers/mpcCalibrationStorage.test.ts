import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";

const mockMarkMpcPreferenceSyncDirty = vi.hoisted(() => vi.fn());

vi.mock("./mpcPreferenceSync", () => ({
  markMpcPreferenceSyncDirty: mockMarkMpcPreferenceSyncDirty,
}));

import {
  createMpcCalibrationDataset,
  deleteMpcCalibrationCase,
  deleteMpcCalibrationDataset,
  getMpcCalibrationCase,
  getMpcCalibrationDataset,
  getMpcCalibrationPreferenceProfile,
  getMpcCalibrationPreferredIdentifier,
  listDefaultMpcCalibrationCases,
  listMpcCalibrationAssets,
  listMpcCalibrationCases,
  listMpcCalibrationDatasets,
  listMpcCalibrationRuns,
  saveMpcCalibrationAssets,
  saveMpcCalibrationCase,
  saveMpcCalibrationRun,
  updateMpcCalibrationDataset,
} from "./mpcCalibrationStorage";
import type { MpcAutofillCard } from "./mpcAutofillApi";

function makeCandidate(
  overrides: Partial<MpcAutofillCard> & Pick<MpcAutofillCard, "identifier">
): MpcAutofillCard {
  return {
    name: "Aven Mindcensor",
    rawName: "Aven Mindcensor",
    smallThumbnailUrl: "",
    mediumThumbnailUrl: "",
    imageUrl: "fixture://candidate",
    dpi: 1200,
    tags: [],
    sourceName: "MrTeferi",
    source: "MrTeferi",
    extension: "png",
    size: 100,
    ...overrides,
  };
}

describe("mpcCalibrationStorage", () => {
  beforeEach(async () => {
    await db.mpcCalibrationRuns.clear();
    await db.mpcCalibrationAssets.clear();
    await db.mpcCalibrationCases.clear();
    await db.mpcCalibrationDatasets.clear();
    mockMarkMpcPreferenceSyncDirty.mockClear();
  });

  it("creates and lists datasets", async () => {
    const dataset = await createMpcCalibrationDataset({ name: "My Dataset" });

    const listed = await listMpcCalibrationDatasets();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(dataset);
  });

  it("updates and retrieves dataset metadata", async () => {
    const dataset = await createMpcCalibrationDataset({
      name: "Original Dataset",
      description: "before",
      targetCaseCount: 3,
    });

    await updateMpcCalibrationDataset(dataset.id, {
      name: "Updated Dataset",
      description: "after",
      targetCaseCount: 5,
    });

    await expect(getMpcCalibrationDataset(dataset.id)).resolves.toEqual(
      expect.objectContaining({
        name: "Updated Dataset",
        description: "after",
        targetCaseCount: 5,
      })
    );
  });

  it("persists cases, assets, and runs", async () => {
    const dataset = await createMpcCalibrationDataset({ name: "Case Dataset" });

    await saveMpcCalibrationCase({
      id: "case-1",
      datasetId: dataset.id,
      source: { name: "Sol Ring" },
      candidates: [],
      expectedIdentifier: "candidate-1",
    });
    await saveMpcCalibrationAssets([
      {
        id: "asset-1",
        datasetId: dataset.id,
        caseId: "case-1",
        role: "source",
        mimeType: "image/png",
        blob: new Blob(["source"], { type: "image/png" }),
        createdAt: 1,
      },
    ]);
    await saveMpcCalibrationRun({
      id: "run-1",
      datasetId: dataset.id,
      algorithmId: "baseline",
      summary: {
        totalCases: 1,
        matchedCases: 1,
        mismatchedCases: 0,
        accuracy: 1,
      },
      results: [
        {
          caseId: "case-1",
          expectedIdentifier: "candidate-1",
          predictedIdentifier: "candidate-1",
          matched: true,
        },
      ],
    });

    const [cases, assets, runs] = await Promise.all([
      listMpcCalibrationCases(dataset.id),
      listMpcCalibrationAssets(dataset.id),
      listMpcCalibrationRuns(dataset.id),
    ]);

    expect(cases).toHaveLength(1);
    expect(assets).toHaveLength(1);
    await expect(listMpcCalibrationAssets(dataset.id, "case-1")).resolves.toHaveLength(1);
    await expect(listMpcCalibrationAssets(dataset.id, "missing")).resolves.toEqual([]);
    expect(runs).toHaveLength(1);
    expect(mockMarkMpcPreferenceSyncDirty).toHaveBeenCalledTimes(1);
  });

  it("preserves case creation timestamps across updates and supports explicit timestamps", async () => {
    const dataset = await createMpcCalibrationDataset({ name: "Case Dataset" });

    const created = await saveMpcCalibrationCase({
      id: "case-1",
      datasetId: dataset.id,
      source: { name: "Sol Ring" },
      candidates: [],
      createdAt: 10,
      updatedAt: 20,
    });
    const updated = await saveMpcCalibrationCase({
      id: "case-1",
      datasetId: dataset.id,
      source: { name: "Sol Ring" },
      candidates: [],
      expectedIdentifier: "preferred",
      updatedAt: 30,
    });

    expect(created.createdAt).toBe(10);
    expect(updated.createdAt).toBe(10);
    expect(updated.updatedAt).toBe(30);
    await expect(getMpcCalibrationCase("case-1")).resolves.toEqual(updated);
  });

  it("ignores empty asset saves and preserves explicit run creation timestamps", async () => {
    const dataset = await createMpcCalibrationDataset({ name: "Run Dataset" });

    await expect(saveMpcCalibrationAssets([])).resolves.toBeUndefined();
    const run = await saveMpcCalibrationRun({
      id: "run-explicit",
      datasetId: dataset.id,
      algorithmId: "baseline",
      createdAt: 123,
      summary: {
        totalCases: 0,
        matchedCases: 0,
        mismatchedCases: 0,
        accuracy: 0,
      },
      results: [],
    });

    expect(run.createdAt).toBe(123);
    await expect(listMpcCalibrationAssets(dataset.id)).resolves.toEqual([]);
  });

  it("deletes datasets and cascades related records", async () => {
    const dataset = await createMpcCalibrationDataset({
      name: "Delete Dataset",
    });

    await saveMpcCalibrationCase({
      id: "case-1",
      datasetId: dataset.id,
      source: { name: "Sol Ring" },
      candidates: [],
    });
    await saveMpcCalibrationAssets([
      {
        id: "asset-1",
        datasetId: dataset.id,
        caseId: "case-1",
        role: "source",
        mimeType: "image/png",
        blob: new Blob(["source"], { type: "image/png" }),
        createdAt: 1,
      },
    ]);
    await saveMpcCalibrationRun({
      id: "run-1",
      datasetId: dataset.id,
      algorithmId: "baseline",
      summary: {
        totalCases: 1,
        matchedCases: 0,
        mismatchedCases: 1,
        accuracy: 0,
      },
      results: [],
    });

    await deleteMpcCalibrationDataset(dataset.id);

    expect(await listMpcCalibrationDatasets()).toEqual([]);
    expect(await listMpcCalibrationCases(dataset.id)).toEqual([]);
    expect(await listMpcCalibrationAssets(dataset.id)).toEqual([]);
    expect(await listMpcCalibrationRuns(dataset.id)).toEqual([]);
  });

  it("deletes a single case with related assets and affected runs", async () => {
    const dataset = await createMpcCalibrationDataset({
      name: "Delete Case Dataset",
    });

    await saveMpcCalibrationCase({
      id: "case-1",
      datasetId: dataset.id,
      source: { name: "Sol Ring" },
      candidates: [],
    });
    await saveMpcCalibrationCase({
      id: "case-2",
      datasetId: dataset.id,
      source: { name: "Counterspell" },
      candidates: [],
    });
    await saveMpcCalibrationCase({
      id: "case-3",
      datasetId: dataset.id,
      source: { name: "No Relations" },
      candidates: [],
    });
    await saveMpcCalibrationAssets([
      {
        id: "asset-1",
        datasetId: dataset.id,
        caseId: "case-1",
        role: "source",
        mimeType: "image/png",
        blob: new Blob(["source"], { type: "image/png" }),
        createdAt: 1,
      },
    ]);
    await saveMpcCalibrationRun({
      id: "run-affected",
      datasetId: dataset.id,
      algorithmId: "baseline",
      summary: {
        totalCases: 1,
        matchedCases: 0,
        mismatchedCases: 1,
        accuracy: 0,
      },
      results: [
        {
          caseId: "case-1",
          expectedIdentifier: "expected",
          predictedIdentifier: "other",
          matched: false,
        },
      ],
    });
    await saveMpcCalibrationRun({
      id: "run-kept",
      datasetId: dataset.id,
      algorithmId: "baseline",
      summary: {
        totalCases: 1,
        matchedCases: 1,
        mismatchedCases: 0,
        accuracy: 1,
      },
      results: [
        {
          caseId: "case-2",
          expectedIdentifier: "expected",
          predictedIdentifier: "expected",
          matched: true,
        },
      ],
    });

    await deleteMpcCalibrationCase("case-1");
    await deleteMpcCalibrationCase("missing-case");

    await expect(listMpcCalibrationCases(dataset.id)).resolves.toEqual([
      expect.objectContaining({ id: "case-2" }),
      expect.objectContaining({ id: "case-3" }),
    ]);
    await expect(listMpcCalibrationAssets(dataset.id)).resolves.toEqual([]);
    await expect(listMpcCalibrationRuns(dataset.id)).resolves.toEqual([
      expect.objectContaining({ id: "run-kept" }),
    ]);

    await deleteMpcCalibrationCase("case-3");

    await expect(listMpcCalibrationCases(dataset.id)).resolves.toEqual([
      expect.objectContaining({ id: "case-2" }),
    ]);
  });

  it("deletes datasets without related child records", async () => {
    const dataset = await createMpcCalibrationDataset({
      name: "Empty Delete Dataset",
    });

    await deleteMpcCalibrationDataset(dataset.id);

    await expect(getMpcCalibrationDataset(dataset.id)).resolves.toBeUndefined();
  });

  it("returns the preferred identifier for exact card matches", async () => {
    const dataset = await createMpcCalibrationDataset({
      name: "MPC Calibration Harness",
    });

    await saveMpcCalibrationCase({
      id: "case-1",
      datasetId: dataset.id,
      source: {
        name: "Sol Ring",
        set: "C21",
        collectorNumber: "267",
      },
      candidates: [],
      expectedIdentifier: "preferred-sol-ring",
    });

    await saveMpcCalibrationCase({
      id: "case-2",
      datasetId: dataset.id,
      source: {
        name: "Counterspell",
      },
      candidates: [],
      expectedIdentifier: "preferred-counterspell",
    });

    expect(
      await getMpcCalibrationPreferredIdentifier({
        name: "Sol Ring",
        set: "C21",
        collectorNumber: "267",
      })
    ).toBe("preferred-sol-ring");

    expect(
      await getMpcCalibrationPreferredIdentifier({ name: "Counterspell" })
    ).toBe("preferred-counterspell");

    expect(
      await getMpcCalibrationPreferredIdentifier({
        name: "Counterspell",
        set: "M21",
      })
    ).toBe("preferred-counterspell");
  });

  it("lists default calibration cases across default datasets and returns undefined for misses", async () => {
    const defaultDataset = await createMpcCalibrationDataset({
      name: "MPC Calibration Harness",
    });
    const otherDataset = await createMpcCalibrationDataset({
      name: "Other Harness",
    });

    await saveMpcCalibrationCase({
      id: "case-default",
      datasetId: defaultDataset.id,
      source: { name: "Sol Ring" },
      candidates: [],
      expectedIdentifier: "preferred-sol-ring",
    });
    await saveMpcCalibrationCase({
      id: "case-other",
      datasetId: otherDataset.id,
      source: { name: "Sol Ring" },
      candidates: [],
      expectedIdentifier: "ignored",
    });

    await expect(listDefaultMpcCalibrationCases()).resolves.toEqual([
      expect.objectContaining({ id: "case-default" }),
    ]);
    await expect(
      getMpcCalibrationPreferredIdentifier({ name: "Missing Card" })
    ).resolves.toBeUndefined();
  });

  it("returns empty preference lookups when calibration tables are unavailable", async () => {
    const originalDatasets = db.mpcCalibrationDatasets;
    const originalCases = db.mpcCalibrationCases;

    try {
      (db as typeof db & {
        mpcCalibrationDatasets?: undefined;
        mpcCalibrationCases?: undefined;
      }).mpcCalibrationDatasets = undefined;
      (db as typeof db & {
        mpcCalibrationDatasets?: undefined;
        mpcCalibrationCases?: undefined;
      }).mpcCalibrationCases = undefined;

      await expect(listDefaultMpcCalibrationCases()).resolves.toEqual([]);
      await expect(
        getMpcCalibrationPreferredIdentifier({ name: "Sol Ring" })
      ).resolves.toBeUndefined();
      await expect(
        getMpcCalibrationPreferenceProfile({ name: "Sol Ring" })
      ).resolves.toBeUndefined();
    } finally {
      (db as typeof db & {
        mpcCalibrationDatasets: typeof originalDatasets;
        mpcCalibrationCases: typeof originalCases;
      }).mpcCalibrationDatasets = originalDatasets;
      (db as typeof db & {
        mpcCalibrationDatasets: typeof originalDatasets;
        mpcCalibrationCases: typeof originalCases;
      }).mpcCalibrationCases = originalCases;
    }
  });

  it("builds a learned preference profile from the expected candidate", async () => {
    const dataset = await createMpcCalibrationDataset({
      name: "MPC Calibration Harness",
    });

    await saveMpcCalibrationCase({
      id: "case-1",
      datasetId: dataset.id,
      source: {
        name: "Aven Mindcensor",
        set: "AKH",
        collectorNumber: "5",
      },
      candidates: [
        makeCandidate({
          identifier: "expected",
          rawName: "Aven Mindcensor [AKH] {5}",
          tags: ["Borderless"],
          sourceName: "MrTeferi",
        }),
      ],
      expectedIdentifier: "expected",
    });

    expect(
      await getMpcCalibrationPreferenceProfile({
        name: "Aven Mindcensor",
        set: "AKH",
        collectorNumber: "5",
      })
    ).toEqual(
      expect.objectContaining({
        sourceName: "MrTeferi",
        rawName: "Aven Mindcensor [AKH] {5}",
        hasBracketSet: true,
      })
    );
  });

  it("falls back to by-name preference profiles and ignores unresolved expected candidates", async () => {
    const dataset = await createMpcCalibrationDataset({
      name: "MPC Calibration Harness",
    });

    await saveMpcCalibrationCase({
      id: "case-unresolved",
      datasetId: dataset.id,
      source: {
        name: "Aven Mindcensor",
        set: "AKH",
        collectorNumber: "5",
      },
      candidates: [makeCandidate({ identifier: "other" })],
      expectedIdentifier: "missing",
    });
    await saveMpcCalibrationCase({
      id: "case-by-name",
      datasetId: dataset.id,
      source: {
        name: "Aven Mindcensor",
      },
      candidates: [
        makeCandidate({
          identifier: "expected",
          name: "Aven Mindcensor",
          rawName: undefined as never,
          tags: [],
        }),
      ],
      expectedIdentifier: "expected",
    });
    await saveMpcCalibrationCase({
      id: "case-without-expected",
      datasetId: dataset.id,
      source: {
        name: "No Expected",
      },
      candidates: [makeCandidate({ identifier: "candidate" })],
    });

    await expect(
      getMpcCalibrationPreferenceProfile({
        name: "Aven Mindcensor",
        set: "AKH",
        collectorNumber: "5",
      })
    ).resolves.toEqual(
      expect.objectContaining({
        rawName: "Aven Mindcensor",
        parenText: undefined,
        hasBracketSet: false,
      })
    );
    await expect(
      getMpcCalibrationPreferenceProfile({ name: "Missing Card" })
    ).resolves.toBeUndefined();
    await expect(
      getMpcCalibrationPreferenceProfile({ name: "No Expected" })
    ).resolves.toBeUndefined();
  });
});
