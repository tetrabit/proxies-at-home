import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const settingsState = {
    bleedEdge: true,
    bleedEdgeWidth: 0.125,
    bleedEdgeUnit: "in",
    withBleedSourceAmount: 1,
    withBleedTargetMode: "preserve",
    withBleedTargetAmount: 2,
    noBleedTargetMode: "add",
    noBleedTargetAmount: 3,
    filterManaCost: ["1"],
    filterColors: ["R"],
    filterTypes: ["Creature"],
    filterCategories: ["main"],
    filterMatchType: "any",
    dpi: 800,
  };
  const userPreferencesState = {
    preferences: {
      settingsPanelWidth: 340,
      uploadPanelWidth: 350,
      isSettingsPanelCollapsed: false,
      isUploadPanelCollapsed: false,
    },
    setSettingsPanelWidth: vi.fn(),
    setUploadPanelWidth: vi.fn(),
    setIsSettingsPanelCollapsed: vi.fn(),
    setIsUploadPanelCollapsed: vi.fn(),
  };
  const projectState = { currentProjectId: "project-1" };
  const ensureProcessed = vi.fn().mockResolvedValue(undefined);
  return {
    settingsState,
    userPreferencesState,
    projectState,
    imageVersionState: { imageVersion: 0 },
    setFlipped: vi.fn(),
    useLiveQuery: vi.fn(() => []),
    ensureProcessed,
    getLoadingState: vi.fn(() => ({ isLoading: false })),
    reprocessSelectedImages: vi.fn(),
    cancelProcessing: vi.fn(),
    imageProcessor: { prewarm: vi.fn() },
    ensureBuiltinCardbacksInDb: vi.fn().mockResolvedValue(undefined),
    initializeFlipState: vi.fn().mockResolvedValue(undefined),
    enforceImageCacheLimits: vi.fn(),
    enforceMetadataCacheLimits: vi.fn(),
    rebalanceCardOrders: vi.fn(),
    queueBulkPreRender: vi.fn(),
    hasActiveAdjustments: vi.fn(() => false),
    dbCardsToArray: vi.fn().mockResolvedValue([]),
    dbImagesEach: vi.fn().mockResolvedValue(undefined),
    dbImagesToArray: vi.fn().mockResolvedValue([]),
    dbCardbacksEach: vi.fn().mockResolvedValue(undefined),
    dbCardbacksToArray: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: mocks.useLiveQuery,
}));

vi.mock("../components/CardEditorModal/ResizeHandle", () => ({
  ResizeHandle: ({
    side,
    onToggle,
    onReset,
    onResizeStart,
  }: {
    side: "left" | "right";
    onToggle: () => void;
    onReset: () => void;
    onResizeStart: (event: {
      preventDefault: () => void;
      clientX: number;
    }) => void;
  }) => (
    <div data-testid={`resize-${side}`}>
      <button onClick={onToggle}>{side} toggle</button>
      <button onClick={onReset}>{side} reset</button>
      <button
        onClick={() => onResizeStart({ preventDefault: vi.fn(), clientX: 100 })}
      >
        {side} resize
      </button>
    </div>
  ),
}));

vi.mock("../components/common", () => ({
  ToastContainer: () => <div data-testid="toast-container" />,
}));

vi.mock("../components/PageView", () => ({
  PageView: ({
    mobile,
    active,
    cards,
    allCards,
    images,
  }: {
    mobile?: boolean;
    active?: boolean;
    cards: unknown[];
    allCards: unknown[];
    images: unknown[];
  }) => (
    <div
      data-testid="page-view"
      data-mobile={String(!!mobile)}
      data-active={String(active)}
    >
      {cards.length}:{allCards.length}:{images.length}
    </div>
  ),
  PageSettingsControls: ({
    mobile,
    cards,
  }: {
    mobile?: boolean;
    cards: unknown[];
  }) => (
    <div data-testid="page-settings" data-mobile={String(!!mobile)}>
      {cards.length}
    </div>
  ),
}));

vi.mock("../components/UploadSection", () => ({
  UploadSection: ({
    isCollapsed,
    mobile,
    cardCount,
    onToggle,
    onUploadComplete,
  }: {
    isCollapsed: boolean;
    mobile?: boolean;
    cardCount: number;
    onToggle?: () => void;
    onUploadComplete?: () => void;
  }) => (
    <div
      data-testid="upload-section"
      data-collapsed={String(isCollapsed)}
      data-mobile={String(!!mobile)}
    >
      <span>{cardCount}</span>
      <button onClick={onToggle}>upload toggle</button>
      <button onClick={onUploadComplete}>upload complete</button>
    </div>
  ),
}));

vi.mock("../hooks/useImageProcessing", () => ({
  useImageProcessing: vi.fn(() => ({
    getLoadingState: mocks.getLoadingState,
    ensureProcessed: mocks.ensureProcessed,
    reprocessSelectedImages: mocks.reprocessSelectedImages,
    cancelProcessing: mocks.cancelProcessing,
  })),
}));
vi.mock("../hooks/useProcessingMonitor", () => ({
  useProcessingMonitor: vi.fn(),
}));
vi.mock("../hooks/useCardEnrichment", () => ({ useCardEnrichment: vi.fn() }));
vi.mock("../hooks/useAutoBackup", () => ({ useAutoBackup: vi.fn() }));
vi.mock("../hooks/useFilteredAndSortedCards", () => ({
  useFilteredAndSortedCards: vi.fn(() => ({
    filteredAndSortedCards: [],
    idsToFlip: [
      { uuid: "front", targetState: true },
      { uuid: "back", targetState: false },
    ],
  })),
}));

vi.mock("../store", () => ({
  useSettingsStore: Object.assign(
    (selector: (state: typeof mocks.settingsState) => unknown) =>
      selector(mocks.settingsState),
    {
      getState: () => mocks.settingsState,
    }
  ),
  useProjectStore: Object.assign(
    (selector: (state: typeof mocks.projectState) => unknown) =>
      selector(mocks.projectState),
    {
      getState: () => ({
        currentProjectId: mocks.projectState.currentProjectId,
        projects: [],
        loadProjects: vi.fn().mockResolvedValue(undefined),
        createProject: vi.fn().mockResolvedValue("created-project"),
        switchProject: vi.fn().mockResolvedValue(undefined),
      }),
    }
  ),
  useUserPreferencesStore: Object.assign(
    (selector: (state: typeof mocks.userPreferencesState) => unknown) =>
      selector(mocks.userPreferencesState),
    {
      getState: () => mocks.userPreferencesState,
    }
  ),
}));
vi.mock("../store/loading", () => ({
  useLoadingStore: (
    selector: (state: typeof mocks.imageVersionState) => unknown
  ) => selector(mocks.imageVersionState),
}));
vi.mock("../store/selection", () => ({
  initializeFlipState: mocks.initializeFlipState,
  useSelectionStore: (
    selector: (state: { setFlipped: typeof mocks.setFlipped }) => unknown
  ) => selector({ setFlipped: mocks.setFlipped }),
}));

vi.mock("../db", () => ({
  db: {
    cards: {
      where: vi.fn(() => ({
        equals: vi.fn(() => ({ sortBy: vi.fn().mockResolvedValue([]) })),
      })),
      toArray: mocks.dbCardsToArray,
    },
    images: { each: mocks.dbImagesEach, toArray: mocks.dbImagesToArray },
    cardbacks: {
      each: mocks.dbCardbacksEach,
      toArray: mocks.dbCardbacksToArray,
    },
  },
}));
vi.mock("../helpers/imageProcessor", () => ({
  Priority: { LOW: "low" },
  ImageProcessor: { getInstance: vi.fn(() => mocks.imageProcessor) },
}));
vi.mock("@/helpers/dbUtils", () => ({
  rebalanceCardOrders: mocks.rebalanceCardOrders,
}));
vi.mock("../helpers/cacheUtils", () => ({
  enforceImageCacheLimits: mocks.enforceImageCacheLimits,
  enforceMetadataCacheLimits: mocks.enforceMetadataCacheLimits,
}));
vi.mock("../helpers/effectCache", () => ({
  queueBulkPreRender: mocks.queueBulkPreRender,
}));
vi.mock("../helpers/adjustmentUtils", () => ({
  hasActiveAdjustments: mocks.hasActiveAdjustments,
}));
vi.mock("../helpers/cardbackLibrary", () => ({
  ensureBuiltinCardbacksInDb: mocks.ensureBuiltinCardbacksInDb,
}));
vi.mock("../helpers/imageSpecs", () => ({
  getExpectedBleedWidth: vi.fn(() => 3.175),
  getHasBuiltInBleed: vi.fn(() => false),
  getEffectiveBleedMode: vi.fn(() => "add"),
  getEffectiveExistingBleedMm: vi.fn(() => 0),
}));

import ProxyBuilderPage, { getInitialLandscape } from "./ProxyBuilderPage";

const setViewport = ({
  width,
  pointerCoarse,
  hover,
  landscape,
}: {
  width: number;
  pointerCoarse: boolean;
  hover: boolean;
  landscape: boolean;
}) => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes("pointer")
      ? pointerCoarse
      : query.includes("hover")
        ? hover
        : query.includes("orientation")
          ? landscape
          : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
};

describe("ProxyBuilderPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingsState.bleedEdge = true;
    mocks.settingsState.bleedEdgeWidth = 0.125;
    mocks.settingsState.bleedEdgeUnit = "in";
    mocks.settingsState.withBleedSourceAmount = 1;
    mocks.settingsState.withBleedTargetMode = "preserve";
    mocks.settingsState.withBleedTargetAmount = 2;
    mocks.settingsState.noBleedTargetMode = "add";
    mocks.settingsState.noBleedTargetAmount = 3;
    mocks.settingsState.dpi = 800;
    mocks.userPreferencesState.preferences = {
      settingsPanelWidth: 340,
      uploadPanelWidth: 350,
      isSettingsPanelCollapsed: false,
      isUploadPanelCollapsed: false,
    };
    mocks.useLiveQuery.mockImplementation((query: () => unknown) => {
      void query();
      return [];
    });
    mocks.ensureProcessed.mockResolvedValue(undefined);
    mocks.dbCardsToArray.mockResolvedValue([]);
    mocks.dbImagesEach.mockResolvedValue(undefined);
    mocks.dbImagesToArray.mockResolvedValue([]);
    mocks.dbCardbacksEach.mockResolvedValue(undefined);
    mocks.dbCardbacksToArray.mockResolvedValue([]);
    mocks.hasActiveAdjustments.mockReturnValue(false);
    localStorage.clear();
    setViewport({
      width: 1280,
      pointerCoarse: false,
      hover: true,
      landscape: true,
    });
  });

  it("renders desktop panels, initializes one-time effects, flips filtered card ids, and resizes panels", async () => {
    render(<ProxyBuilderPage />);

    expect(screen.getByTestId("upload-section")).toHaveAttribute(
      "data-mobile",
      "false"
    );
    expect(screen.getByTestId("page-view")).toHaveAttribute(
      "data-mobile",
      "false"
    );
    expect(screen.getByTestId("page-settings")).toHaveAttribute(
      "data-mobile",
      "false"
    );

    await waitFor(() =>
      expect(mocks.ensureBuiltinCardbacksInDb).toHaveBeenCalled()
    );
    expect(mocks.initializeFlipState).toHaveBeenCalled();
    expect(mocks.setFlipped).toHaveBeenCalledWith(["front"], true);
    expect(mocks.setFlipped).toHaveBeenCalledWith(["back"], false);

    fireEvent.click(screen.getByText("left resize"));
    fireEvent.mouseMove(document, { clientX: 780 });
    fireEvent.mouseUp(document);
    expect(mocks.userPreferencesState.setUploadPanelWidth).toHaveBeenCalledWith(
      600
    );

    fireEvent.click(screen.getByText("right resize"));
    fireEvent.mouseMove(document, { clientX: -100 });
    fireEvent.mouseUp(document);
    expect(
      mocks.userPreferencesState.setSettingsPanelWidth
    ).toHaveBeenCalledWith(540);

    fireEvent.click(screen.getByText("left reset"));
    fireEvent.click(screen.getByText("right reset"));
    expect(mocks.userPreferencesState.setUploadPanelWidth).toHaveBeenCalledWith(
      320
    );
    expect(
      mocks.userPreferencesState.setSettingsPanelWidth
    ).toHaveBeenCalledWith(320);
  });

  it("initializes landscape state without a browser window", () => {
    expect(getInitialLandscape(undefined)).toBe(false);
    expect(
      getInitialLandscape({
        matchMedia: vi.fn().mockReturnValue({ matches: true }),
      })
    ).toBe(true);
  });

  it("expands collapsed desktop panels from reset handles", () => {
    mocks.userPreferencesState.preferences = {
      settingsPanelWidth: 340,
      uploadPanelWidth: 350,
      isSettingsPanelCollapsed: true,
      isUploadPanelCollapsed: true,
    };

    render(<ProxyBuilderPage />);

    expect(screen.getByTestId("upload-section")).toHaveAttribute(
      "data-collapsed",
      "true"
    );

    fireEvent.click(screen.getByText("left reset"));
    fireEvent.click(screen.getByText("right reset"));

    expect(
      mocks.userPreferencesState.setIsUploadPanelCollapsed
    ).toHaveBeenCalledWith(false);
    expect(
      mocks.userPreferencesState.setIsSettingsPanelCollapsed
    ).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByText("left resize"));
    fireEvent.mouseMove(document, { clientX: 110 });
    fireEvent.mouseUp(document);
    fireEvent.click(screen.getByText("right resize"));
    fireEvent.mouseMove(document, { clientX: 90 });
    fireEvent.mouseUp(document);

    expect(
      mocks.userPreferencesState.setIsUploadPanelCollapsed
    ).toHaveBeenCalledWith(false);
    expect(
      mocks.userPreferencesState.setIsSettingsPanelCollapsed
    ).toHaveBeenCalledWith(false);
  });

  it("renders mobile navigation, persists active view, and switches tabs", async () => {
    setViewport({
      width: 390,
      pointerCoarse: true,
      hover: false,
      landscape: false,
    });
    localStorage.setItem("activeMobileView", "upload");

    render(<ProxyBuilderPage />);

    await waitFor(() => expect(screen.getByText("Upload")).toBeInTheDocument());
    expect(screen.getByTestId("upload-section")).toHaveAttribute(
      "data-mobile",
      "true"
    );

    fireEvent.click(screen.getByText("Preview"));
    expect(localStorage.getItem("activeMobileView")).toBe("preview");
    expect(screen.getByTestId("page-view")).toHaveAttribute(
      "data-active",
      "true"
    );

    fireEvent.click(screen.getByText("Settings"));
    expect(localStorage.getItem("activeMobileView")).toBe("settings");
    expect(screen.getByTestId("page-settings")).toHaveAttribute(
      "data-mobile",
      "true"
    );

    fireEvent.click(screen.getByText("upload complete"));
    expect(localStorage.getItem("activeMobileView")).toBe("preview");
  });

  it("renders landscape mobile navigation and falls back from invalid persisted view", async () => {
    setViewport({
      width: 700,
      pointerCoarse: true,
      hover: false,
      landscape: true,
    });
    localStorage.setItem("activeMobileView", "invalid");

    render(<ProxyBuilderPage />);

    await waitFor(() =>
      expect(screen.getByTestId("page-view")).toHaveAttribute(
        "data-active",
        "true"
      )
    );

    fireEvent.click(screen.getByText("Upload"));

    expect(localStorage.getItem("activeMobileView")).toBe("upload");
    expect(screen.getByTestId("upload-section")).toHaveAttribute(
      "data-mobile",
      "true"
    );
  });

  it("processes unique unprocessed images in batches", async () => {
    vi.useFakeTimers();
    const cards = [
      { uuid: "one", imageId: "img-1" },
      { uuid: "dupe", imageId: "img-1" },
      { uuid: "two", imageId: "img-2" },
      { uuid: "no-image" },
    ];
    mocks.useLiveQuery
      .mockReturnValueOnce(cards)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([]);
    mocks.dbImagesEach.mockImplementation(
      async (cb: (image: unknown) => void) => {
        cb({
          id: "img-2",
          displayBlob: new Blob(["d"]),
          displayBlobDarkened: new Blob(["dd"]),
          exportBlob: new Blob(["e"]),
          exportDpi: mocks.settingsState.dpi,
          exportBleedWidth: 3.175,
          generatedHasBuiltInBleed: false,
          generatedBleedMode: "add",
          generatedExistingBleedMm: 0,
        });
      }
    );
    mocks.dbCardbacksEach.mockImplementation(
      async (cb: (cardback: unknown) => void) => {
        cb({ id: "cardback", displayBlob: new Blob(["cardback"]) });
      }
    );

    render(<ProxyBuilderPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(mocks.ensureProcessed).toHaveBeenCalledTimes(1);
    expect(mocks.ensureProcessed).toHaveBeenCalledWith(cards[0], "low");
    vi.useRealTimers();
  });

  it("queues processed-looking images when generation metadata mismatches", async () => {
    vi.useFakeTimers();
    const card = { uuid: "mismatch", imageId: "img-mismatch" };
    mocks.useLiveQuery
      .mockReturnValueOnce([card])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([]);
    mocks.dbImagesEach.mockImplementation(
      async (cb: (image: unknown) => void) => {
        cb({
          id: "img-mismatch",
          displayBlob: new Blob(["display"]),
          displayBlobDarkened: new Blob(["dark"]),
          exportBlob: new Blob(["export"]),
          exportDpi: 800,
          exportBleedWidth: 4,
          generatedHasBuiltInBleed: false,
          generatedBleedMode: "add",
          generatedExistingBleedMm: 0,
        });
      }
    );

    render(<ProxyBuilderPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(mocks.ensureProcessed).toHaveBeenCalledWith(card, "low");
    vi.useRealTimers();
  });

  it("reprocesses cards after DPI changes and queues adjusted effect renders", async () => {
    vi.useFakeTimers();
    const card = {
      uuid: "adjusted",
      imageId: "img-adjusted",
      overrides: { brightness: 1 },
    };
    mocks.useLiveQuery
      .mockReturnValueOnce([card])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([]);
    mocks.dbCardsToArray.mockResolvedValue([card]);
    mocks.dbImagesEach.mockImplementation(
      async (cb: (image: unknown) => void) => {
        cb({
          id: "img-adjusted",
          displayBlob: new Blob(["display"]),
          exportBlob: new Blob(["old-export"]),
          exportDpi: 300,
          exportBleedWidth: 1,
          generatedHasBuiltInBleed: false,
          generatedBleedMode: "add",
          generatedExistingBleedMm: 0,
        });
      }
    );
    mocks.dbImagesToArray.mockResolvedValue([
      { id: "img-adjusted", exportBlob: new Blob(["fresh-export"]) },
    ]);
    mocks.hasActiveAdjustments.mockReturnValue(true);

    const { rerender } = render(<ProxyBuilderPage />);
    mocks.settingsState.dpi = 900;
    rerender(<ProxyBuilderPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(550);
    });

    expect(mocks.cancelProcessing).toHaveBeenCalled();
    expect(mocks.reprocessSelectedImages).toHaveBeenCalledWith([card], 3.175);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(mocks.queueBulkPreRender).toHaveBeenCalledWith([
      expect.objectContaining({ card, exportBlob: expect.any(Blob) }),
    ]);
    vi.useRealTimers();
  });

  it.each([
    ["missing export bleed width", { exportBleedWidth: undefined }],
    ["mismatched export bleed width", { exportBleedWidth: 99 }],
    ["mismatched built-in bleed marker", { generatedHasBuiltInBleed: true }],
    ["mismatched bleed mode", { generatedBleedMode: "preserve" }],
    ["missing existing bleed marker", { generatedExistingBleedMm: undefined }],
    ["mismatched existing bleed amount", { generatedExistingBleedMm: 1 }],
    ["missing processed blobs", { displayBlob: undefined }],
  ])(
    "reprocesses cards with %s after bleed setting changes",
    async (_label, overrides) => {
      vi.useFakeTimers();
      const card = { uuid: "card", imageId: "img-card" };
      mocks.useLiveQuery
        .mockReturnValueOnce([card])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([]);
      mocks.dbCardsToArray.mockResolvedValue([card]);
      mocks.dbImagesEach.mockImplementation(
        async (cb: (image: unknown) => void) => {
          cb({
            id: "img-card",
            displayBlob: new Blob(["display"]),
            exportBlob: new Blob(["export"]),
            exportDpi: 800,
            exportBleedWidth: 3.175,
            generatedHasBuiltInBleed: false,
            generatedBleedMode: "add",
            generatedExistingBleedMm: 0,
            ...overrides,
          });
        }
      );
      mocks.dbCardbacksEach.mockImplementation(
        async (cb: (cardback: unknown) => void) => {
          cb({ id: "cardback", displayBlob: new Blob(["cardback"]) });
        }
      );

      const { rerender } = render(<ProxyBuilderPage />);
      mocks.settingsState.withBleedTargetAmount = 4;
      rerender(<ProxyBuilderPage />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(550);
      });

      expect(mocks.reprocessSelectedImages).toHaveBeenCalledWith([card], 3.175);
      vi.useRealTimers();
    }
  );

  it("reprocesses cards whose image record is missing after bleed setting changes", async () => {
    vi.useFakeTimers();
    const card = { uuid: "missing-image", imageId: "img-missing" };
    mocks.useLiveQuery
      .mockReturnValueOnce([card])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([]);
    mocks.dbCardsToArray.mockResolvedValue([card]);

    const { rerender } = render(<ProxyBuilderPage />);
    mocks.settingsState.withBleedTargetAmount = 4;
    rerender(<ProxyBuilderPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(550);
    });

    expect(mocks.reprocessSelectedImages).toHaveBeenCalledWith([card], 3.175);
    vi.useRealTimers();
  });

  it("skips reprocessing when processed image metadata still matches settings", async () => {
    vi.useFakeTimers();
    const card = { uuid: "card", imageId: "img-card" };
    mocks.useLiveQuery
      .mockReturnValueOnce([card])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([]);
    mocks.dbCardsToArray.mockResolvedValue([card]);
    mocks.dbImagesEach.mockImplementation(
      async (cb: (image: unknown) => void) => {
        cb({
          id: "img-card",
          displayBlob: new Blob(["display"]),
          exportBlob: new Blob(["export"]),
          exportDpi: 800,
          exportBleedWidth: 3.175,
          generatedHasBuiltInBleed: false,
          generatedBleedMode: "add",
          generatedExistingBleedMm: 0,
        });
      }
    );

    const { rerender } = render(<ProxyBuilderPage />);
    mocks.settingsState.withBleedTargetAmount = 4;
    rerender(<ProxyBuilderPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(550);
    });

    expect(mocks.reprocessSelectedImages).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("runs deferred cache maintenance timers", () => {
    vi.useFakeTimers();
    render(<ProxyBuilderPage />);

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(mocks.enforceImageCacheLimits).toHaveBeenCalled();
    expect(mocks.enforceMetadataCacheLimits).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
