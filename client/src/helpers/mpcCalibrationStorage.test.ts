import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  createMpcCalibrationDataset,
  deleteMpcCalibrationDataset,
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
});
