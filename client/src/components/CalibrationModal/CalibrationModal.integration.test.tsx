import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/db";
import { evaluateMpcCalibrationDataset } from "@/helpers/mpcCalibrationRunner";
import { saveMpcCalibrationRun } from "@/helpers/mpcCalibrationStorage";

const liveObservations = vi.hoisted(() => ({ snapshots: [] as unknown[] }));

vi.mock("dexie-react-hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("dexie-react-hooks")>();
  return {
    ...actual,
    useLiveQuery(...args: Parameters<typeof actual.useLiveQuery>) {
      const snapshot = actual.useLiveQuery(...args);
      liveObservations.snapshots.push(snapshot);
      return snapshot;
    },
  };
});

vi.mock("@/helpers/mpcCalibrationStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/helpers/mpcCalibrationStorage")>();
  return { ...actual, saveMpcCalibrationRun: vi.fn(actual.saveMpcCalibrationRun) };
});

vi.mock("@/helpers/mpcCalibrationRunner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/helpers/mpcCalibrationRunner")>();
  return { ...actual, evaluateMpcCalibrationDataset: vi.fn() };
});

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

vi.mock("@/helpers/mpcAutofillApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/helpers/mpcAutofillApi")>();
  return {
    ...actual,
    searchMpcAutofill: vi.fn().mockResolvedValue([]),
  };
});

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
    liveObservations.snapshots = [];
    vi.mocked(saveMpcCalibrationRun).mockClear();
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

  it("publishes a run after its real IndexedDB commit is observed before the writer returns", async () => {
    const actualStorage = await vi.importActual<typeof import("@/helpers/mpcCalibrationStorage")>(
      "@/helpers/mpcCalibrationStorage"
    );
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
    vi.mocked(saveMpcCalibrationRun).mockImplementationOnce(async (...args) => {
      // Hold only the completed writer's return, never an active Dexie transaction.
      const saved = await actualStorage.saveMpcCalibrationRun(...args);
      await writerGate;
      return saved;
    });
    vi.mocked(evaluateMpcCalibrationDataset).mockResolvedValueOnce({
      algorithmId: "current",
      algorithmLabel: "Current algorithm",
      summary: { totalCases: 1, matchedCases: 1, mismatchedCases: 0, accuracy: 1 },
      cases: [],
    });
    await db.mpcCalibrationDatasets.add(manualDataset);
    await db.mpcCalibrationCases.add(manualCase);
    render(<CalibrationModal />);
    await waitForModalReady(1);

    try {
      fireEvent.click(screen.getByTestId("mpc-calibration-run"));
      await waitFor(() => expect(saveMpcCalibrationRun).toHaveBeenCalledTimes(1));
      const writtenRun = vi.mocked(saveMpcCalibrationRun).mock.calls[0]![0];
      await waitFor(() => {
        // Observe the real hook result without substituting the query or its rows.
        expect(liveObservations.snapshots).toContainEqual(expect.objectContaining({
          calibrationRuns: [writtenRun],
          calibrationCases: [manualCase],
          datasets: [expect.objectContaining({ id: manualDataset.id })],
        }));
      });
      await act(async () => {
        expect(await db.mpcCalibrationRuns.get(writtenRun.id)).toEqual(writtenRun);
        expect((await db.mpcCalibrationDatasets.get(manualDataset.id))!.updatedAt)
          .toBeGreaterThan(manualDataset.updatedAt);
      });
      expect(screen.getByTestId("mpc-calibration-scoreboard").textContent).toBe("0/9");
      await act(async () => { releaseWriter(); });
      await waitFor(() => {
        expect(screen.getByTestId("mpc-calibration-scoreboard").textContent).toBe("1/1");
        expect(screen.getByTestId("mpc-calibration-run")).toHaveProperty("disabled", false);
      });
    } finally {
      await act(async () => { releaseWriter(); });
    }
  });

  it("shows same-ID committed case and run replacement from IndexedDB", async () => {
    render(<CalibrationModal />);

    await waitForModalReady(/[1-9]\d*/);
    const initialDataset = await db.mpcCalibrationDatasets.get(
      "bootstrap-preference-dataset"
    );
    expect(initialDataset).toBeTruthy();
    const sameIdDataset = {
      ...initialDataset!,
      description: "C3 same-ID remote replacement",
      updatedAt: initialDataset!.updatedAt + 1,
    };
    const sameIdCases = [
      {
        id: "same-id-remote-case-1",
        datasetId: sameIdDataset.id,
        createdAt: 31,
        updatedAt: 31,
        source: { name: "Same-ID Remote Sol Ring" },
        candidates: [],
        expectedIdentifier: "same-id-remote-choice-1",
      },
      {
        id: "same-id-remote-case-2",
        datasetId: sameIdDataset.id,
        createdAt: 32,
        updatedAt: 32,
        source: { name: "Same-ID Remote Arcane Signet" },
        candidates: [],
        expectedIdentifier: "same-id-remote-choice-2",
      },
    ];
    const sameIdRun = {
      id: "same-id-remote-run-1",
      datasetId: sameIdDataset.id,
      algorithmId: "remote",
      algorithmLabel: "Remote algorithm",
      summary: { totalCases: 2, matchedCases: 2, mismatchedCases: 0, accuracy: 1 },
      results: [],
      createdAt: 33,
    };

    await act(async () => {
      await db.transaction(
        "rw",
        [
          db.mpcCalibrationDatasets,
          db.mpcCalibrationCases,
          db.mpcCalibrationRuns,
        ],
        async () => {
          await Promise.all([
            db.mpcCalibrationDatasets.put(sameIdDataset),
            db.mpcCalibrationCases.clear(),
            db.mpcCalibrationRuns.clear(),
          ]);
          await db.mpcCalibrationCases.bulkAdd(sameIdCases);
          await db.mpcCalibrationRuns.add(sameIdRun);
        }
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("mpc-calibration-dataset").getAttribute("data-dataset-id")).toBe(
        sameIdDataset.id
      );
      expect(screen.getByText("2 cases captured · Target: 9")).toBeTruthy();
      expect(screen.getByText("Frozen Cases (2)")).toBeTruthy();
      expect(screen.getByText("Same-ID Remote Sol Ring")).toBeTruthy();
      expect(screen.getByText("Same-ID Remote Arcane Signet")).toBeTruthy();
    });
    await act(async () => {
      expect(await db.mpcCalibrationRuns.get(sameIdRun.id)).toEqual(sameIdRun);
    });
  });
});
