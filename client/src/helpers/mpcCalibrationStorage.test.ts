import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  getMpcCalibrationPreferenceProfile,
  createMpcCalibrationDataset,
  deleteMpcCalibrationDataset,
  getMpcCalibrationPreferredIdentifier,
  listMpcCalibrationAssets,
  listMpcCalibrationCases,
  listMpcCalibrationDatasets,
  listMpcCalibrationRuns,
  saveMpcCalibrationAssets,
  saveMpcCalibrationCase,
  saveMpcCalibrationRun,
} from "./mpcCalibrationStorage";

describe("mpcCalibrationStorage", () => {
  beforeEach(async () => {
    await db.mpcCalibrationRuns.clear();
    await db.mpcCalibrationAssets.clear();
    await db.mpcCalibrationCases.clear();
    await db.mpcCalibrationDatasets.clear();
  });

  it("creates and lists datasets", async () => {
    const dataset = await createMpcCalibrationDataset({ name: "My Dataset" });

    const listed = await listMpcCalibrationDatasets();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(dataset);
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
    expect(runs).toHaveLength(1);
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
      },
      candidates: [
        {
          identifier: "expected",
          name: "Aven Mindcensor",
          rawName: "Aven Mindcensor (Rebecca Guay)",
          smallThumbnailUrl: "",
          mediumThumbnailUrl: "",
          imageUrl: "fixture://candidate/expected",
          dpi: 1200,
          tags: [],
          sourceName: "MrTeferi",
          source: "MrTeferi",
          extension: "png",
          size: 100,
        },
      ],
      expectedIdentifier: "expected",
    });

    expect(
      await getMpcCalibrationPreferenceProfile({ name: "Aven Mindcensor" })
    ).toEqual(
      expect.objectContaining({
        sourceName: "MrTeferi",
        rawName: "Aven Mindcensor (Rebecca Guay)",
      })
    );
  });
});
