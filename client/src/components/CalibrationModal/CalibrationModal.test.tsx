import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const {
  mockCalibrationState,
  mockListDatasets,
  mockCreateDataset,
  mockCaptureMutationScope,
  mockListCases,
  mockListDefaultCases,
  mockListRuns,
  mockListAssets,
  mockSearchMpcAutofill,
  mockFilterByExactName,
  mockCaptureCase,
  mockSaveCase,
  mockSaveAssets,
  mockSaveCaseWithAssets,
  mockSaveRun,
  mockEvaluateDataset,
  mockCompareAlgorithms,
  mockBuildFixture,
  mockDownloadFixture,
  mockImportFixture,
  mockValidateFixture,
  mockDbImagesGet,
  mockTrainMpcPreferenceModel,
  mockBuildMpcPreferenceScoreMap,
  mockHarvestSourcePreferenceCandidates,
  mockHydrateMpcPreferences,
  mockBuildMpcSourceVisualProfiles,
  mockBuildMpcVisualPreferenceScoreMap,
  mockRankCandidates,
  mockGetSharedMpcPreferenceContext,
  mockGetActivePreferenceSyncTarget,
  mockScopeSource,
  mockUseLiveQuery,
  linkedSync,
} = vi.hoisted(() => ({
  mockCalibrationState: {
    open: true,
    cardUuid: "card-1",
    card: {
      uuid: "card-1",
      name: "Sol Ring",
      order: 1,
      imageId: "image-1",
      isUserUpload: false,
      set: "C21",
      number: "267",
    },
    closeModal: vi.fn(),
  },
  mockListDatasets: vi.fn(),
  mockCreateDataset: vi.fn(),
  mockCaptureMutationScope: vi.fn(),
  mockListCases: vi.fn(),
  mockListDefaultCases: vi.fn(),
  mockListRuns: vi.fn(),
  mockListAssets: vi.fn(),
  mockSearchMpcAutofill: vi.fn(),
  mockFilterByExactName: vi.fn(),
  mockCaptureCase: vi.fn(),
  mockSaveCase: vi.fn(),
  mockSaveAssets: vi.fn(),
  mockSaveCaseWithAssets: vi.fn(),
  mockSaveRun: vi.fn(),
  mockEvaluateDataset: vi.fn(),
  mockCompareAlgorithms: vi.fn(),
  mockBuildFixture: vi.fn(),
  mockDownloadFixture: vi.fn(),
  mockImportFixture: vi.fn(),
  mockValidateFixture: vi.fn(),
  mockDbImagesGet: vi.fn(),
  mockTrainMpcPreferenceModel: vi.fn(() => null),
  mockBuildMpcPreferenceScoreMap: vi.fn(() => ({})),
  mockHarvestSourcePreferenceCandidates: vi.fn().mockResolvedValue([]),
  mockHydrateMpcPreferences: vi.fn().mockResolvedValue(undefined),
  mockBuildMpcSourceVisualProfiles: vi.fn().mockResolvedValue([]),
  mockBuildMpcVisualPreferenceScoreMap: vi.fn().mockResolvedValue({}),
  mockRankCandidates: vi.fn().mockResolvedValue({
    fullProcess: [],
    exactPrinting: [],
    artMatch: [],
    fullCard: [],
    allMatches: [],
  }),
  mockGetSharedMpcPreferenceContext: vi.fn().mockResolvedValue({
    calibrationCases: [],
    model: null,
    profiles: {},
  }),
  mockGetActivePreferenceSyncTarget: vi.fn().mockResolvedValue({
    describe: () => "Mock Sync Target",
  }),
  mockScopeSource: {
    current: { kind: "bound", identity: { ownerId: "owner-a", harnessId: "harness-a", connectionId: "connection-a" }, bindingRevision: 1 },
  },
  mockUseLiveQuery: vi.fn(() => undefined),
  linkedSync: {
    status: "unpaired",
    selection: { kind: "unselected" as const },
    selectLinked: vi.fn(),
    disableCurrentConnection: vi.fn(),
  },
}));

vi.mock("@/store", () => ({
  useCalibrationModalStore: (
    selector: (state: typeof mockCalibrationState) => unknown
  ) => selector(mockCalibrationState),
}));

vi.mock("@/store/mpcCalibrationSync", () => ({
  useMpcCalibrationSyncStore: (selector: (state: typeof linkedSync) => unknown) => selector(linkedSync),
}));

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: mockUseLiveQuery,
}));

vi.mock("@/db", () => ({
  db: {
    images: {
      get: mockDbImagesGet,
    },
  },
}));

vi.mock("@/helpers/mpcAutofillApi", () => ({
  searchMpcAutofill: mockSearchMpcAutofill,
}));

vi.mock("@/helpers/mpcBulkUpgradeMatcher", () => ({
  createSsimCompare: vi.fn(() => vi.fn()),
  FULL_CARD_NORMALIZED_SIZE: 1024,
  filterByExactName: mockFilterByExactName,
  rankCandidates: mockRankCandidates,
  scoreCandidateEnsemble: vi.fn(() => ({
    total: 0,
    metadata: 0,
    visual: 0,
    preference: 0,
    dpi: 0,
  })),
}));

vi.mock("@/helpers/mpcPreferenceModel", () => ({
  buildMpcPreferenceScoreMap: mockBuildMpcPreferenceScoreMap,
  trainMpcPreferenceModel: mockTrainMpcPreferenceModel,
}));

vi.mock("@/helpers/mpcPreferenceBootstrap", () => ({
  BOOTSTRAP_PREFERENCE_SEED_CARD_NAMES: [],
  harvestSourcePreferenceCandidates: mockHarvestSourcePreferenceCandidates,
  hydrateMpcPreferences: mockHydrateMpcPreferences,
}));

vi.mock("@/helpers/mpcVisualPreference", () => ({
  buildMpcSourceVisualProfiles: mockBuildMpcSourceVisualProfiles,
  buildMpcVisualPreferenceScoreMap: mockBuildMpcVisualPreferenceScoreMap,
}));

vi.mock("@/helpers/mpcCalibrationCapture", () => ({
  captureMpcCalibrationCase: mockCaptureCase,
}));

vi.mock("@/helpers/mpcCalibrationStorage", () => ({
  captureMpcCalibrationMutationScope: mockCaptureMutationScope,
  createMpcCalibrationDataset: mockCreateDataset,
  listMpcCalibrationDatasets: mockListDatasets,
  listMpcCalibrationCases: mockListCases,
  listDefaultMpcCalibrationCases: mockListDefaultCases,
  listMpcCalibrationRuns: mockListRuns,
  listMpcCalibrationAssets: mockListAssets,
  saveMpcCalibrationCase: mockSaveCase,
  saveMpcCalibrationAssets: mockSaveAssets,
  saveMpcCalibrationCaseWithAssets: mockSaveCaseWithAssets,
  saveMpcCalibrationRun: mockSaveRun,
  MPC_CALIBRATION_TARGET_CASE_COUNT: 9,
  MPC_CALIBRATION_DATASET_VERSION: 1,
}));

vi.mock("@/helpers/mpcPreferenceContextBuilder", () => ({
  getSharedMpcPreferenceContext: mockGetSharedMpcPreferenceContext,
}));

vi.mock("@/helpers/mpcCalibrationRunner", () => ({
  evaluateMpcCalibrationDataset: mockEvaluateDataset,
  toMpcCalibrationRunResults: vi.fn().mockReturnValue([]),
}));

vi.mock("@/helpers/mpcCalibrationCompare", () => ({
  compareMpcCalibrationAlgorithms: mockCompareAlgorithms,
}));

vi.mock("@/helpers/mpcCalibrationImport", () => ({
  buildMpcCalibrationFixture: mockBuildFixture,
  downloadMpcCalibrationFixture: mockDownloadFixture,
  importMpcCalibrationFixture: mockImportFixture,
  validateMpcCalibrationFixture: mockValidateFixture,
}));

vi.mock("@/helpers/mpcPreferenceSync", () => ({
  getActivePreferenceSyncTarget: mockGetActivePreferenceSyncTarget,
  getMpcPreferenceSyncStatus: vi.fn(() => ({
    targetLabel: "Mock Sync Target",
    saveStateLabel: "Idle",
  })),
  subscribeToMpcPreferenceSyncStatus: vi.fn((listener) => {
    listener({ targetLabel: "Mock Sync Target", saveStateLabel: "Idle" });
    return () => undefined;
  }),
}));

vi.mock("@/components/common/CardImageSvg", () => ({
  CardImageSvg: ({ id }: { id: string }) => <div data-testid={id}>image</div>,
}));

import { CalibrationModal } from "./CalibrationModal";

describe("CalibrationModal", () => {
  const dataset = {
    id: "dataset-1",
    name: "MPC Calibration Harness",
    targetCaseCount: 9,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
  };

  const frozenCase = {
    id: "case-1",
    datasetId: dataset.id,
    createdAt: 1,
    updatedAt: 1,
    source: { name: "Sol Ring", set: "C21", collectorNumber: "267" },
    candidates: [],
    expectedIdentifier: "cand-1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseLiveQuery.mockReturnValue(undefined);
    linkedSync.status = "unpaired";
    mockCaptureMutationScope.mockReset();
    mockScopeSource.current = {
      kind: "bound",
      identity: {
        ownerId: "owner-a",
        harnessId: "harness-a",
        connectionId: "connection-a",
      },
      bindingRevision: 1,
    };
    mockCaptureMutationScope.mockImplementation(() =>
      Promise.resolve(mockScopeSource.current)
    );
    mockListDatasets.mockResolvedValue([dataset]);
    mockListCases.mockResolvedValue([]);
    mockListDefaultCases.mockResolvedValue([]);
    mockListRuns.mockResolvedValue([]);
    mockListAssets.mockResolvedValue([]);
    mockDbImagesGet.mockResolvedValue({
      id: "image-1",
      refCount: 1,
      sourceUrl: "https://cards.scryfall.io/normal/test.jpg",
    });
    mockSearchMpcAutofill.mockResolvedValue([
      {
        identifier: "cand-1",
        name: "Sol Ring",
        rawName: "Sol Ring [C21] {267}",
        smallThumbnailUrl: "thumb",
        mediumThumbnailUrl: "thumb",
        dpi: 600,
        tags: [],
        sourceName: "MPC",
        source: "mpc",
        extension: "png",
        size: 100,
      },
    ]);
    mockFilterByExactName.mockReturnValue([
      {
        identifier: "cand-1",
        name: "Sol Ring",
        rawName: "Sol Ring [C21] {267}",
        smallThumbnailUrl: "thumb",
        mediumThumbnailUrl: "thumb",
        dpi: 600,
        tags: [],
        sourceName: "MPC",
        source: "mpc",
        extension: "png",
        size: 100,
      },
    ]);
  });

  it("captures the dataset scope before listing datasets and uses it for creation", async () => {
    let resolveDatasets!: (datasets: typeof dataset[]) => void;
    const scopeA = mockScopeSource.current;
    const scopeB = {
      kind: "bound",
      identity: {
        ownerId: "owner-b",
        harnessId: "harness-b",
        connectionId: "connection-b",
      },
      bindingRevision: 2,
    };
    mockListDatasets.mockImplementationOnce(
      () =>
        new Promise<typeof dataset[]>((resolve) => {
          resolveDatasets = resolve;
        })
    );
    mockCreateDataset.mockResolvedValue(dataset);

    render(<CalibrationModal />);

    await waitFor(() => {
      expect(mockCaptureMutationScope).toHaveBeenCalledTimes(1);
    });
    mockScopeSource.current = scopeB;
    resolveDatasets([]);

    await waitFor(() => {
      expect(mockCreateDataset).toHaveBeenCalledWith(
        expect.objectContaining({ name: "MPC Calibration Harness" }),
        scopeA
      );
    });
    expect(mockCreateDataset).not.toHaveBeenCalledWith(
      expect.anything(),
      scopeB
    );
  });

  it("retains the opening dataset scope for deferred preference bootstrap", async () => {
    let resolveDatasets!: (datasets: typeof dataset[]) => void;
    const scopeA = mockScopeSource.current;
    const scopeB = {
      kind: "bound",
      identity: {
        ownerId: "bootstrap-owner-b",
        harnessId: "bootstrap-harness-b",
        connectionId: "bootstrap-connection-b",
      },
      bindingRevision: 7,
    };
    mockListDatasets.mockImplementationOnce(
      () =>
        new Promise<typeof dataset[]>((resolve) => {
          resolveDatasets = resolve;
        })
    );

    render(<CalibrationModal />);

    await waitFor(() => {
      expect(mockCaptureMutationScope).toHaveBeenCalledTimes(1);
    });
    mockScopeSource.current = scopeB;
    resolveDatasets([dataset]);

    await waitFor(() => {
      expect(mockHydrateMpcPreferences).toHaveBeenCalledWith(undefined, scopeA);
    });
    expect(mockHydrateMpcPreferences).not.toHaveBeenCalledWith(undefined, scopeB);
    expect(mockCaptureMutationScope).toHaveBeenCalledTimes(1);
  });

  it("does not let a late opening dataset load overwrite a live replacement", async () => {
    let resolveInitialCases!: (cases: typeof frozenCase[]) => void;
    const replacementDataset = {
      ...dataset,
      id: "remote-dataset",
      updatedAt: 2,
    };
    const replacementCase = {
      ...frozenCase,
      id: "remote-case",
      datasetId: replacementDataset.id,
      source: { name: "Remote Sol Ring", set: "C21", collectorNumber: "267" },
    };
    mockListCases.mockImplementationOnce(
      () =>
        new Promise<typeof frozenCase[]>((resolve) => {
          resolveInitialCases = resolve;
        })
    );

    const view = render(<CalibrationModal />);

    await waitFor(() => {
      expect(mockListCases).toHaveBeenCalledWith(dataset.id);
    });
    mockUseLiveQuery.mockReturnValue({
      datasets: [replacementDataset],
      calibrationCases: [replacementCase],
      calibrationRuns: [],
    } as never);
    view.rerender(<CalibrationModal />);

    await waitFor(() => {
      expect(screen.getByTestId("mpc-calibration-dataset").getAttribute("data-dataset-id")).toBe(
        replacementDataset.id
      );
      expect(screen.getByText("Remote Sol Ring")).toBeTruthy();
    });

    resolveInitialCases([frozenCase]);

    await waitFor(() => {
      expect(screen.getByText("Remote Sol Ring")).toBeTruthy();
      expect(screen.queryByText("Sol Ring")).toBeNull();
    });
  });

  it("does not let a deferred sync-target read resume an opening dataset after a live replacement", async () => {
    let resolveTarget!: (target: { describe: () => string } | null) => void;
    const replacementDataset = {
      ...dataset,
      id: "remote-dataset-after-target",
      updatedAt: 2,
    };
    const replacementCase = {
      ...frozenCase,
      id: "remote-case-after-target",
      datasetId: replacementDataset.id,
      source: { name: "Target Remote Sol Ring", set: "C21", collectorNumber: "267" },
    };
    mockGetActivePreferenceSyncTarget.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTarget = resolve;
        })
    );

    const view = render(<CalibrationModal />);
    await waitFor(() => {
      expect(mockGetActivePreferenceSyncTarget).toHaveBeenCalledTimes(1);
    });

    mockUseLiveQuery.mockReturnValue({
      datasets: [replacementDataset],
      calibrationCases: [replacementCase],
      calibrationRuns: [],
    } as never);
    view.rerender(<CalibrationModal />);
    await waitFor(() => {
      expect(screen.getByTestId("mpc-calibration-dataset").getAttribute("data-dataset-id")).toBe(
        replacementDataset.id
      );
    });

    await act(async () => {
      resolveTarget({ describe: () => "Deferred target" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("mpc-calibration-dataset").getAttribute("data-dataset-id")).toBe(
        replacementDataset.id
      );
      expect(screen.getByText("Target Remote Sol Ring")).toBeTruthy();
    });
    expect(mockListCases).not.toHaveBeenCalledWith(dataset.id);
  });

  it("does not publish a deferred preference model after the live dataset changes", async () => {
    let resolveContext!: (value: {
      calibrationCases: [];
      model: { sourceStats: Record<string, { selections: number; appearances: number }> };
      profiles: Record<string, never>;
    }) => void;
    const replacementDataset = {
      ...dataset,
      id: "remote-dataset-after-model",
      updatedAt: 2,
    };
    const replacementCase = {
      ...frozenCase,
      id: "remote-case-after-model",
      datasetId: replacementDataset.id,
      source: { name: "Model Remote Sol Ring", set: "C21", collectorNumber: "267" },
    };
    mockGetSharedMpcPreferenceContext.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveContext = resolve;
        })
    );

    const view = render(<CalibrationModal />);
    await waitFor(() => {
      expect(mockGetSharedMpcPreferenceContext).toHaveBeenCalledTimes(1);
    });

    mockUseLiveQuery.mockReturnValue({
      datasets: [replacementDataset],
      calibrationCases: [replacementCase],
      calibrationRuns: [],
    } as never);
    view.rerender(<CalibrationModal />);
    await waitFor(() => {
      expect(screen.getByText("Model Remote Sol Ring")).toBeTruthy();
    });

    await act(async () => {
      resolveContext({
        calibrationCases: [],
        model: { sourceStats: { MPC: { selections: 1, appearances: 1 } } },
        profiles: {},
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Model Remote Sol Ring")).toBeTruthy();
    });
    expect(mockDbImagesGet).not.toHaveBeenCalled();
    expect(mockRankCandidates).not.toHaveBeenCalled();
  });

  it("does not let a deferred cases-and-runs refresh overwrite a newer same-ID snapshot", async () => {
    let resolveCases!: (cases: typeof frozenCase[]) => void;
    let resolveRuns!: (runs: Array<{ id: string; datasetId: string; createdAt: number }>) => void;
    const replacementDataset = {
      ...dataset,
      updatedAt: 2,
    };
    const replacementCase = {
      ...frozenCase,
      id: "same-id-remote-case-after-refresh",
      source: { name: "Same-ID Remote Sol Ring", set: "C21", collectorNumber: "267" },
    };
    const replacementRun = {
      id: "same-id-remote-run-after-refresh",
      datasetId: dataset.id,
      createdAt: 2,
    };
    const staleRun = {
      id: "stale-run-before-refresh",
      datasetId: dataset.id,
      createdAt: 1,
    };
    let resolveDatasets!: (datasets: typeof dataset[]) => void;
    mockListDatasets.mockImplementationOnce(
      () =>
        new Promise<typeof dataset[]>((resolve) => {
          resolveDatasets = resolve;
        })
    );
    mockUseLiveQuery.mockReturnValue({
      datasets: [dataset],
      calibrationCases: [frozenCase],
      calibrationRuns: [staleRun],
    } as never);
    mockListCases.mockImplementationOnce(
      () =>
        new Promise<typeof frozenCase[]>((resolve) => {
          resolveCases = resolve;
        })
    );
    mockListRuns.mockImplementationOnce(
      () =>
        new Promise<Array<typeof staleRun>>((resolve) => {
          resolveRuns = resolve;
        })
    );

    const view = render(<CalibrationModal />);
    await waitFor(() => {
      expect(screen.getByText("Frozen Cases (1)")).toBeTruthy();
    });
    await act(async () => {
      resolveDatasets([dataset]);
    });
    await waitFor(() => {
      expect(mockListCases).toHaveBeenCalledWith(dataset.id);
      expect(mockListRuns).toHaveBeenCalledWith(dataset.id);
    });

    mockUseLiveQuery.mockReturnValue({
      datasets: [replacementDataset],
      calibrationCases: [replacementCase],
      calibrationRuns: [replacementRun],
    } as never);
    view.rerender(<CalibrationModal />);
    await waitFor(() => {
      expect(screen.getByText("Same-ID Remote Sol Ring")).toBeTruthy();
    });

    await act(async () => {
      resolveCases([frozenCase]);
      resolveRuns([staleRun]);
    });

    await waitFor(() => {
      expect(screen.getByText("Same-ID Remote Sol Ring")).toBeTruthy();
      expect(screen.queryByText("Sol Ring")).toBeNull();
    });
  });

  it("does not publish a closed opening load after the modal reopens", async () => {
    let resolveClosedLoad!: (cases: typeof frozenCase[]) => void;
    let resolveReopenedLoad!: (cases: typeof frozenCase[]) => void;
    mockListCases
      .mockImplementationOnce(
        () =>
          new Promise<typeof frozenCase[]>((resolve) => {
            resolveClosedLoad = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<typeof frozenCase[]>((resolve) => {
            resolveReopenedLoad = resolve;
          })
      );

    const view = render(<CalibrationModal />);
    await waitFor(() => {
      expect(mockListCases).toHaveBeenCalledTimes(1);
    });

    mockCalibrationState.open = false;
    view.rerender(<CalibrationModal />);
    mockCalibrationState.open = true;
    view.rerender(<CalibrationModal />);
    await waitFor(() => {
      expect(mockListCases).toHaveBeenCalledTimes(2);
    });

    resolveClosedLoad([frozenCase]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("Frozen Cases (0)")).toBeTruthy();

    resolveReopenedLoad([]);
    await waitFor(() => {
      expect(screen.getByText("Frozen Cases (0)")).toBeTruthy();
    });
  });

  it("captures the import scope before file text and retains it across a later binding change", async () => {
    let resolveScope!: (scope: typeof mockScopeSource.current) => void;
    let resolveText!: (text: string) => void;
    const scopeA = {
      kind: "bound",
      identity: {
        ownerId: "import-owner-a",
        harnessId: "import-harness-a",
        connectionId: "import-connection-a",
      },
      bindingRevision: 8,
    };
    const scopeB = {
      kind: "bound",
      identity: {
        ownerId: "import-owner-b",
        harnessId: "import-harness-b",
        connectionId: "import-connection-b",
      },
      bindingRevision: 9,
    };
    const fixture = { dataset, cases: [], assets: [], runs: [] };
    const file = new File(["{}"], "calibration.json", {
      type: "application/json",
    });
    const text = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveText = resolve;
        })
    );
    Object.defineProperty(file, "text", { value: text });
    mockValidateFixture.mockReturnValue(fixture);
    mockImportFixture.mockResolvedValue(dataset.id);

    render(<CalibrationModal />);
    await waitFor(() => {
      expect(mockHydrateMpcPreferences).toHaveBeenCalled();
    });
    mockCaptureMutationScope.mockClear();
    mockCaptureMutationScope.mockImplementationOnce(
      () =>
        new Promise<typeof mockScopeSource.current>((resolve) => {
          resolveScope = resolve;
        })
    );

    fireEvent.change(screen.getByTestId("mpc-calibration-import-input"), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(mockCaptureMutationScope).toHaveBeenCalledTimes(1);
    });
    expect(text).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Import" })
    ).toHaveProperty("disabled", true);

    resolveScope(scopeA);
    await waitFor(() => {
      expect(text).toHaveBeenCalledTimes(1);
    });
    mockScopeSource.current = scopeB;
    resolveText("{}");

    await waitFor(() => {
      expect(mockImportFixture).toHaveBeenCalledWith(fixture, scopeA);
    });
    expect(mockImportFixture).not.toHaveBeenCalledWith(fixture, scopeB);
    expect(screen.getByTestId("mpc-calibration-status").textContent).toContain(
      "Cases captured: 0/9"
    );
  });

  it("keeps import controls and dataset state local when the scoped writer rejects", async () => {
    const fixture = { dataset, cases: [], assets: [], runs: [] };
    const error = new Error("import persistence rejected");
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error");
    mockValidateFixture.mockReturnValue(fixture);
    mockImportFixture.mockRejectedValueOnce(error);

    render(<CalibrationModal />);
    await waitFor(() => {
      expect(mockHydrateMpcPreferences).toHaveBeenCalled();
    });
    const caseReadsBeforeImport = mockListCases.mock.calls.length;
    const runReadsBeforeImport = mockListRuns.mock.calls.length;
    const file = new File(["{}"], "calibration.json", {
      type: "application/json",
    });
    Object.defineProperty(file, "text", {
      value: () => Promise.resolve("{}"),
    });

    fireEvent.change(screen.getByTestId("mpc-calibration-import-input"), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith("Failed to import fixture");
      expect(errorSpy).toHaveBeenCalledWith(error);
      expect(screen.getByRole("button", { name: "Import" })).toHaveProperty(
        "disabled",
        false
      );
    });
    expect(mockListCases).toHaveBeenCalledTimes(caseReadsBeforeImport);
    expect(mockListRuns).toHaveBeenCalledTimes(runReadsBeforeImport);
    expect(screen.queryByTestId("mpc-calibration-status")).toBeNull();
    errorSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it("reports bootstrap writer rejection without continuing into preference evaluation", async () => {
    const error = new Error("bootstrap persistence rejected");
    const errorSpy = vi.spyOn(console, "error");
    mockHydrateMpcPreferences.mockRejectedValueOnce(error);

    render(<CalibrationModal />);

    await waitFor(() => {
      expect(mockHydrateMpcPreferences).toHaveBeenCalledWith(
        undefined,
        mockScopeSource.current
      );
      expect(errorSpy).toHaveBeenCalledWith(
        "CalibrationModal: Bootstrap error",
        error
      );
      expect(screen.getByRole("button", { name: "Import" })).toHaveProperty(
        "disabled",
        false
      );
    });
    expect(mockGetSharedMpcPreferenceContext).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("requests the complete all-language MPC candidate pool", async () => {
    render(<CalibrationModal />);

    await waitFor(() => {
      expect(mockSearchMpcAutofill).toHaveBeenCalledWith(
        "Sol Ring",
        "CARD",
        false,
        { includeAllLanguages: true }
      );
    });
  });

  it("captures one selected choice with its partial successful assets under the earlier scope", async () => {
    let resolveLatestCases!: (cases: never[]) => void;
    const scopeA = {
      kind: "bound",
      identity: {
        ownerId: "capture-owner-a",
        harnessId: "capture-harness-a",
        connectionId: "capture-connection-a",
      },
      bindingRevision: 3,
    };
    const scopeB = {
      kind: "bound",
      identity: {
        ownerId: "capture-owner-b",
        harnessId: "capture-harness-b",
        connectionId: "capture-connection-b",
      },
      bindingRevision: 4,
    };
    mockCaptureCase.mockResolvedValue({
      caseRecord: {
        id: "case-1",
        datasetId: dataset.id,
        createdAt: 1,
        updatedAt: 1,
        source: { name: "Sol Ring" },
        candidates: [],
        expectedIdentifier: "cand-1",
      },
      assets: [
        {
          id: "asset-1",
          datasetId: dataset.id,
          caseId: "case-1",
          role: "source",
          url: "https://example.invalid/source.png",
          createdAt: 1,
        },
      ],
      assetErrors: [{ asset: "candidate", error: "not found" }],
    });

    mockSearchMpcAutofill.mockResolvedValue([
      {
        identifier: "cand-1",
        rawName: "Sol Ring [C21] {267}",
        sourceName: "MPC",
        dpi: 600,
        smallThumbnailUrl: "image-small",
        mediumThumbnailUrl: "image-med",
      },
    ]);

    render(<CalibrationModal />);

    await waitFor(() => {
      expect(
        screen.getByTestId("mpc-calibration-candidate-cand-1")
      ).toBeTruthy();
      expect(
        screen.getByTestId("mpc-preference-sync-status").textContent
      ).toContain("Sync Target: Mock Sync Target");
      expect(
        screen.getByTestId("mpc-preference-sync-status").textContent
      ).toContain("Idle");
    });

    const button = await screen.findByRole("button", {
      name: /use as expected choice/i,
    });
    mockCaptureMutationScope.mockClear();
    mockScopeSource.current = scopeA;
    mockListCases.mockImplementationOnce(
      () =>
        new Promise<never[]>((resolve) => {
          resolveLatestCases = resolve;
        })
    );
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockCaptureMutationScope).toHaveBeenCalledTimes(1);
    });
    mockScopeSource.current = scopeB;
    resolveLatestCases([]);

    await waitFor(() => {
      expect(mockCaptureCase).toHaveBeenCalled();
      expect(mockCaptureCase).toHaveBeenCalledWith({
        datasetId: dataset.id,
        card: mockCalibrationState.card,
        imageRecord: expect.objectContaining({ id: "image-1" }),
        candidates: expect.any(Array),
        expectedIdentifier: "cand-1",
      });
      expect(mockSaveCaseWithAssets).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "case-1",
          expectedIdentifier: "cand-1",
        }),
        [expect.objectContaining({ id: "asset-1", caseId: "case-1" })],
        scopeA
      );
      expect(mockSaveCaseWithAssets).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        scopeB
      );
      expect(mockSaveCase).not.toHaveBeenCalled();
      expect(mockSaveAssets).not.toHaveBeenCalled();
      expect(
        screen.getByTestId("mpc-calibration-status").textContent
      ).toContain("1 asset warning");
    });
  });

  it("disables an expected candidate that is already captured for the active card", async () => {
    mockListCases.mockResolvedValue([frozenCase]);

    render(<CalibrationModal />);

    const button = await screen.findByRole("button", {
      name: /expected choice captured/i,
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(button);

    expect(mockCaptureCase).not.toHaveBeenCalled();
    expect(mockSaveCase).not.toHaveBeenCalled();
    expect(mockSaveAssets).not.toHaveBeenCalled();
  });

  it("rechecks latest cases before saving a duplicate expected choice", async () => {
    mockListCases
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([frozenCase]);

    render(<CalibrationModal />);

    const button = await screen.findByRole("button", {
      name: /use as expected choice/i,
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(
        screen.getByTestId("mpc-calibration-status").textContent
      ).toContain("already captured");
    });
    expect(mockCaptureCase).not.toHaveBeenCalled();
    expect(mockSaveCase).not.toHaveBeenCalled();
    expect(mockSaveAssets).not.toHaveBeenCalled();
  });

  it("reports capture success when its own same-ID live snapshot arrives before save resolves", async () => {
    const existingCase = {
      ...frozenCase,
      id: "existing-case-before-capture",
      source: { name: "Existing Case", set: "C21", collectorNumber: "267" },
      expectedIdentifier: "other-choice",
    };
    const capturedCase = {
      ...frozenCase,
      id: "own-case-after-capture",
      source: { name: "Sol Ring", set: "C21", collectorNumber: "267" },
    };
    mockUseLiveQuery.mockReturnValue({
      datasets: [dataset],
      calibrationCases: [existingCase],
      calibrationRuns: [],
    } as never);
    mockListCases.mockResolvedValue([existingCase]);
    mockEvaluateDataset.mockResolvedValue({
      algorithmId: "current",
      algorithmLabel: "Current algorithm",
      summary: { totalCases: 1, matchedCases: 1, mismatchedCases: 0, accuracy: 1 },
      cases: [],
    });
    mockSaveRun.mockResolvedValue(undefined);
    mockCaptureCase.mockResolvedValue({
      caseRecord: capturedCase,
      assets: [],
      assetErrors: [],
    });
    let resolveSave!: () => void;
    mockSaveCaseWithAssets.mockImplementation(
      () => new Promise<void>((resolve) => { resolveSave = resolve; })
    );

    const view = render(<CalibrationModal />);
    const captureButton = await screen.findByRole("button", { name: /use as expected choice/i });
    fireEvent.click(screen.getByTestId("mpc-calibration-run"));
    await waitFor(() => {
      expect(screen.getByTestId("mpc-calibration-scoreboard").textContent).toBe("1/1");
      expect(captureButton).toHaveProperty("disabled", false);
    });
    fireEvent.click(captureButton);
    await waitFor(() => expect(mockSaveCaseWithAssets).toHaveBeenCalledTimes(1));

    await act(async () => {
      mockUseLiveQuery.mockReturnValue({
        datasets: [{ ...dataset, updatedAt: dataset.updatedAt + 1 }],
        calibrationCases: [existingCase, capturedCase],
        calibrationRuns: [],
      } as never);
      mockListCases.mockResolvedValue([existingCase, capturedCase]);
      view.rerender(<CalibrationModal />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      resolveSave();
    });

    await waitFor(() => {
      expect(screen.getByTestId("mpc-calibration-status").textContent).toContain(
        "Captured expected choice: Sol Ring [C21] {267}."
      );
      expect(screen.getByTestId("mpc-calibration-scoreboard").textContent).toBe("0/9");
      expect(screen.getByText("Frozen Cases (2)")).toBeTruthy();
    });
  });

  it("keeps zero-asset capture failure local when the grouped write is rejected", async () => {
    mockCaptureCase.mockResolvedValue({
      caseRecord: {
        id: "case-1",
        datasetId: dataset.id,
        createdAt: 1,
        updatedAt: 1,
        source: { name: "Sol Ring" },
        candidates: [],
        expectedIdentifier: "cand-1",
      },
      assets: [],
      assetErrors: [],
    });
    mockSaveCaseWithAssets.mockRejectedValue(
      new Error("case persistence rejected")
    );

    render(<CalibrationModal />);
    fireEvent.click(
      await screen.findByRole("button", { name: /use as expected choice/i })
    );

    await waitFor(() => {
      expect(mockSaveCaseWithAssets).toHaveBeenCalledWith(
        expect.objectContaining({ id: "case-1" }),
        [],
        expect.anything()
      );
      expect(screen.getByTestId("mpc-calibration-status").textContent).toContain(
        "case persistence rejected"
      );
    });
    expect(screen.getByTestId("mpc-calibration-status").textContent).not.toContain(
      "Captured expected choice"
    );
    expect(mockSaveCase).not.toHaveBeenCalled();
    expect(mockSaveAssets).not.toHaveBeenCalled();
    expect(mockListRuns).toHaveBeenCalledTimes(1);
  });

  it("persists a whole-dataset run with the scope captured before evaluation input reads", async () => {
    let resolveEvaluation!: (result: {
      algorithmId: string;
      algorithmLabel: string;
      summary: {
        totalCases: number;
        matchedCases: number;
        mismatchedCases: number;
        accuracy: number;
      };
      cases: never[];
    }) => void;
    const scopeA = {
      kind: "bound",
      identity: {
        ownerId: "run-owner-a",
        harnessId: "run-harness-a",
        connectionId: "run-connection-a",
      },
      bindingRevision: 5,
    };
    const scopeB = {
      kind: "bound",
      identity: {
        ownerId: "run-owner-b",
        harnessId: "run-harness-b",
        connectionId: "run-connection-b",
      },
      bindingRevision: 6,
    };
    mockListCases.mockResolvedValue([frozenCase]);
    mockEvaluateDataset.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEvaluation = resolve;
        })
    );

    render(<CalibrationModal />);

    const runButton = await screen.findByTestId("mpc-calibration-run");
    mockCaptureMutationScope.mockClear();
    mockScopeSource.current = scopeA;
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(mockCaptureMutationScope).toHaveBeenCalledTimes(1);
    });
    mockScopeSource.current = scopeB;
    resolveEvaluation({
      algorithmId: "current",
      algorithmLabel: "Current algorithm",
      summary: {
        totalCases: 1,
        matchedCases: 1,
        mismatchedCases: 0,
        accuracy: 1,
      },
      cases: [],
    });

    await waitFor(() => {
      expect(mockEvaluateDataset).toHaveBeenCalledWith(
        dataset,
        [frozenCase],
        { id: "current", label: "Current algorithm" },
        []
      );
      expect(mockSaveRun).toHaveBeenCalledWith(
        expect.objectContaining({
          datasetId: dataset.id,
          algorithmId: "current",
          algorithmLabel: "Current algorithm",
          summary: expect.objectContaining({ matchedCases: 1 }),
        }),
        scopeA
      );
      expect(mockSaveRun).not.toHaveBeenCalledWith(expect.anything(), scopeB);
      expect(
        screen.getByTestId("mpc-calibration-scoreboard").textContent
      ).toContain("1/1");
    });
  });

  it("publishes a successful run when its own same-ID live snapshot arrives before save resolves", async () => {
    mockUseLiveQuery.mockReturnValue({
      datasets: [dataset],
      calibrationCases: [frozenCase],
      calibrationRuns: [],
    } as never);
    mockListCases.mockResolvedValue([frozenCase]);
    mockEvaluateDataset.mockResolvedValue({
      algorithmId: "current",
      algorithmLabel: "Current algorithm",
      summary: {
        totalCases: 1,
        matchedCases: 1,
        mismatchedCases: 0,
        accuracy: 1,
      },
      cases: [],
    });
    let resolveSave!: () => void;
    mockSaveRun.mockImplementation(
      () => new Promise<void>((resolve) => { resolveSave = resolve; })
    );

    const view = render(<CalibrationModal />);
    await waitFor(() => {
      expect(screen.getByText("Frozen Cases (1)")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("mpc-calibration-run"));
    await waitFor(() => expect(mockSaveRun).toHaveBeenCalledTimes(1));
    const savedRun = mockSaveRun.mock.calls[0]![0];

    await act(async () => {
      mockUseLiveQuery.mockReturnValue({
        datasets: [{ ...dataset, updatedAt: dataset.updatedAt + 1 }],
        calibrationCases: [frozenCase],
        calibrationRuns: [savedRun],
      } as never);
      view.rerender(<CalibrationModal />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      resolveSave();
    });

    await waitFor(() => {
      expect(screen.getByTestId("mpc-calibration-scoreboard").textContent).toContain("1/1");
    });
  });

  it.each(["replacement", "coalesced-own-run"])("does not publish a run result after an external same-ID %s changes cases while its save is pending", async (change) => {
    const externalCase = {
      ...frozenCase,
      id: "external-case-during-run",
      source: { name: "External Sol Ring", set: "C21", collectorNumber: "267" },
    };
    mockUseLiveQuery.mockReturnValue({
      datasets: [dataset],
      calibrationCases: [frozenCase],
      calibrationRuns: [],
    } as never);
    mockListCases.mockResolvedValue([frozenCase]);
    mockEvaluateDataset.mockResolvedValue({
      algorithmId: "current",
      algorithmLabel: "Current algorithm",
      summary: { totalCases: 1, matchedCases: 1, mismatchedCases: 0, accuracy: 1 },
      cases: [],
    });
    let resolveSave!: () => void;
    mockSaveRun.mockImplementation(
      () => new Promise<void>((resolve) => { resolveSave = resolve; })
    );

    const view = render(<CalibrationModal />);
    await waitFor(() => expect(screen.getByText("Frozen Cases (1)")).toBeTruthy());
    fireEvent.click(screen.getByTestId("mpc-calibration-run"));
    await waitFor(() => expect(mockSaveRun).toHaveBeenCalledTimes(1));
    const savedRun = mockSaveRun.mock.calls[0]![0];

    await act(async () => {
      mockUseLiveQuery.mockReturnValue({
        datasets: [{ ...dataset, updatedAt: dataset.updatedAt + 1 }],
        calibrationCases: [externalCase],
        calibrationRuns: change === "coalesced-own-run"
          ? [savedRun]
          : [{ ...savedRun, id: "external-run-during-run" }],
      } as never);
      view.rerender(<CalibrationModal />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      resolveSave();
    });

    await waitFor(() => {
      expect(screen.getByText("External Sol Ring")).toBeTruthy();
      expect(screen.queryByText("Sol Ring")).toBeNull();
      expect(screen.getByTestId("mpc-calibration-scoreboard").textContent).toContain("0/9");
    });
  });

  it("keeps the evaluation scoreboard and dataset refresh unchanged when run persistence is rejected", async () => {
    mockListCases.mockResolvedValue([frozenCase]);
    mockEvaluateDataset.mockResolvedValue({
      algorithmId: "current",
      algorithmLabel: "Current algorithm",
      summary: {
        totalCases: 1,
        matchedCases: 1,
        mismatchedCases: 0,
        accuracy: 1,
      },
      cases: [],
    });
    mockSaveRun.mockRejectedValue(new Error("run persistence rejected"));

    render(<CalibrationModal />);

    fireEvent.click(await screen.findByTestId("mpc-calibration-run"));

    await waitFor(() => {
      expect(screen.getByTestId("mpc-calibration-status").textContent).toContain(
        "run persistence rejected"
      );
    });
    expect(screen.getByTestId("mpc-calibration-scoreboard").textContent).toContain(
      "0/9"
    );
    expect(mockListRuns).toHaveBeenCalledTimes(1);
  });

  it("shows baseline and current predictions after comparison", async () => {
    mockListCases.mockResolvedValue([frozenCase]);
    mockCompareAlgorithms.mockResolvedValue({
      baseline: {
        algorithmId: "baseline",
        summary: {
          totalCases: 1,
          matchedCases: 0,
          mismatchedCases: 1,
          accuracy: 0,
        },
        cases: [],
      },
      candidate: {
        algorithmId: "current",
        summary: {
          totalCases: 1,
          matchedCases: 1,
          mismatchedCases: 0,
          accuracy: 1,
        },
        cases: [],
      },
      diffs: [
        {
          caseId: "case-1",
          baselineIdentifier: "baseline-pick",
          candidateIdentifier: "current-pick",
          changed: true,
          expectedIdentifier: "cand-1",
        },
      ],
    });

    render(<CalibrationModal />);

    fireEvent.click(
      await screen.findByRole("button", { name: /compare vs dpi baseline/i })
    );

    await waitFor(() => {
      expect(mockCompareAlgorithms).toHaveBeenCalledWith(
        dataset,
        [frozenCase],
        {
          id: "dpi-baseline",
          label: "DPI baseline",
          usePreferenceProfile: false,
        },
        { id: "current", label: "Current algorithm" },
        []
      );
      expect(screen.getByText(/Baseline: baseline-pick/i)).toBeTruthy();
      expect(screen.getByText(/Current: current-pick/i)).toBeTruthy();
    });
  });

  it("renders a top-right close button that closes the modal", async () => {
    render(<CalibrationModal />);
    const closeButton = await screen.findByRole("button", { name: /close/i });
    expect(
      screen.getByTestId("mpc-calibration-modal-header").className
    ).toContain("relative");
    expect(closeButton.className).toContain("absolute");
    expect(closeButton.className).toContain("right-4");
    expect(closeButton.className).toContain("top-4");
    fireEvent.click(closeButton);
    expect(mockCalibrationState.closeModal).toHaveBeenCalled();
  });

  it("uses the upgrade-equivalent complete descriptor with the shared preference context", async () => {
    mockGetSharedMpcPreferenceContext.mockResolvedValue({
      calibrationCases: [],
      model: { sourceStats: {} },
      profiles: {},
    });

    render(<CalibrationModal />);

    await waitFor(() => {
      expect(mockGetSharedMpcPreferenceContext).toHaveBeenCalledWith(
        {
          dataset: {
            calibrationCases: [],
            version: 1,
            content: {
              datasetName: "MPC Calibration Harness",
              selection: "default-calibration-datasets",
            },
          },
          source: {
            version: "bootstrap-preference-seeds-v1",
            content: {
              seedCardNames: [],
              targetSources: ["Hathwellcrisping", "Chilli_Axe"],
            },
            loadExamples: expect.any(Function),
          },
          provider: {
            version: "mpc-autofill-card-exact-v1",
            content: { cardType: "CARD", exactName: true },
          },
          algorithm: {
            version: "mpc-preference-model-visual-profile-v1",
            content: {
              metadataScore: "buildMpcPreferenceScoreMap",
              visualProfile: "buildMpcSourceVisualProfiles",
              visualScore: "buildMpcVisualPreferenceScoreMap",
            },
            trainingOptions: {
              emphasizedSources: ["Hathwellcrisping", "Chilli_Axe"],
            },
          },
        },
        expect.any(AbortSignal)
      );
    });
  });

  it("renders each app-owned linked-sync status and closing remains a UI-only request", async () => {
    const labels = {
      unpaired: "Sync is not paired.",
      authenticating: "Authenticating sync connection.",
      "paired-not-hydrated": "Sync paired; data is not yet loaded.",
      clean: "Sync is up to date.",
      queued: "Sync is queued.",
      "in-flight": "Sync is in progress.",
      conflict: "Sync needs attention because of a conflict.",
      offline: "Sync is offline.",
      blocked: "Sync is blocked.",
      failed: "Sync failed.",
    } as const;
    const statuses = Object.entries(labels) as [keyof typeof labels, string][];
    linkedSync.status = statuses[0]![0];
    const view = render(<CalibrationModal />);

    for (const [value, label] of statuses) {
      await act(async () => {
        linkedSync.status = value;
        view.rerender(<CalibrationModal />);
      });
      expect(screen.getByTestId("mpc-calibration-linked-sync-status").textContent).toContain(label);
    }

    fireEvent.click(screen.getByTestId("calibration-modal-close"));
    expect(mockCalibrationState.closeModal).toHaveBeenCalledOnce();
    expect(linkedSync.status).toBe("failed");
  });

  it("renders web pairing controls without Electron configured-service controls", async () => {
    render(<CalibrationModal />);

    expect(await screen.findByRole("button", { name: "Pair web service" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect configured service" })).toBeNull();
  });

  it("aborts only its shared-context subscription on close and never ranks stale results", async () => {
    let resolveContext!: (value: {
      calibrationCases: [];
      model: { sourceStats: Record<string, never> };
      profiles: Record<string, never>;
    }) => void;
    mockGetSharedMpcPreferenceContext.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveContext = resolve;
        })
    );

    const view = render(<CalibrationModal />);

    await waitFor(() => {
      expect(mockGetSharedMpcPreferenceContext).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(AbortSignal)
      );
    });
    const signal = mockGetSharedMpcPreferenceContext.mock.calls[0]?.[1] as AbortSignal;

    mockCalibrationState.open = false;
    view.rerender(<CalibrationModal />);
    expect(signal.aborted).toBe(true);

    resolveContext({ calibrationCases: [], model: { sourceStats: {} }, profiles: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockRankCandidates).not.toHaveBeenCalled();
  });
});
