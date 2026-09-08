import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CardOption } from "../../../../shared/types";
import type { Image } from "@/db";

const state = vi.hoisted(() => ({
  settings: {
    pageSizeUnit: "in",
    pageWidth: 8.5,
    pageHeight: 11,
    columns: 2,
    rows: 2,
    zoom: 1,
    setZoom: vi.fn((zoom: number) => {
      state.settings.zoom = zoom;
    }),
    darkenMode: "none",
    cardPositionX: 0,
    cardPositionY: 0,
    useCustomBackOffset: false,
    cardBackPositionX: 1,
    cardBackPositionY: 2,
    cardSpacingMm: 0,
    bleedEdge: false,
    bleedEdgeWidth: 0,
    bleedEdgeUnit: "mm",
    guideWidth: 1,
    cutLineStyle: "full",
    perCardGuideStyle: "solid-rounded-rect",
    showGuideLinesOnBackCards: false,
    guideColor: "#39ff14",
    guidePlacement: "inside",
    cutGuideLengthMm: 3,
    registrationMarks: "4",
    registrationMarksPortrait: true,
    withBleedSourceAmount: 0,
    withBleedTargetMode: "none",
    withBleedTargetAmount: 0,
    noBleedTargetMode: "none",
    noBleedTargetAmount: 0,
  },
  selection: {
    selectedCards: new Set<string>(),
    flippedCards: new Set<string>(),
    lastClickedIndex: null as number | null,
    clearSelection: vi.fn(),
    selectRange: vi.fn(),
  },
  modalState: { artwork: false, editor: false, upgrade: false },
  zoomHook: { updateCenterOffset: vi.fn() },
  resizeCallbacks: [] as Array<(entries: Array<{ contentRect: { width: number; height: number } }>) => void>,
  mediaChangeHandlers: [] as Array<(event: { matches: boolean }) => void>,
  mediaRemove: vi.fn(),
  dndProps: [] as Array<{
    onDragStart: (event: { active: { id: string } }) => void;
    onDragOver: (event: { active: { id: string }; over: { id: string } | null }) => void;
    onDragEnd: (event: { active: { id: string }; over: { id: string } | null }) => Promise<void>;
    onDragCancel?: () => void;
  }>,
  undoableReorderCards: vi.fn(async (..._args: unknown[]) => undefined),
  undoableReorderMultipleCards: vi.fn(async (..._args: unknown[]) => undefined),
  rebalanceCardOrders: vi.fn(async (..._args: unknown[]) => undefined),
  dbUpdate: vi.fn(async (..._args: unknown[]) => undefined),
  pixiProps: [] as unknown[],
  overlayProps: [] as unknown[],
  floatingProps: [] as unknown[],
  contextMenuProps: [] as unknown[],
}));

vi.mock("@/store", () => ({
  useSettingsStore: Object.assign(
    (selector: (s: typeof state.settings) => unknown) => selector(state.settings),
    { getState: () => state.settings },
  ),
}));

vi.mock("@/store/selection", () => ({
  useSelectionStore: Object.assign(
    (selector: (s: typeof state.selection) => unknown) => selector(state.selection),
    { getState: () => state.selection },
  ),
}));

vi.mock("@/store/artworkModal", () => ({
  useArtworkModalStore: { getState: () => ({ open: state.modalState.artwork }) },
}));
vi.mock("@/store/cardEditorModal", () => ({
  useCardEditorModalStore: { getState: () => ({ open: state.modalState.editor }) },
}));
vi.mock("@/store/mpcUpgradeModal", () => ({
  useMpcUpgradeModalStore: { getState: () => ({ open: state.modalState.upgrade }) },
}));

vi.mock("@/hooks/usePageViewHotkeys", () => ({ usePageViewHotkeys: vi.fn() }));
vi.mock("@/hooks/usePageViewZoom", () => ({
  usePageViewZoom: () => ({
    scrollContainerRef: React.createRef<HTMLDivElement>(),
    isPinching: false,
    updateCenterOffset: state.zoomHook.updateCenterOffset,
  }),
}));

vi.mock("@/helpers/undoableActions", () => ({
  undoableReorderCards: (...args: unknown[]) => state.undoableReorderCards(...args),
  undoableReorderMultipleCards: (...args: unknown[]) => state.undoableReorderMultipleCards(...args),
}));
vi.mock("@/helpers/dbUtils", () => ({
  rebalanceCardOrders: (...args: unknown[]) => state.rebalanceCardOrders(...args),
}));
vi.mock("@/db", () => ({
  db: { cards: { update: (...args: unknown[]) => state.dbUpdate(...args) } },
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: {
    children: React.ReactNode;
    onDragStart: (event: { active: { id: string } }) => void;
    onDragOver: (event: { active: { id: string }; over: { id: string } | null }) => void;
    onDragEnd: (event: { active: { id: string }; over: { id: string } | null }) => Promise<void>;
  }) => {
    state.dndProps.push(props);
    return <div data-testid="dnd-context">{props.children}</div>;
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div data-testid="drag-overlay">{children}</div>,
  closestCenter: vi.fn(),
  MouseSensor: function MouseSensor() {},
  TouchSensor: function TouchSensor() {},
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn((...sensors: unknown[]) => sensors),
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div data-testid="sortable-context">{children}</div>,
  rectSortingStrategy: vi.fn(),
  arrayMove: <T,>(items: T[], from: number, to: number) => {
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  },
}));

vi.mock("../PixiPage/PixiVirtualCanvas", () => ({
  default: (props: unknown) => {
    state.pixiProps.push(props);
    return <div data-testid="pixi-canvas" />;
  },
}));

vi.mock("./PageComponents/CardControlsOverlay", () => ({
  CardControlsOverlay: (props: unknown) => {
    state.overlayProps.push(props);
    return <button data-testid="card-controls" onClick={() => (props as { setContextMenu: (v: unknown) => void }).setContextMenu({ visible: true, x: 10, y: 20, cardUuid: "card-1" })}>controls</button>;
  },
}));
vi.mock("./PageComponents/PageViewContextMenu", () => ({
  PageViewContextMenu: (props: unknown) => {
    state.contextMenuProps.push(props);
    return <div data-testid="context-menu" />;
  },
}));
vi.mock("./PageComponents/PageViewFloatingControls", () => ({
  PageViewFloatingControls: (props: unknown) => {
    state.floatingProps.push(props);
    return <div data-testid="floating-controls" />;
  },
}));
vi.mock("./PageComponents/PageViewSelectionBar", () => ({
  PageViewSelectionBar: () => <div data-testid="selection-bar" />,
}));
vi.mock("../common", () => ({ KeyboardShortcutsModal: () => <div data-testid="shortcuts" /> }));
vi.mock("../PullToRefresh", () => ({
  PullToRefresh: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { disabled?: boolean }>(
    ({ children, disabled, ...props }, ref) => <div data-testid="pull-to-refresh" data-disabled={String(disabled)} ref={ref} {...props}>{children}</div>,
  ),
}));
vi.mock("../ArtworkModal", () => ({ ArtworkModal: () => <div data-testid="artwork-modal" /> }));
vi.mock("../CardEditorModal/CardEditorModalWrapper", () => ({ CardEditorModalWrapper: () => <div data-testid="editor-modal" /> }));
vi.mock("../MpcUpgradeModal", () => ({
  default: () => <div data-testid="mpc-modal" />,
  MpcUpgradeModal: () => <div data-testid="mpc-modal" />,
}));
vi.mock("../CalibrationModal", () => ({
  default: () => <div data-testid="calibration-modal" />,
  CalibrationModal: () => <div data-testid="calibration-modal" />,
}));

import { PageView } from "./PageView";

const makeCard = (overrides: Partial<CardOption> = {}): CardOption => ({
  uuid: "card-1",
  name: "Card 1",
  order: 10,
  imageId: "img-1",
  isUserUpload: false,
  projectId: "project-1",
  ...overrides,
});

const images: Image[] = [
  { id: "img-1", displayBlob: new Blob(["front"]), darknessFactor: 0.25 } as Image,
  { id: "img-back", displayBlob: new Blob(["back"]), darknessFactor: 0.75 } as Image,
  { id: "cardback_custom", displayBlob: new Blob(["custom-back"]), darknessFactor: 0.65 } as Image,
];

function renderPage(cards: CardOption[], allCards: CardOption[] = cards, mobile = false) {
  return render(
    <PageView
      getLoadingState={() => "idle"}
      ensureProcessed={vi.fn()}
      cards={cards}
      allCards={allCards}
      images={images}
      mobile={mobile}
    />,
  );
}

describe("PageView behavior", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    cleanup();
    state.settings.zoom = 1;
    state.settings.pageSizeUnit = "in";
    state.settings.bleedEdge = false;
    state.settings.perCardGuideStyle = "solid-rounded-rect";
    state.settings.showGuideLinesOnBackCards = false;
    state.selection.selectedCards = new Set();
    state.selection.flippedCards = new Set();
    state.selection.lastClickedIndex = null;
    state.modalState.artwork = false;
    state.modalState.editor = false;
    state.modalState.upgrade = false;
    state.dndProps = [];
    state.undoableReorderCards.mockClear();
    state.undoableReorderMultipleCards.mockClear();
    state.rebalanceCardOrders.mockClear();
    state.dbUpdate.mockClear();
    state.pixiProps = [];
    state.overlayProps = [];
    state.floatingProps = [];
    state.contextMenuProps = [];
    state.resizeCallbacks = [];
    state.mediaChangeHandlers = [];
    state.mediaRemove.mockClear();
    vi.stubGlobal("ResizeObserver", class ResizeObserver {
      constructor(callback: (entries: Array<{ contentRect: { width: number; height: number } }>) => void) {
        state.resizeCallbacks.push(callback);
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn((_event: string, handler: (event: { matches: boolean }) => void) => {
          state.mediaChangeHandlers.push(handler);
        }),
        removeEventListener: state.mediaRemove,
      })),
    });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:card"), revokeObjectURL: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders desktop and mobile empty states with correct pull-to-refresh and controls state", () => {
    const { rerender } = renderPage([]);
    expect(screen.getByText("Welcome to")).toBeTruthy();
    expect(screen.getByText("Enter a decklist or upload files to the left to get started")).toBeTruthy();
    expect(screen.getByTestId("pull-to-refresh").getAttribute("data-disabled")).toBe("true");
    expect(state.floatingProps.at(-1)).toEqual(expect.objectContaining({ hasCards: false, mobile: false }));

    rerender(
      <PageView
        getLoadingState={() => "idle"}
        ensureProcessed={vi.fn()}
        cards={[]}
        allCards={[]}
        images={[]}
        mobile
      />,
    );
    expect(screen.getByText("Enter a decklist or upload files in the upload tab to get started")).toBeTruthy();
    expect(screen.getByTestId("pull-to-refresh").getAttribute("data-disabled")).toBe("false");
  });

  it("reacts to media, resize, wheel, keyboard, and card-clear lifecycle changes", async () => {
    const wheelHandlers: EventListener[] = [];
    const originalAddEventListener = HTMLElement.prototype.addEventListener;
    const addListener = vi
      .spyOn(HTMLElement.prototype, "addEventListener")
      .mockImplementation(function (this: HTMLElement, type, listener, options) {
        if (type === "wheel") wheelHandlers.push(listener as EventListener);
        return originalAddEventListener.call(this, type, listener, options);
      });
    const first = makeCard();
    const { rerender, unmount } = renderPage([first]);
    await act(async () => undefined);

    act(() => state.mediaChangeHandlers[0]?.({ matches: true }));
    act(() => state.resizeCallbacks[0]?.([]));
    act(() => state.resizeCallbacks[0]?.([
      { contentRect: { width: 640, height: 480 } },
    ]));

    const scrollRoot = screen.getByTestId("pull-to-refresh");
    const wheel = wheelHandlers.at(-1)!;
    wheel({ ctrlKey: false } as unknown as Event);
    wheel({
      ctrlKey: true,
      target: document.body,
      preventDefault: vi.fn(),
      deltaY: 100,
    } as unknown as Event);
    const preventDefault = vi.fn();
    wheel({
      ctrlKey: true,
      target: scrollRoot,
      preventDefault,
      deltaY: -100,
    } as unknown as Event);
    expect(preventDefault).toHaveBeenCalled();
    expect(state.settings.setZoom).toHaveBeenCalledWith(1.1);

    fireEvent.keyDown(document, { key: "x" });
    fireEvent.keyDown(document, { key: "x", ctrlKey: true });

    rerender(
      <PageView
        getLoadingState={() => "idle"}
        ensureProcessed={vi.fn()}
        cards={[]}
        allCards={[]}
        images={[]}
      />,
    );
    await act(async () => undefined);
    unmount();
    expect(state.mediaRemove).toHaveBeenCalled();
    addListener.mockRestore();
  });

  it("maps visible front cards, back-card blobs, blank backs, rendered cards, context menu, scroll, and keyboard shortcuts", async () => {
    const front = makeCard({ linkedBackId: "back-card" });
    const back = makeCard({ uuid: "back-card", linkedFrontId: "card-1", imageId: "img-back" });
    const second = makeCard({ uuid: "card-2", order: 20, imageId: undefined });
    state.selection.flippedCards = new Set(["card-1"]);

    const { rerender } = renderPage([front, back, second], [front, back, second]);

    await waitFor(() => expect(state.pixiProps.length).toBeGreaterThan(0));
    const pixiProps = state.pixiProps.at(-1) as { cards: Array<{ card: CardOption; backBlob?: Blob; backImageId?: string }>; perCardGuideColor: number; onRenderedCardsChange: (s: Set<string>) => void };
    expect(pixiProps.cards.map((c) => c.card.uuid)).toEqual(["card-1", "card-2"]);
    expect(pixiProps.cards[0].backBlob).toBe(images[1].displayBlob);
    expect(pixiProps.cards[0].backImageId).toBe("img-back");
    expect(pixiProps.perCardGuideColor).toBe(0x39ff14);

    act(() => pixiProps.onRenderedCardsChange(new Set(["card-1"])));
    await waitFor(() => expect(state.overlayProps.length).toBeGreaterThan(1));

    fireEvent.scroll(screen.getByTestId("pull-to-refresh"), { target: { scrollTop: 48 } });
    expect(state.zoomHook.updateCenterOffset).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("card-controls"));
    expect(state.contextMenuProps.at(-1)).toEqual(expect.objectContaining({ contextMenu: expect.objectContaining({ visible: true, cardUuid: "card-1" }) }));

    const rangeProps = state.overlayProps.at(-1) as { onRangeSelect: (index: number) => void };
    rangeProps.onRangeSelect(1);
    expect(state.selection.selectRange).not.toHaveBeenCalled();
    state.selection.lastClickedIndex = 0;
    rerender(
      <PageView
        getLoadingState={() => "idle"}
        ensureProcessed={vi.fn()}
        cards={[front, back, second]}
        allCards={[front, back, second]}
        images={images}
      />,
    );
    (state.overlayProps.at(-1) as { onRangeSelect: (index: number) => void }).onRangeSelect(1);
    expect(state.selection.selectRange).toHaveBeenCalledWith(["card-1", "card-2"], 1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(state.selection.clearSelection).toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "=", ctrlKey: true });
    expect(state.settings.setZoom).toHaveBeenCalledWith(1.1);
    fireEvent.keyDown(document, { key: "-", ctrlKey: true });
    expect(state.settings.setZoom).toHaveBeenCalledWith(1);
    fireEvent.keyDown(document, { key: "0", metaKey: true });
    expect(state.settings.setZoom).toHaveBeenCalledWith(1);

    state.modalState.artwork = true;
    fireEvent.keyDown(document, { key: "Escape" });
    expect(state.selection.clearSelection).toHaveBeenCalledTimes(1);
    state.modalState.artwork = false;

    state.settings.pageSizeUnit = "mm";
    state.settings.bleedEdge = true;
    state.settings.bleedEdgeWidth = 0.125;
    state.settings.bleedEdgeUnit = "in";
    state.settings.useCustomBackOffset = true;
    rerender(
      <PageView
        getLoadingState={() => "idle"}
        ensureProcessed={vi.fn()}
        cards={[front]}
        allCards={[front, { ...back, imageId: "cardback_builtin_blank" }]}
        images={images}
        mobile
      />,
    );
    await waitFor(() => expect(state.pixiProps.at(-1)).toEqual(expect.objectContaining({ zoom: 0.4 })));
  });

  it("reorders multi-selected cards and restores a cancelled multi-drag", async () => {
    vi.useFakeTimers();
    const first = makeCard({ uuid: "card-1", order: 10 });
    const second = makeCard({ uuid: "card-2", order: 20, imageId: "img-1" });
    const third = makeCard({ uuid: "card-3", order: 30, imageId: "img-1" });
    state.selection.selectedCards = new Set(["card-1", "card-2"]);
    renderPage([first, second, third]);

    await act(async () => undefined);
    act(() => state.dndProps.at(-1)!.onDragStart({ active: { id: "card-1" } }));
    act(() => vi.advanceTimersByTime(50));
    await act(async () => undefined);

    act(() => state.dndProps.at(-1)!.onDragOver({
      active: { id: "card-1" },
      over: { id: "card-3" },
    }));
    act(() => vi.advanceTimersByTime(100));
    await act(async () => undefined);
    await act(async () => {
      await state.dndProps.at(-1)!.onDragEnd({
        active: { id: "card-1" },
        over: { id: "card-3" },
      });
    });

    expect(state.undoableReorderMultipleCards).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ uuid: "card-1" }),
        expect.objectContaining({ uuid: "card-3" }),
      ]),
    );
    expect(state.rebalanceCardOrders).toHaveBeenCalledWith("project-1");

    act(() => state.dndProps.at(-1)!.onDragStart({ active: { id: "card-1" } }));
    act(() => vi.advanceTimersByTime(50));
    await act(async () => undefined);
    await act(async () => {
      await state.dndProps.at(-1)!.onDragEnd({ active: { id: "card-1" }, over: null });
    });
  });

  it("records exact multi-drag undo adjustments with a single original-order lookup pass", async () => {
    vi.useFakeTimers();
    const cards = Array.from({ length: 64 }, (_, index) =>
      makeCard({
        uuid: `card-${index + 1}`,
        order: (index + 1) * 100,
        imageId: "img-1",
      }),
    );
    let uuidReads = 0;
    for (const card of cards) {
      const uuid = card.uuid;
      Object.defineProperty(card, "uuid", {
        configurable: true,
        enumerable: true,
        get: () => {
          uuidReads += 1;
          return uuid;
        },
      });
    }

    state.selection.selectedCards = new Set(cards.slice(0, 32).map((card) => card.uuid));
    renderPage(cards);
    await act(async () => undefined);

    act(() => state.dndProps.at(-1)!.onDragStart({ active: { id: "card-1" } }));
    act(() => vi.advanceTimersByTime(50));
    await act(async () => undefined);
    act(() => state.dndProps.at(-1)!.onDragOver({
      active: { id: "card-1" },
      over: { id: "card-64" },
    }));
    act(() => vi.advanceTimersByTime(100));
    await act(async () => undefined);

    uuidReads = 0;
    await act(async () => {
      await state.dndProps.at(-1)!.onDragEnd({
        active: { id: "card-1" },
        over: { id: "card-64" },
      });
    });

    expect(uuidReads).toBeLessThan(cards.length * 10);
    expect(state.undoableReorderMultipleCards).toHaveBeenCalledWith(
      expect.arrayContaining([
        { uuid: "card-33", oldOrder: 3300, newOrder: 10 },
        { uuid: "card-1", oldOrder: 100, newOrder: 330 },
      ]),
    );
  });

  it("updates PageView and drag-overlay geometry for every source target primitive", async () => {
    const sourceCases = [
      {
        name: "with-bleed target mode",
        hasBuiltInBleed: true,
        configure: () => {
          state.settings.withBleedTargetMode = "none";
          state.settings.withBleedTargetAmount = 3;
        },
        update: () => {
          state.settings.withBleedTargetMode = "manual";
        },
        expectedInitialBleed: 0,
        expectedBleed: 3,
      },
      {
        name: "with-bleed target amount",
        hasBuiltInBleed: true,
        configure: () => {
          state.settings.withBleedTargetMode = "manual";
          state.settings.withBleedTargetAmount = 1;
        },
        update: () => {
          state.settings.withBleedTargetAmount = 4;
        },
        expectedInitialBleed: 1,
        expectedBleed: 4,
      },
      {
        name: "no-bleed target mode",
        hasBuiltInBleed: false,
        configure: () => {
          state.settings.noBleedTargetMode = "none";
          state.settings.noBleedTargetAmount = 3;
        },
        update: () => {
          state.settings.noBleedTargetMode = "manual";
        },
        expectedInitialBleed: 0,
        expectedBleed: 3,
      },
      {
        name: "no-bleed target amount",
        hasBuiltInBleed: false,
        configure: () => {
          state.settings.noBleedTargetMode = "manual";
          state.settings.noBleedTargetAmount = 1;
        },
        update: () => {
          state.settings.noBleedTargetAmount = 4;
        },
        expectedInitialBleed: 1,
        expectedBleed: 4,
      },
    ];

    for (const sourceCase of sourceCases) {
      cleanup();
      state.dndProps = [];
      state.settings.bleedEdge = false;
      state.settings.bleedEdgeWidth = 0;
      state.settings.withBleedSourceAmount = 0;
      state.settings.withBleedTargetMode = "none";
      state.settings.withBleedTargetAmount = 0;
      state.settings.noBleedTargetMode = "none";
      state.settings.noBleedTargetAmount = 0;
      sourceCase.configure();

      const card = makeCard({
        uuid: `source-${sourceCase.name}`,
        hasBuiltInBleed: sourceCase.hasBuiltInBleed,
      });
      const { rerender } = renderPage([card]);
      expect(
        (state.pixiProps.at(-1) as { cards: Array<{ bleedMm: number }> }).cards[0].bleedMm,
      ).toBe(sourceCase.expectedInitialBleed);

      sourceCase.update();
      rerender(
        <PageView
          getLoadingState={() => "idle"}
          ensureProcessed={vi.fn()}
          cards={[card]}
          allCards={[card]}
          images={images}
        />,
      );

      expect(
        (state.pixiProps.at(-1) as { cards: Array<{ bleedMm: number; width: number }> }).cards[0],
        sourceCase.name,
      ).toEqual(expect.objectContaining({
        bleedMm: sourceCase.expectedBleed,
        width: expect.closeTo((63 + sourceCase.expectedBleed * 2) * (96 / 25.4), 5),
      }));

      act(() => state.dndProps.at(-1)!.onDragStart({ active: { id: card.uuid } }));
      await act(async () => undefined);
      const overlayImage = screen.getByTestId("drag-overlay").querySelector("img")!;
      expect(overlayImage.parentElement?.style.width, sourceCase.name).toBe(
        `${(63 + sourceCase.expectedBleed * 2) * (96 / 25.4)}px`,
      );
    }
  });

  it("owns drag-overlay URLs across blob replacement, removal, and unmount", async () => {
    const firstBlob = new Blob(["first"]);
    const secondBlob = new Blob(["second"]);
    const firstImage = { id: "drag-image", displayBlob: firstBlob } as Image;
    const secondImage = { id: "drag-image", displayBlob: secondBlob } as Image;
    const card = makeCard({ imageId: "drag-image" });
    const createObjectURL = URL.createObjectURL as ReturnType<typeof vi.fn>;
    const revokeObjectURL = URL.revokeObjectURL as ReturnType<typeof vi.fn>;
    createObjectURL.mockImplementationOnce(() => "blob:first").mockImplementationOnce(() => "blob:second");

    renderToString(
      <PageView
        getLoadingState={() => "idle"}
        ensureProcessed={vi.fn()}
        cards={[card]}
        allCards={[card]}
        images={[firstImage]}
      />,
    );
    expect(createObjectURL).not.toHaveBeenCalled();

    const { rerender, unmount } = render(
      <PageView
        getLoadingState={() => "idle"}
        ensureProcessed={vi.fn()}
        cards={[card]}
        allCards={[card]}
        images={[firstImage]}
      />,
    );
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledWith(firstBlob));

    rerender(
      <PageView
        getLoadingState={() => "idle"}
        ensureProcessed={vi.fn()}
        cards={[card]}
        allCards={[card]}
        images={[secondImage]}
      />,
    );
    await waitFor(() => {
      expect(createObjectURL).toHaveBeenLastCalledWith(secondBlob);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:first");
    });

    rerender(
      <PageView
        getLoadingState={() => "idle"}
        ensureProcessed={vi.fn()}
        cards={[card]}
        allCards={[card]}
        images={[]}
      />,
    );
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:second"));

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenNthCalledWith(1, "blob:first");
    expect(revokeObjectURL).toHaveBeenNthCalledWith(2, "blob:second");
  });

  it("cancels owned delayed multi-drag timers on cancellation and unmount", async () => {
    vi.useFakeTimers();
    const cards = [
      makeCard({ uuid: "timer-1", order: 10 }),
      makeCard({ uuid: "timer-2", order: 20 }),
      makeCard({ uuid: "timer-3", order: 30 }),
    ];
    state.selection.selectedCards = new Set(["timer-1", "timer-2"]);
    const { unmount } = renderPage(cards);
    await act(async () => undefined);

    act(() => state.dndProps.at(-1)!.onDragStart({ active: { id: "timer-1" } }));
    act(() => state.dndProps.at(-1)!.onDragOver({
      active: { id: "timer-1" },
      over: { id: "timer-3" },
    }));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    act(() => state.dndProps.at(-1)!.onDragCancel!());
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(500));
    expect(state.undoableReorderMultipleCards).not.toHaveBeenCalled();

    act(() => state.dndProps.at(-1)!.onDragStart({ active: { id: "timer-1" } }));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(500));
    expect(state.undoableReorderMultipleCards).not.toHaveBeenCalled();
  });

  it("recovers when a multi-drag leader is missing from the rendered cards", async () => {
    vi.useFakeTimers();
    const withoutImage = makeCard({ uuid: "card-2", order: 20, imageId: undefined });
    const withImage = makeCard({ uuid: "card-4", order: 25, imageId: "img-1" });
    const remaining = makeCard({ uuid: "card-3", order: 30, imageId: "img-1" });
    state.selection.selectedCards = new Set(["missing", "card-2", "card-4"]);
    renderPage([withoutImage, withImage, remaining]);
    await act(async () => undefined);

    act(() => state.dndProps.at(-1)!.onDragStart({ active: { id: "missing" } }));
    act(() => vi.advanceTimersByTime(50));
    await act(async () => undefined);
    expect(screen.getByTestId("drag-overlay").querySelector("img")).not.toBeNull();

    await act(async () => {
      await state.dndProps.at(-1)!.onDragEnd({
        active: { id: "missing" },
        over: { id: "card-3" },
      });
    });
    expect(state.undoableReorderMultipleCards).not.toHaveBeenCalled();
  });

  it("persists single-card drags, fallback updates, and invalid drop exits", async () => {
    vi.useFakeTimers();
    const first = makeCard({ uuid: "card-1", order: 10 });
    const second = makeCard({ uuid: "card-2", order: 20, imageId: "img-1" });
    const third = makeCard({ uuid: "card-3", order: 30, imageId: "img-1" });
    state.selection.flippedCards = new Set(["card-1"]);
    const { rerender } = renderPage([first, second, third]);
    await act(async () => undefined);

    act(() => state.dndProps.at(-1)!.onDragOver({ active: { id: "card-1" }, over: null }));
    act(() => state.dndProps.at(-1)!.onDragOver({
      active: { id: "card-1" },
      over: { id: "card-1" },
    }));
    act(() => state.dndProps.at(-1)!.onDragStart({ active: { id: "card-1" } }));
    act(() => state.dndProps.at(-1)!.onDragOver({
      active: { id: "card-1" },
      over: { id: "card-2" },
    }));
    act(() => state.dndProps.at(-1)!.onDragOver({
      active: { id: "card-1" },
      over: { id: "card-3" },
    }));
    act(() => vi.advanceTimersByTime(100));
    await act(async () => undefined);
    await act(async () => {
      await state.dndProps.at(-1)!.onDragEnd({
        active: { id: "card-1" },
        over: { id: "card-3" },
      });
    });
    act(() => vi.advanceTimersByTime(500));
    expect(state.undoableReorderCards).toHaveBeenCalledWith("card-1", 10, 25);

    rerender(
      <PageView
        getLoadingState={() => "idle"}
        ensureProcessed={vi.fn()}
        cards={[second, first, third]}
        allCards={[second, first, third]}
        images={[...images, { id: "no-display" } as Image]}
      />,
    );
    await act(async () => undefined);

    state.undoableReorderCards.mockClear();
    await act(async () => {
      await state.dndProps.at(-1)!.onDragEnd({
        active: { id: "card-2" },
        over: { id: "card-1" },
      });
    });
    expect(state.dbUpdate).toHaveBeenCalled();

    await act(async () => {
      await state.dndProps.at(-1)!.onDragEnd({
        active: { id: "missing" },
        over: { id: "card-1" },
      });
      await state.dndProps.at(-1)!.onDragEnd({ active: { id: "card-1" }, over: null });
    });

    act(() => state.dndProps.at(-1)!.onDragStart({ active: { id: "missing" } }));
    await act(async () => undefined);
    expect(screen.getByTestId("drag-overlay").querySelector("img")).toBeNull();
    act(() => state.dndProps.at(-1)!.onDragOver({
      active: { id: "missing" },
      over: { id: "card-1" },
    }));
    act(() => vi.advanceTimersByTime(100));
    await act(async () => undefined);
    await act(async () => {
      await state.dndProps.at(-1)!.onDragEnd({ active: { id: "missing" }, over: null });
    });
    act(() => vi.advanceTimersByTime(500));

    const noImageSecond = { ...second, imageId: undefined };
    rerender(
      <PageView
        getLoadingState={() => "idle"}
        ensureProcessed={vi.fn()}
        cards={[noImageSecond, first, third]}
        allCards={[noImageSecond, first, third]}
        images={images}
      />,
    );
    await act(async () => undefined);
    act(() => state.dndProps.at(-1)!.onDragStart({ active: { id: "card-2" } }));
    await act(async () => undefined);
    expect(screen.getByTestId("drag-overlay").querySelector("img")).toBeNull();
  });

  it("computes first and last insertion orders", async () => {
    state.settings.perCardGuideStyle = "solid-squared-rect";
    const first = makeCard({ uuid: "card-1", order: 0 });
    const second = makeCard({ uuid: "card-2", order: 20, imageId: "img-1" });
    const third = makeCard({ uuid: "card-3", order: 30, imageId: "img-1" });
    renderPage([first, second, third]);
    await act(async () => undefined);

    act(() => state.dndProps.at(-1)!.onDragStart({ active: { id: "card-3" } }));
    await act(async () => {
      await state.dndProps.at(-1)!.onDragEnd({
        active: { id: "card-3" },
        over: { id: "card-1" },
      });
    });
    expect(state.undoableReorderCards).toHaveBeenLastCalledWith("card-3", 30, -10);

    act(() => state.dndProps.at(-1)!.onDragStart({ active: { id: "card-3" } }));
    await act(async () => {
      await state.dndProps.at(-1)!.onDragEnd({
        active: { id: "card-3" },
        over: { id: "card-2" },
      });
    });
    expect(state.undoableReorderCards).toHaveBeenLastCalledWith("card-3", 30, 30);

    cleanup();
    state.dndProps = [];
    const zeroFirst = makeCard({ uuid: "zero-1", order: 0 });
    const zeroSecond = makeCard({ uuid: "zero-2", order: 0 });
    renderPage([zeroFirst, zeroSecond]);
    await act(async () => undefined);
    act(() => state.dndProps.at(-1)!.onDragStart({ active: { id: "zero-1" } }));
    await act(async () => {
      await state.dndProps.at(-1)!.onDragEnd({
        active: { id: "zero-1" },
        over: { id: "zero-2" },
      });
    });
    expect(state.undoableReorderCards).toHaveBeenLastCalledWith("zero-1", 0, 10);
  });

  it("records and rebalances a precision-limited drag", async () => {
    const first = makeCard({ uuid: "card-1", order: 10 });
    const second = makeCard({ uuid: "card-2", order: 10.0005 });
    const third = makeCard({ uuid: "card-3", order: 20 });
    renderPage([first, second, third]);
    await act(async () => undefined);

    act(() => state.dndProps.at(-1)!.onDragStart({ active: { id: "card-3" } }));
    await act(async () => {
      await state.dndProps.at(-1)!.onDragEnd({
        active: { id: "card-3" },
        over: { id: "card-2" },
      });
    });

    expect(state.undoableReorderCards).toHaveBeenCalledWith(
      "card-3",
      20,
      expect.any(Number),
    );
    expect(state.rebalanceCardOrders).toHaveBeenCalledWith("project-1");
  });

  it("uses the precision fallback without rebalancing cards that lack a project", async () => {
    const first = makeCard({ uuid: "card-1", order: 10, projectId: undefined });
    const second = makeCard({ uuid: "card-2", order: 10.0005, projectId: undefined });
    const third = makeCard({ uuid: "card-3", order: 20, projectId: undefined });
    renderPage([first, second, third]);
    await act(async () => undefined);

    act(() => state.dndProps.at(-1)!.onDragStart({ active: { id: "card-1" } }));
    await act(async () => {
      await state.dndProps.at(-1)!.onDragEnd({
        active: { id: "card-3" },
        over: { id: "card-2" },
      });
    });

    expect(state.dbUpdate).toHaveBeenCalledWith(
      "card-3",
      expect.objectContaining({ order: expect.any(Number) }),
    );
    const precisionOrder = state.dbUpdate.mock.calls.at(-1)?.[1] as { order: number };
    expect(precisionOrder.order).toBeCloseTo(10.00025);
    expect(state.rebalanceCardOrders).not.toHaveBeenCalled();
  });

  it("keeps flipped manual cardback override bleed at the global page size", async () => {
    const front = makeCard({ linkedBackId: "back-card" });
    const back = makeCard({
      uuid: "back-card",
      linkedFrontId: "card-1",
      imageId: "cardback_custom",
      bleedMode: "generate",
      generateBleedMm: 5,
    });
    state.settings.bleedEdge = true;
    state.settings.bleedEdgeWidth = 1.5;
    state.settings.bleedEdgeUnit = "mm";
    state.selection.flippedCards = new Set(["card-1"]);

    renderPage([front, back], [front, back]);

    await waitFor(() => expect(state.pixiProps.length).toBeGreaterThan(0));
    const pixiProps = state.pixiProps.at(-1) as { cards: Array<{ width: number; height: number; bleedMm: number }> };
    const expectedWidth = (63 + 1.5 * 2) * (96 / 25.4);
    const expectedHeight = (88 + 1.5 * 2) * (96 / 25.4);

    expect(pixiProps.cards[0].bleedMm).toBe(1.5);
    expect(pixiProps.cards[0].width).toBeCloseTo(expectedWidth);
    expect(pixiProps.cards[0].height).toBeCloseTo(expectedHeight);
  });
});
