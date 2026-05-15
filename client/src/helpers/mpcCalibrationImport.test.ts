import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import {
  buildMpcCalibrationFixture,
  downloadMpcCalibrationFixture,
  getMpcCalibrationFixtureFilename,
  importMpcCalibrationFixture,
  migrateMpcCalibrationFixture,
  requestMpcCalibrationSaveHandle,
  saveMpcCalibrationFixture,
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
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (window as Window & { showSaveFilePicker?: unknown })
      .showSaveFilePicker;
    await db.mpcCalibrationRuns.clear();
    await db.mpcCalibrationAssets.clear();
    await db.mpcCalibrationCases.clear();
    await db.mpcCalibrationDatasets.clear();
  });

  it("builds a safe fixture filename from the dataset name", () => {
    expect(
      getMpcCalibrationFixtureFilename({
        dataset: {
          id: "dataset-1",
          name: "Fixture Dataset: v1/alpha",
          targetCaseCount: 1,
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        },
      })
    ).toBe("mpc-calibration_Fixture_Dataset__v1_alpha.json");
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

  it("throws when building a fixture for a missing dataset", async () => {
    await expect(buildMpcCalibrationFixture("missing")).rejects.toThrow(
      "Calibration dataset missing not found"
    );
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

  it("encodes large asset blobs without failing fixture construction", async () => {
    const dataset = await createMpcCalibrationDataset({
      name: "Large Browser Fixture",
    });
    const payload = "A".repeat(0x8000 + 3);

    await saveMpcCalibrationAssets([
      {
        id: "asset-1",
        datasetId: dataset.id,
        caseId: "case-1",
        role: "source",
        mimeType: "application/octet-stream",
        blob: new Blob([payload], { type: "application/octet-stream" }),
        createdAt: 1,
      },
    ]);

    const fixture = await buildMpcCalibrationFixture(dataset.id);

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

  it("rejects malformed calibration fixtures with clear validation errors", () => {
    expect(() => validateMpcCalibrationFixture(null)).toThrow(
      "Invalid calibration fixture: not a JSON object"
    );
    expect(() => validateMpcCalibrationFixture({})).toThrow(
      "Invalid calibration fixture: missing version"
    );
    expect(() => validateMpcCalibrationFixture({ version: 99 })).toThrow(
      "Unsupported calibration fixture version"
    );
    expect(() => validateMpcCalibrationFixture({ version: 1 })).toThrow(
      "Invalid calibration fixture: missing dataset sections"
    );
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

  it("rejects unsupported migration paths below the current fixture version", () => {
    expect(() =>
      migrateMpcCalibrationFixture({
        version: 0,
        exportedAt: new Date().toISOString(),
        dataset: {
          id: "dataset-1",
          name: "Imported Dataset",
          targetCaseCount: 1,
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        },
        cases: [],
        assets: [],
        runs: [],
      })
    ).toThrow("Unsupported calibration fixture migration: v0 → v1");
  });

  it("downloads fixtures through a temporary anchor and revokes the object URL", () => {
    vi.useFakeTimers();
    const createObjectUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob://fixture");
    const revokeObjectUrlSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    downloadMpcCalibrationFixture({
      version: 1,
      exportedAt: new Date().toISOString(),
      dataset: {
        id: "dataset-1",
        name: "Download Fixture",
        targetCaseCount: 1,
        createdAt: 1,
        updatedAt: 1,
        version: 1,
      },
      cases: [],
      assets: [],
      runs: [],
    });

    expect(createObjectUrlSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(document.body.querySelector("a")).toBeNull();

    vi.advanceTimersByTime(1000);
    expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob://fixture");
  });

  it("returns null when the save file picker API is unavailable", async () => {
    await expect(
      requestMpcCalibrationSaveHandle({
        dataset: {
          id: "dataset-1",
          name: "No Picker",
          targetCaseCount: 1,
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        },
      })
    ).resolves.toBeNull();
  });

  it("requests a save file handle with JSON picker options when available", async () => {
    const handle = { createWritable: vi.fn() };
    const showSaveFilePicker = vi.fn(async () => handle);
    (window as Window & {
      showSaveFilePicker: typeof showSaveFilePicker;
    }).showSaveFilePicker = showSaveFilePicker;

    await expect(
      requestMpcCalibrationSaveHandle({
        dataset: {
          id: "dataset-1",
          name: "Picker Dataset",
          targetCaseCount: 1,
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        },
      })
    ).resolves.toBe(handle);
    expect(showSaveFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: "mpc-calibration_Picker_Dataset.json",
        types: [
          {
            description: "JSON",
            accept: { "application/json": [".json"] },
          },
        ],
      })
    );
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

  it("writes fixtures through the picker when a save handle is available", async () => {
    const write = vi.fn();
    const close = vi.fn();
    (window as Window & {
      showSaveFilePicker: NonNullable<
        (Window & { showSaveFilePicker?: unknown })["showSaveFilePicker"]
      >;
    }).showSaveFilePicker = vi.fn(async () => ({
      createWritable: async () => ({
        write,
        close,
      }),
    }));

    await expect(
      saveMpcCalibrationFixture({
        version: 1,
        exportedAt: new Date().toISOString(),
        dataset: {
          id: "dataset-1",
          name: "Picker Dataset",
          targetCaseCount: 1,
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        },
        cases: [],
        assets: [],
        runs: [],
      })
    ).resolves.toBe("picker");
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"version": 1'));
    expect(close).toHaveBeenCalled();
  });

  it("falls back to browser download when a picker handle is unavailable", async () => {
    vi.useFakeTimers();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob://download");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined
    );

    await expect(
      saveMpcCalibrationFixture({
        version: 1,
        exportedAt: new Date().toISOString(),
        dataset: {
          id: "dataset-1",
          name: "Download Dataset",
          targetCaseCount: 1,
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        },
        cases: [],
        assets: [],
        runs: [],
      })
    ).resolves.toBe("download");
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

  it("rethrows write failures when abort is unavailable or also fails", async () => {
    await expect(
      writeMpcCalibrationFixtureToHandle('{"version":1}', {
        createWritable: async () => ({
          write: async () => {
            throw new Error("write failed");
          },
          close: async () => {},
        }),
      })
    ).rejects.toThrow("write failed");

    const abort = vi.fn(async () => {
      throw new Error("abort failed");
    });
    await expect(
      writeMpcCalibrationFixtureToHandle('{"version":1}', {
        createWritable: async () => ({
          write: async () => {
            throw new Error("write failed again");
          },
          close: async () => {},
          abort,
        }),
      })
    ).rejects.toThrow("write failed again");
    expect(abort).toHaveBeenCalled();
  });
});
