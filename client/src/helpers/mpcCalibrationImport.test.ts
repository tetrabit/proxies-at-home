import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import {
  buildMpcCalibrationFixture,
  importMpcCalibrationFixture,
  migrateMpcCalibrationFixture,
  validateMpcCalibrationFixture,
  writeMpcCalibrationFixtureToHandle,
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
import defaultsFixture from "../../tests/fixtures/mpc-preference-defaults.v1.json";
import { buildBootstrapPreferenceDefaults } from "./mpcPreferenceBootstrap";

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

  it("builds fixture assets using browser-safe base64 encoding", async () => {
    const dataset = await createMpcCalibrationDataset({
      name: "Browser Fixture",
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
        blob: new Blob([Uint8Array.from([1, 2, 3, 4])], { type: "image/png" }),
        createdAt: 1,
      },
    ]);

    const btoaSpy = vi.spyOn(globalThis, "btoa");

    const fixture = await buildMpcCalibrationFixture(dataset.id);

    expect(fixture.assets[0]?.data).toBeTruthy();
    expect(btoaSpy).toHaveBeenCalled();
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

  it("keeps current v1 fixtures compatible through the migration path", () => {
    const fixture = {
      version: 1,
      exportedAt: new Date().toISOString(),
      dataset: {
        id: "dataset-1",
        name: "Imported Dataset",
        targetCaseCount: 1,
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
      assets: [],
      runs: [],
    };

    expect(
      migrateMpcCalibrationFixture(validateMpcCalibrationFixture(fixture))
    ).toEqual(fixture);
  });

  it("writes a non-empty JSON payload to the save handle", async () => {
    const write = vi.fn();
    const close = vi.fn();

    await writeMpcCalibrationFixtureToHandle(
      JSON.stringify({ version: 1, dataset: { name: "Fixture" } }),
      {
        createWritable: async () => ({
          write,
          close,
        }),
      }
    );

    expect(write).toHaveBeenCalledWith(expect.stringContaining('"version":1'));
    expect(close).toHaveBeenCalled();
  });

  it("keeps the promoted MPC preference defaults fixture valid", () => {
    expect(defaultsFixture).toEqual(
      expect.objectContaining({
        cases: expect.any(Array),
      })
    );
    expect(defaultsFixture.cases[0]).toEqual(
      expect.objectContaining({
        name: expect.any(String),
        expectedIdentifier: expect.any(String),
        candidates: expect.any(Array),
      })
    );
    expect(buildBootstrapPreferenceDefaults().cases.length).toBeGreaterThan(0);
  });

  it("aborts the writable when writing the payload fails", async () => {
    const abort = vi.fn(async () => undefined);

    await expect(
      writeMpcCalibrationFixtureToHandle('{"version":1}', {
        createWritable: async () => ({
          write: async () => {
            throw new Error("disk full");
          },
          close: async () => {},
          abort,
        }),
      })
    ).rejects.toThrow("disk full");

    expect(abort).toHaveBeenCalled();
  });
});
