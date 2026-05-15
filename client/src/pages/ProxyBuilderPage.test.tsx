import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  };
});

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: mocks.useLiveQuery,
}));

vi.mock("../components/CardEditorModal/ResizeHandle", () => ({
  ResizeHandle: ({ side, onToggle, onReset, onResizeStart }: {
    side: "left" | "right";
    onToggle: () => void;
    onReset: () => void;
    onResizeStart: (event: { preventDefault: () => void; clientX: number }) => void;
  }) => (
    <div data-testid={`resize-${side}`}>
      <button onClick={onToggle}>{side} toggle</button>
      <button onClick={onReset}>{side} reset</button>
      <button onClick={() => onResizeStart({ preventDefault: vi.fn(), clientX: 100 })}>{side} resize</button>
    </div>
  ),
}));

vi.mock("../components/common", () => ({
  ToastContainer: () => <div data-testid="toast-container" />,
}));

vi.mock("../components/PageView", () => ({
  PageView: ({ mobile, active, cards, allCards, images }: { mobile?: boolean; active?: boolean; cards: unknown[]; allCards: unknown[]; images: unknown[] }) => (
    <div data-testid="page-view" data-mobile={String(!!mobile)} data-active={String(active)}>
      {cards.length}:{allCards.length}:{images.length}
    </div>
  ),
  PageSettingsControls: ({ mobile, cards }: { mobile?: boolean; cards: unknown[] }) => (
    <div data-testid="page-settings" data-mobile={String(!!mobile)}>{cards.length}</div>
  ),
}));

vi.mock("../components/UploadSection", () => ({
  UploadSection: ({ isCollapsed, mobile, cardCount, onToggle, onUploadComplete }: {
    isCollapsed: boolean;
    mobile?: boolean;
    cardCount: number;
    onToggle?: () => void;
    onUploadComplete?: () => void;
  }) => (
    <div data-testid="upload-section" data-collapsed={String(isCollapsed)} data-mobile={String(!!mobile)}>
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
vi.mock("../hooks/useProcessingMonitor", () => ({ useProcessingMonitor: vi.fn() }));
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
  useSettingsStore: Object.assign((selector: (state: typeof mocks.settingsState) => unknown) => selector(mocks.settingsState), {
    getState: () => mocks.settingsState,
  }),
  useProjectStore: Object.assign((selector: (state: typeof mocks.projectState) => unknown) => selector(mocks.projectState), {
    getState: () => ({
      currentProjectId: mocks.projectState.currentProjectId,
      projects: [],
      loadProjects: vi.fn().mockResolvedValue(undefined),
      createProject: vi.fn().mockResolvedValue("created-project"),
      switchProject: vi.fn().mockResolvedValue(undefined),
    }),
  }),
  useUserPreferencesStore: Object.assign((selector: (state: typeof mocks.userPreferencesState) => unknown) => selector(mocks.userPreferencesState), {
    getState: () => mocks.userPreferencesState,
  }),
}));
vi.mock("../store/loading", () => ({
  useLoadingStore: (selector: (state: typeof mocks.imageVersionState) => unknown) => selector(mocks.imageVersionState),
}));
vi.mock("../store/selection", () => ({
  initializeFlipState: mocks.initializeFlipState,
  useSelectionStore: (selector: (state: { setFlipped: typeof mocks.setFlipped }) => unknown) => selector({ setFlipped: mocks.setFlipped }),
}));

vi.mock("../db", () => ({
  db: {
    cards: { where: vi.fn(), toArray: vi.fn().mockResolvedValue([]) },
    images: { each: vi.fn().mockResolvedValue(undefined), toArray: vi.fn().mockResolvedValue([]) },
    cardbacks: { each: vi.fn().mockResolvedValue(undefined), toArray: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("../helpers/imageProcessor", () => ({
  Priority: { LOW: "low" },
  ImageProcessor: { getInstance: vi.fn(() => mocks.imageProcessor) },
}));
vi.mock("@/helpers/dbUtils", () => ({ rebalanceCardOrders: mocks.rebalanceCardOrders }));
vi.mock("../helpers/cacheUtils", () => ({
  enforceImageCacheLimits: mocks.enforceImageCacheLimits,
  enforceMetadataCacheLimits: mocks.enforceMetadataCacheLimits,
}));
vi.mock("../helpers/effectCache", () => ({ queueBulkPreRender: vi.fn() }));
vi.mock("../helpers/adjustmentUtils", () => ({ hasActiveAdjustments: vi.fn(() => false) }));
vi.mock("../helpers/cardbackLibrary", () => ({ ensureBuiltinCardbacksInDb: mocks.ensureBuiltinCardbacksInDb }));
vi.mock("../helpers/imageSpecs", () => ({
  getExpectedBleedWidth: vi.fn(() => 3.175),
  getHasBuiltInBleed: vi.fn(() => false),
  getEffectiveBleedMode: vi.fn(() => "add"),
  getEffectiveExistingBleedMm: vi.fn(() => 0),
}));

import ProxyBuilderPage from "./ProxyBuilderPage";

const setViewport = ({ width, pointerCoarse, hover, landscape }: { width: number; pointerCoarse: boolean; hover: boolean; landscape: boolean }) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes("pointer") ? pointerCoarse : query.includes("hover") ? hover : query.includes("orientation") ? landscape : false,
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
    localStorage.clear();
    setViewport({ width: 1280, pointerCoarse: false, hover: true, landscape: true });
  });

  it("renders desktop panels, initializes one-time effects, flips filtered card ids, and resizes panels", async () => {
    render(<ProxyBuilderPage />);

    expect(screen.getByTestId("upload-section")).toHaveAttribute("data-mobile", "false");
    expect(screen.getByTestId("page-view")).toHaveAttribute("data-mobile", "false");
    expect(screen.getByTestId("page-settings")).toHaveAttribute("data-mobile", "false");

    await waitFor(() => expect(mocks.ensureBuiltinCardbacksInDb).toHaveBeenCalled());
    expect(mocks.initializeFlipState).toHaveBeenCalled();
    expect(mocks.setFlipped).toHaveBeenCalledWith(["front"], true);
    expect(mocks.setFlipped).toHaveBeenCalledWith(["back"], false);

    fireEvent.click(screen.getByText("left resize"));
    fireEvent.mouseMove(document, { clientX: 780 });
    fireEvent.mouseUp(document);
    expect(mocks.userPreferencesState.setUploadPanelWidth).toHaveBeenCalledWith(600);

    fireEvent.click(screen.getByText("right resize"));
    fireEvent.mouseMove(document, { clientX: -100 });
    fireEvent.mouseUp(document);
    expect(mocks.userPreferencesState.setSettingsPanelWidth).toHaveBeenCalledWith(540);

    fireEvent.click(screen.getByText("left reset"));
    fireEvent.click(screen.getByText("right reset"));
    expect(mocks.userPreferencesState.setUploadPanelWidth).toHaveBeenCalledWith(320);
    expect(mocks.userPreferencesState.setSettingsPanelWidth).toHaveBeenCalledWith(320);
  });

  it("renders mobile navigation, persists active view, and switches tabs", async () => {
    setViewport({ width: 390, pointerCoarse: true, hover: false, landscape: false });
    localStorage.setItem("activeMobileView", "upload");

    render(<ProxyBuilderPage />);

    await waitFor(() => expect(screen.getByText("Upload")).toBeInTheDocument());
    expect(screen.getByTestId("upload-section")).toHaveAttribute("data-mobile", "true");

    fireEvent.click(screen.getByText("Preview"));
    expect(localStorage.getItem("activeMobileView")).toBe("preview");
    expect(screen.getByTestId("page-view")).toHaveAttribute("data-active", "true");

    fireEvent.click(screen.getByText("Settings"));
    expect(localStorage.getItem("activeMobileView")).toBe("settings");
    expect(screen.getByTestId("page-settings")).toHaveAttribute("data-mobile", "true");

    fireEvent.click(screen.getByText("upload complete"));
    expect(localStorage.getItem("activeMobileView")).toBe("preview");
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
