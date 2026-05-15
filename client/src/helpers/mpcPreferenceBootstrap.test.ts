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
import recoveredPreferenceFixture from "../../tests/fixtures/mpc-preference-defaults.v1.json";

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

  it("keys merged overrides by set and collector metadata when present", () => {
    const defaults = {
      version: 1,
      exportedAt: new Date(1).toISOString(),
      cases: [
        {
          source: { name: "Sol Ring", set: "C21" },
          candidates: [],
          expectedIdentifier: "default-set",
        },
        {
          source: { name: "Sol Ring", collectorNumber: "267" },
          candidates: [],
          expectedIdentifier: "default-collector",
        },
      ],
    };

    const merged = mergeMpcPreferenceFixtures(defaults, {
      version: 1,
      exportedAt: new Date(2).toISOString(),
      cases: [
        {
          source: { name: " Sol Ring ", set: " c21 " },
          candidates: [],
          expectedIdentifier: "override-set",
        },
        {
          source: { name: "Sol Ring", collectorNumber: " 267 " },
          candidates: [],
          expectedIdentifier: "override-collector",
        },
      ],
    });

    expect(merged.cases).toHaveLength(2);
    expect(merged.cases.map((entry) => entry.expectedIdentifier).sort()).toEqual([
      "override-collector",
      "override-set",
    ]);
  });

  it("falls back to the default export timestamp when merged fixtures omit timestamps", () => {
    const merged = mergeMpcPreferenceFixtures(
      { version: 1, exportedAt: "", cases: [] },
      { version: 1, exportedAt: "", cases: [] }
    );

    expect(merged.exportedAt).toBe("");
  });

  it("normalizes fallback raw names and image URLs in built bootstrap fixtures", () => {
    const fixture = buildBootstrapPreferenceFixture({
      version: 1,
      exportedAt: new Date(7).toISOString(),
      cases: [
        {
          source: { name: "Custom Fixture" },
          candidates: [
            {
              identifier: "missing-fields",
              name: "Missing Fields",
              smallThumbnailUrl: "",
              mediumThumbnailUrl: "",
              dpi: 800,
              tags: [],
              sourceName: "Custom",
              source: "Custom",
              extension: "png",
              size: 1,
            } as never,
            {
              identifier: "preserved-fields",
              name: "Preserved Fields",
              rawName: "Preserved Raw",
              smallThumbnailUrl: "",
              mediumThumbnailUrl: "",
              imageUrl: "fixture://preserved",
              dpi: 800,
              tags: [],
              sourceName: "Custom",
              source: "Custom",
              extension: "png",
              size: 1,
            },
          ],
          expectedIdentifier: "missing-fields",
        },
      ],
    });
    const customCase = fixture.cases.find(
      (calibrationCase) => calibrationCase.source.name === "Custom Fixture"
    );

    expect(customCase?.candidates[0]).toEqual(
      expect.objectContaining({
        rawName: "Missing Fields",
        imageUrl: "/api/cards/images/mpc?id=missing-fields&size=small",
      })
    );
    expect(customCase?.candidates[1]).toEqual(
      expect.objectContaining({
        rawName: "Preserved Raw",
        imageUrl: "fixture://preserved",
      })
    );
  });

  it("filters malformed recovered defaults and normalizes recovered candidate fallbacks", () => {
    const mutableFixture = recoveredPreferenceFixture as {
      cases: Array<{
        name: string;
        expectedIdentifier: string;
        candidates: Array<{
          identifier: string;
          name: string;
          rawName?: string;
          smallThumbnailUrl: string;
          mediumThumbnailUrl: string;
          imageUrl?: string;
          dpi: number;
          tags: string[];
          sourceName: string;
          source: string;
          extension: string;
          size: number;
        }>;
      }>;
    };
    const originalCases = mutableFixture.cases;
    const supportedSource = BOOTSTRAP_PREFERENCE_SOURCES[0]!;

    try {
      mutableFixture.cases = [
        {
          name: "Supported Fixture",
          expectedIdentifier: "supported",
          candidates: [
            {
              identifier: "supported",
              name: "Supported Candidate",
              smallThumbnailUrl: "",
              mediumThumbnailUrl: "",
              dpi: 800,
              tags: [],
              sourceName: supportedSource,
              source: supportedSource,
              extension: "png",
              size: 1,
            },
            {
              identifier: "preserved",
              name: "Preserved Candidate",
              rawName: "Preserved Raw",
              smallThumbnailUrl: "",
              mediumThumbnailUrl: "",
              imageUrl: "fixture://preserved",
              dpi: 800,
              tags: [],
              sourceName: supportedSource,
              source: supportedSource,
              extension: "png",
              size: 1,
            },
          ],
        },
        {
          name: "Unsupported Fixture",
          expectedIdentifier: "unsupported",
          candidates: [
            {
              identifier: "unsupported",
              name: "Unsupported Candidate",
              smallThumbnailUrl: "",
              mediumThumbnailUrl: "",
              dpi: 800,
              tags: [],
              sourceName: "Other",
              source: "Other",
              extension: "png",
              size: 1,
            },
          ],
        },
        {
          name: "Missing Expected Fixture",
          expectedIdentifier: "missing",
          candidates: [
            {
              identifier: "other",
              name: "Other Candidate",
              smallThumbnailUrl: "",
              mediumThumbnailUrl: "",
              dpi: 800,
              tags: [],
              sourceName: supportedSource,
              source: supportedSource,
              extension: "png",
              size: 1,
            },
          ],
        },
      ];

      const defaults = buildBootstrapPreferenceDefaults();

      expect(defaults.cases).toHaveLength(1);
      expect(defaults.cases[0]?.source.name).toBe("Supported Fixture");
      expect(defaults.cases[0]?.candidates[0]).toEqual(
        expect.objectContaining({
          rawName: "Supported Candidate",
          imageUrl: "/api/cards/images/mpc?id=supported&size=small",
        })
      );
      expect(defaults.cases[0]?.candidates[1]).toEqual(
        expect.objectContaining({
          rawName: "Preserved Raw",
          imageUrl: "fixture://preserved",
        })
      );
    } finally {
      mutableFixture.cases = originalCases;
    }
  });

  it("does nothing when calibration tables are unavailable", async () => {
    const originalDatasets = db.mpcCalibrationDatasets;

    try {
      (db as typeof db & { mpcCalibrationDatasets?: undefined }).mpcCalibrationDatasets = undefined;
      await expect(hydrateMpcPreferences()).resolves.toBeUndefined();
    } finally {
      (db as typeof db & { mpcCalibrationDatasets: typeof originalDatasets }).mpcCalibrationDatasets = originalDatasets;
    }
  });

  it("seeds the default calibration dataset when none exists", async () => {
    await hydrateMpcPreferences();
    const cases = await listDefaultMpcCalibrationCases();

    expect(cases.length).toBeGreaterThan(0);
  });

  it("hydrates an explicit user fixture when no defaults exist", async () => {
    await hydrateMpcPreferences({
      version: 1,
      exportedAt: new Date(5).toISOString(),
      cases: [
        {
          source: { name: "Explicit Fixture" },
          candidates: [],
          expectedIdentifier: "explicit-preference",
        },
      ],
    });

    const cases = await listDefaultMpcCalibrationCases();
    expect(
      cases.find((calibrationCase) => calibrationCase.source.name === "Explicit Fixture")
        ?.expectedIdentifier
    ).toBe("explicit-preference");
  });

  it("does not duplicate seed data when default calibration cases already exist", async () => {
    await hydrateMpcPreferences();
    const firstCount = (await listDefaultMpcCalibrationCases()).length;

    await hydrateMpcPreferences();
    const secondCount = (await listDefaultMpcCalibrationCases()).length;

    expect(secondCount).toBe(firstCount);
  });

  it("does not rescue existing Dexie data when the active target already has a fixture", async () => {
    const writeSpy = vi.fn().mockResolvedValue(undefined);
    const loadActiveSpy = vi.spyOn(mpcPreferenceSyncModule, "loadActivePreferenceOverrides").mockResolvedValue({
      target: {
        load: vi.fn().mockResolvedValue(null),
        write: writeSpy,
        describe: () => "Server",
      },
      fixture: {
        version: 1,
        exportedAt: new Date(6).toISOString(),
        cases: [],
      },
    });

    const dataset = await createMpcCalibrationDataset({
      name: MPC_CALIBRATION_DEFAULT_DATASET_NAME,
    });
    await saveMpcCalibrationCase({
      id: "existing-case",
      datasetId: dataset.id,
      source: { name: "Counterspell" },
      candidates: [],
      expectedIdentifier: "existing-preference",
    });

    await hydrateMpcPreferences();

    expect(writeSpy).not.toHaveBeenCalled();
    loadActiveSpy.mockRestore();
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
      ["No Results", "Windborn Muse", "Thassa, Deep-Dwelling"],
      async (name) => {
        if (name === "No Results") {
          return [];
        }

        return name === "Windborn Muse"
          ? [
              {
                identifier: "a",
                name,
                rawName: undefined,
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
            ];
      }
    );

    expect(harvested).toHaveLength(2);
    expect(harvested.map((entry) => entry.sourceName).sort()).toEqual([
      "Chilli_Axe",
      "Hathwellcrisping",
    ]);
    expect(harvested[0]?.candidates[0]?.rawName).toBe("Windborn Muse");
  });

  it("preserves the legacy bootstrap helper as a compatibility wrapper", async () => {
    await ensureBootstrapPreferenceDataset();

    expect(await listDefaultMpcCalibrationCases()).not.toHaveLength(0);
  });
});
