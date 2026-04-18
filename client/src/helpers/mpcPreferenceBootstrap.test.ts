import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import {
  buildBootstrapPreferenceDefaults,
  buildBootstrapPreferenceFixture,
  BOOTSTRAP_PREFERENCE_SOURCES,
  ensureBootstrapPreferenceDataset,
  harvestSourcePreferenceCandidates,
  hydrateMpcPreferences,
  mergeMpcPreferenceFixtures,
} from "./mpcPreferenceBootstrap";
import {
  createMpcCalibrationDataset,
  listDefaultMpcCalibrationCases,
  MPC_CALIBRATION_DEFAULT_DATASET_NAME,
  saveMpcCalibrationCase,
} from "./mpcCalibrationStorage";
import * as fsAccessPreferenceTargetModule from "./fsAccessPreferenceTarget";
import * as mpcPreferenceSyncModule from "./mpcPreferenceSync";

describe("mpcPreferenceBootstrap", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    delete window.electronAPI;
    await db.mpcCalibrationRuns.clear();
    await db.mpcCalibrationAssets.clear();
    await db.mpcCalibrationCases.clear();
    await db.mpcCalibrationDatasets.clear();
  });

  it("builds a bootstrap fixture using Hathwellcrisping and Chilli_Axe examples", () => {
    const fixture = buildBootstrapPreferenceFixture();

    expect(fixture.cases.length).toBeGreaterThan(0);
    for (const calibrationCase of fixture.cases) {
      const expected = calibrationCase.candidates.find(
        (candidate) =>
          candidate.identifier === calibrationCase.expectedIdentifier
      );
      expect(expected).toBeTruthy();
      expect(BOOTSTRAP_PREFERENCE_SOURCES).toContain(expected?.sourceName);
    }
  });

  it("merges user preference overrides without dropping additive defaults", () => {
    const defaults = buildBootstrapPreferenceDefaults();
    const defaultCase = defaults.cases[0]!;
    const additiveCase = defaults.cases[1]!;

    const merged = mergeMpcPreferenceFixtures(defaults, {
      version: 1,
      exportedAt: new Date(1).toISOString(),
      cases: [
        {
          ...defaultCase,
          expectedIdentifier: `${defaultCase.expectedIdentifier}-override`,
        },
        {
          ...additiveCase,
          source: { name: `${additiveCase.source.name} Override` },
        },
      ],
    });

    expect(
      merged.cases.find(
        (calibrationCase) => calibrationCase.source.name === defaultCase.source.name
      )?.expectedIdentifier
    ).toBe(`${defaultCase.expectedIdentifier}-override`);
    expect(
      merged.cases.some(
        (calibrationCase) =>
          calibrationCase.source.name === `${additiveCase.source.name} Override`
      )
    ).toBe(true);
    expect(merged.cases).toHaveLength(defaults.cases.length + 1);
  });

  it("seeds the default calibration dataset when none exists", async () => {
    await hydrateMpcPreferences();
    const cases = await listDefaultMpcCalibrationCases();

    expect(cases.length).toBeGreaterThan(0);
  });

  it("does not duplicate seed data when default calibration cases already exist", async () => {
    await hydrateMpcPreferences();
    const firstCount = (await listDefaultMpcCalibrationCases()).length;

    await hydrateMpcPreferences();
    const secondCount = (await listDefaultMpcCalibrationCases()).length;

    expect(secondCount).toBe(firstCount);
  });

  it("hydrates Electron user overrides when the Electron preference bridge is available", async () => {
    const loadMpcPreferences = vi.fn().mockResolvedValue({
      version: 1,
      exportedAt: new Date(3).toISOString(),
      cases: [
        {
          source: { name: "Thalia, Guardian of Thraben" },
          candidates: [],
          expectedIdentifier: "electron-override",
        },
      ],
    });

    window.electronAPI = {
      serverUrl: vi.fn(),
      getAppVersion: vi.fn(),
      getUpdateChannel: vi.fn(),
      setUpdateChannel: vi.fn(),
      getAutoUpdateEnabled: vi.fn(),
      setAutoUpdateEnabled: vi.fn(),
      onUpdateStatus: vi.fn(),
      onShowAbout: vi.fn(),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      installUpdate: vi.fn(),
      loadMpcPreferences,
      saveMpcPreferences: vi.fn(),
    };

    await hydrateMpcPreferences();

    const cases = await listDefaultMpcCalibrationCases();
    expect(loadMpcPreferences).toHaveBeenCalledTimes(1);
    expect(
      cases.find(
        (calibrationCase) =>
          calibrationCase.source.name === "Thalia, Guardian of Thraben"
      )?.expectedIdentifier
    ).toBe("electron-override");
  });

  it("hydrates FS access user overrides when Electron is unavailable", async () => {
    const fsAccessSpy = vi
      .spyOn(fsAccessPreferenceTargetModule, "isFsAccessPreferenceSyncAvailable")
      .mockReturnValue(true);
    const loadSpy = vi
      .spyOn(fsAccessPreferenceTargetModule.fsAccessPreferenceTarget, "load")
      .mockResolvedValue({
        version: 1,
        exportedAt: new Date(4).toISOString(),
        cases: [
          {
            source: { name: "Sun Titan" },
            candidates: [],
            expectedIdentifier: "fs-access-override",
          },
        ],
      });

    await hydrateMpcPreferences();

    const cases = await listDefaultMpcCalibrationCases();
    expect(fsAccessSpy).toHaveBeenCalled();
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(
      cases.find((calibrationCase) => calibrationCase.source.name === "Sun Titan")
        ?.expectedIdentifier
    ).toBe("fs-access-override");
  });

  it("rescues legacy IndexedDB-only preferences into the active target when no user file exists", async () => {
    const writeSpy = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(mpcPreferenceSyncModule, "loadActivePreferenceOverrides").mockResolvedValue({
      target: {
        load: vi.fn().mockResolvedValue(null),
        write: writeSpy,
        describe: () => "Server",
      },
      fixture: null,
    });

    const dataset = await createMpcCalibrationDataset({
      name: MPC_CALIBRATION_DEFAULT_DATASET_NAME,
    });
    await saveMpcCalibrationCase({
      id: "legacy-case",
      datasetId: dataset.id,
      source: { name: "Counterspell" },
      candidates: [],
      expectedIdentifier: "legacy-preference",
    });

    await hydrateMpcPreferences();

    expect(writeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cases: [
          expect.objectContaining({
            source: { name: "Counterspell" },
            expectedIdentifier: "legacy-preference",
          }),
        ],
      })
    );
  });

  it("does not clobber existing Dexie preference data once defaults are present", async () => {
    const dataset = await createMpcCalibrationDataset({
      name: MPC_CALIBRATION_DEFAULT_DATASET_NAME,
    });
    await saveMpcCalibrationCase({
      id: "existing-case",
      datasetId: dataset.id,
      source: { name: "Sol Ring" },
      candidates: [],
      expectedIdentifier: "existing-preference",
    });

    await hydrateMpcPreferences({
      version: 1,
      exportedAt: new Date(2).toISOString(),
      cases: [
        {
          source: { name: "Counterspell" },
          candidates: [],
          expectedIdentifier: "override-preference",
        },
      ],
    });

    await expect(listDefaultMpcCalibrationCases()).resolves.toEqual([
      expect.objectContaining({
        id: "existing-case",
        expectedIdentifier: "existing-preference",
      }),
    ]);
  });

  it("harvests Hathwellcrisping and Chilli_Axe source examples from live candidate pools", async () => {
    const harvested = await harvestSourcePreferenceCandidates(
      ["Windborn Muse", "Thassa, Deep-Dwelling"],
      async (name) =>
        name === "Windborn Muse"
          ? [
              {
                identifier: "a",
                name,
                rawName: name,
                smallThumbnailUrl: "",
                mediumThumbnailUrl: "",
                dpi: 800,
                tags: [],
                sourceName: "Hathwellcrisping",
                source: "Hathwellcrisping",
                extension: "png",
                size: 1,
              },
            ]
          : [
              {
                identifier: "b",
                name,
                rawName: name,
                smallThumbnailUrl: "",
                mediumThumbnailUrl: "",
                dpi: 800,
                tags: [],
                sourceName: "Chilli_Axe",
                source: "Chilli_Axe",
                extension: "png",
                size: 1,
              },
            ]
    );

    expect(harvested).toHaveLength(2);
    expect(harvested.map((entry) => entry.sourceName).sort()).toEqual([
      "Chilli_Axe",
      "Hathwellcrisping",
    ]);
  });

  it("preserves the legacy bootstrap helper as a compatibility wrapper", async () => {
    await ensureBootstrapPreferenceDataset();

    expect(await listDefaultMpcCalibrationCases()).not.toHaveLength(0);
  });
});
