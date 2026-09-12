import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/db";

const modalState = vi.hoisted(() => ({
  open: true,
  card: null as null,
  closeModal: vi.fn(),
}));

vi.mock("@/store", () => ({
  useCalibrationModalStore: (
    selector: (state: typeof modalState) => unknown
  ) => selector(modalState),
}));

vi.mock("@/store/mpcCalibrationSync", () => ({
  useMpcCalibrationSyncStore: (selector: (state: { status: "unpaired" }) => unknown) =>
    selector({ status: "unpaired" }),
}));

vi.mock("@/helpers/mpcAutofillApi", () => ({
  searchMpcAutofill: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/helpers/mpcPreferenceContextBuilder", () => ({
  getSharedMpcPreferenceContext: vi.fn().mockResolvedValue({
    calibrationCases: [],
    model: null,
    profiles: {},
  }),
}));

vi.mock("@/helpers/mpcPreferenceSync", () => ({
  getActivePreferenceSyncTarget: vi.fn().mockResolvedValue(null),
  getMpcPreferenceSyncStatus: vi.fn(() => ({
    targetLabel: "Unavailable",
    saveStateLabel: "Idle",
  })),
  subscribeToMpcPreferenceSyncStatus: vi.fn(() => () => undefined),
  loadActivePreferenceOverrides: vi.fn().mockResolvedValue({
    target: null,
    fixture: null,
  }),
  serializeCurrentPreferenceFixture: vi.fn(),
  markMpcPreferenceSyncDirty: vi.fn(),
}));

vi.mock("./CalibrationConnectionControls", () => ({
  CalibrationConnectionControls: () => null,
}));

vi.mock("./CalibrationSyncStatus", () => ({
  CalibrationSyncStatus: () => null,
}));

import { CalibrationModal } from "./CalibrationModal";

const manualDataset = {
  id: "manual-dataset",
  name: "MPC Calibration Harness",
  description: "Manual MPC calibration capture set",
  targetCaseCount: 9,
  createdAt: 10,
  updatedAt: 10,
  version: 1,
};

const manualCase = {
  id: "manual-case",
  datasetId: manualDataset.id,
  createdAt: 11,
  updatedAt: 11,
  source: { name: "Manual Sol Ring", set: "C21", collectorNumber: "267" },
  candidates: [],
  expectedIdentifier: "manual-choice",
  notes: "must remain untouched",
};

async function clearHarnessTables() {
  await db.transaction(
    "rw",
    [
      db.mpcCalibrationDatasets,
      db.mpcCalibrationCases,
      db.mpcCalibrationAssets,
      db.mpcCalibrationRuns,
      db.mpcCalibrationCacheBindings,
      db.mpcCalibrationSyncStates,
    ],
    async () => {
      await Promise.all([
        db.mpcCalibrationDatasets.clear(),
        db.mpcCalibrationCases.clear(),
        db.mpcCalibrationAssets.clear(),
        db.mpcCalibrationRuns.clear(),
        db.mpcCalibrationCacheBindings.clear(),
        db.mpcCalibrationSyncStates.clear(),
      ]);
    }
  );
}

async function waitForModalReady(caseCount: number | RegExp) {
  const caseLabel =
    typeof caseCount === "number"
      ? `Frozen Cases (${caseCount})`
      : new RegExp(`^Frozen Cases \\(${caseCount.source}\\)$`);
  await waitFor(() => {
    expect(screen.getByTestId("mpc-calibration-dataset").getAttribute("data-dataset-id")).toBeTruthy();
    expect(screen.getByText(caseLabel)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import" })).toHaveProperty(
      "disabled",
      false
    );
  });
}

describe("CalibrationModal IndexedDB integration", () => {
  beforeEach(async () => {
    await db.open();
    await clearHarnessTables();
    modalState.open = true;
    modalState.card = null;
    modalState.closeModal.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      cleanup();
    });
    await act(async () => {
      await clearHarnessTables();
    });
  });

  it("hydrates the bootstrap dataset before choosing the capture dataset", async () => {
    render(<CalibrationModal />);

    await waitForModalReady(/[1-9]\d*/);
    await act(async () => {
      const datasets = await db.mpcCalibrationDatasets.toArray();
      expect(datasets).toHaveLength(1);
      expect(datasets[0]).toMatchObject({
        id: "bootstrap-preference-dataset",
        name: "MPC Calibration Harness",
      });
      expect(await db.mpcCalibrationCases.count()).toBeGreaterThan(0);
    });
  });

  it("keeps an existing manual calibration dataset and its cases unchanged", async () => {
    await act(async () => {
      await db.mpcCalibrationDatasets.add(manualDataset);
      await db.mpcCalibrationCases.add(manualCase);
    });

    render(<CalibrationModal />);

    await waitForModalReady(1);
    await act(async () => {
      expect(await db.mpcCalibrationDatasets.toArray()).toEqual([manualDataset]);
      expect(await db.mpcCalibrationCases.toArray()).toEqual([manualCase]);
    });
  });

  it("shows the replaced committed dataset and case count after a table-level sync replacement", async () => {
    render(<CalibrationModal />);

    await waitForModalReady(/[1-9]\d*/);

    const syncedDataset = {
      id: "remote-dataset",
      name: "MPC Calibration Harness",
      description: "C3 remote replacement",
      targetCaseCount: 9,
      createdAt: 20,
      updatedAt: 20,
      version: 1,
    };
    const syncedCases = [
      {
        id: "remote-case-1",
        datasetId: syncedDataset.id,
        createdAt: 21,
        updatedAt: 21,
        source: { name: "Remote Sol Ring" },
        candidates: [],
        expectedIdentifier: "remote-choice-1",
      },
      {
        id: "remote-case-2",
        datasetId: syncedDataset.id,
        createdAt: 22,
        updatedAt: 22,
        source: { name: "Remote Arcane Signet" },
        candidates: [],
        expectedIdentifier: "remote-choice-2",
      },
    ];

    await act(async () => {
      await db.transaction(
        "rw",
        [
          db.mpcCalibrationDatasets,
          db.mpcCalibrationCases,
          db.mpcCalibrationAssets,
          db.mpcCalibrationRuns,
        ],
        async () => {
          await Promise.all([
            db.mpcCalibrationDatasets.clear(),
            db.mpcCalibrationCases.clear(),
            db.mpcCalibrationAssets.clear(),
            db.mpcCalibrationRuns.clear(),
          ]);
          await db.mpcCalibrationDatasets.add(syncedDataset);
          await db.mpcCalibrationCases.bulkAdd(syncedCases);
        }
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("mpc-calibration-dataset").getAttribute("data-dataset-id")).toBe(
        syncedDataset.id
      );
      expect(screen.getByText("2 cases captured · Target: 9")).toBeTruthy();
      expect(screen.getByText("Frozen Cases (2)")).toBeTruthy();
    });
  });
});
