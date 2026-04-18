import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const {
  mockCalibrationState,
  mockListDatasets,
  mockCreateDataset,
  mockListCases,
  mockListRuns,
  mockListAssets,
  mockSearchMpcAutofill,
  mockFilterByExactName,
  mockCaptureCase,
  mockSaveCase,
  mockSaveAssets,
  mockEvaluateDataset,
  mockCompareAlgorithms,
  mockBuildFixture,
  mockDownloadFixture,
  mockImportFixture,
  mockValidateFixture,
  mockDbImagesGet,
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
  mockListCases: vi.fn(),
  mockListRuns: vi.fn(),
  mockListAssets: vi.fn(),
  mockSearchMpcAutofill: vi.fn(),
  mockFilterByExactName: vi.fn(),
  mockCaptureCase: vi.fn(),
  mockSaveCase: vi.fn(),
  mockSaveAssets: vi.fn(),
  mockEvaluateDataset: vi.fn(),
  mockCompareAlgorithms: vi.fn(),
  mockBuildFixture: vi.fn(),
  mockDownloadFixture: vi.fn(),
  mockImportFixture: vi.fn(),
  mockValidateFixture: vi.fn(),
  mockDbImagesGet: vi.fn(),
}));

vi.mock("@/store", () => ({
  useCalibrationModalStore: (
    selector: (state: typeof mockCalibrationState) => unknown
  ) => selector(mockCalibrationState),
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
  filterByExactName: mockFilterByExactName,
}));

vi.mock("@/helpers/mpcCalibrationCapture", () => ({
  captureMpcCalibrationCase: mockCaptureCase,
}));

vi.mock("@/helpers/mpcCalibrationStorage", () => ({
  createMpcCalibrationDataset: mockCreateDataset,
  listMpcCalibrationDatasets: mockListDatasets,
  listMpcCalibrationCases: mockListCases,
  listMpcCalibrationRuns: mockListRuns,
  listMpcCalibrationAssets: mockListAssets,
  saveMpcCalibrationCase: mockSaveCase,
  saveMpcCalibrationAssets: mockSaveAssets,
  saveMpcCalibrationRun: vi.fn(),
  MPC_CALIBRATION_TARGET_CASE_COUNT: 9,
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
  getActivePreferenceSyncTarget: vi.fn().mockResolvedValue({
    describe: () => "Mock Sync Target",
  }),
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockListDatasets.mockResolvedValue([dataset]);
    mockListCases.mockResolvedValue([]);
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

  it("captures the selected expected candidate into the dataset", async () => {
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
      ).toContain("Sync target: Mock Sync Target · Idle");
    });

    const button = await screen.findByRole("button", {
      name: /use as expected choice/i,
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockCaptureCase).toHaveBeenCalled();
      expect(mockSaveCase).toHaveBeenCalled();
      expect(mockSaveAssets).toHaveBeenCalled();
    });
  });

  it("runs the current algorithm and updates the scoreboard", async () => {
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

    render(<CalibrationModal />);

    const runButton = await screen.findByTestId("mpc-calibration-run");
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(mockEvaluateDataset).toHaveBeenCalled();
      expect(
        screen.getByTestId("mpc-calibration-scoreboard").textContent
      ).toContain("1/1");
    });
  });

  it("shows baseline and current predictions after comparison", async () => {
    mockListCases.mockResolvedValue([
      {
        id: "case-1",
        datasetId: dataset.id,
        createdAt: 1,
        updatedAt: 1,
        source: { name: "Sol Ring" },
        candidates: [],
        expectedIdentifier: "cand-1",
      },
    ]);
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
      expect(screen.getByText(/Baseline: baseline-pick/i)).toBeTruthy();
      expect(screen.getByText(/Current: current-pick/i)).toBeTruthy();
    });
  });
});
