import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  buildMpcCalibrationFixture,
  importMpcCalibrationFixture,
  validateMpcCalibrationFixture,
} from "./mpcCalibrationImport";
import {
  createMpcCalibrationDataset,
  listMpcCalibrationAssets,
  listMpcCalibrationCases,
  listMpcCalibrationRuns,
  saveMpcCalibrationAssets,
  saveMpcCalibrationCase,
  saveMpcCalibrationRun,
} from "./mpcCalibrationStorage";

describe("mpcCalibrationImport", () => {
  beforeEach(async () => {
    await db.mpcCalibrationRuns.clear();
    await db.mpcCalibrationAssets.clear();
    await db.mpcCalibrationCases.clear();
    await db.mpcCalibrationDatasets.clear();
  });

  it("builds and validates a versioned fixture", async () => {
    const dataset = await createMpcCalibrationDataset({
      name: "Fixture Dataset",
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
        matchedCases: 1,
        mismatchedCases: 0,
        accuracy: 1,
      },
      results: [],
    });

    const fixture = await buildMpcCalibrationFixture(dataset.id);

    expect(validateMpcCalibrationFixture(fixture)).toEqual(fixture);
    expect(fixture.assets[0]?.data).toBeTruthy();
  });

  it("round-trips fixture import into storage", async () => {
    const fixture = validateMpcCalibrationFixture({
      version: 1,
      exportedAt: new Date().toISOString(),
      dataset: {
        id: "dataset-1",
        name: "Imported Dataset",
        targetCaseCount: 9,
        createdAt: 1,
        updatedAt: 1,
        version: 1,
      },
      cases: [
        {
          id: "case-1",
          datasetId: "dataset-1",
          createdAt: 1,
          updatedAt: 1,
          source: { name: "Sol Ring" },
          candidates: [],
        },
      ],
      assets: [
        {
          id: "asset-1",
          datasetId: "dataset-1",
          caseId: "case-1",
          role: "source",
          mimeType: "image/png",
          data: "c291cmNl",
          createdAt: 1,
        },
      ],
      runs: [
        {
          id: "run-1",
          datasetId: "dataset-1",
          algorithmId: "baseline",
          createdAt: 1,
          summary: {
            totalCases: 1,
            matchedCases: 0,
            mismatchedCases: 1,
            accuracy: 0,
          },
          results: [],
        },
      ],
    });

    await importMpcCalibrationFixture(fixture);

    expect(await listMpcCalibrationCases("dataset-1")).toHaveLength(1);
    expect(await listMpcCalibrationAssets("dataset-1")).toHaveLength(1);
    expect(await listMpcCalibrationRuns("dataset-1")).toHaveLength(1);
  });
});
