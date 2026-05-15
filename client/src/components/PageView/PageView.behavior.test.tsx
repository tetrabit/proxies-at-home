import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  undoableReorderCards: vi.fn(async () => undefined),
  undoableReorderMultipleCards: vi.fn(async () => undefined),
}));
vi.mock("@/helpers/dbUtils", () => ({ rebalanceCardOrders: vi.fn(async () => undefined) }));
vi.mock("@/db", () => ({ db: { cards: { update: vi.fn(async () => undefined) } } }));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div data-testid="dnd-context">{children}</div>,
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
vi.mock("../MpcUpgradeModal", () => ({ default: () => <div data-testid="mpc-modal" /> }));
vi.mock("../CalibrationModal", () => ({ default: () => <div data-testid="calibration-modal" /> }));

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
    vi.clearAllMocks();
    cleanup();
    state.settings.zoom = 1;
    state.settings.pageSizeUnit = "in";
    state.settings.bleedEdge = false;
    state.selection.selectedCards = new Set();
    state.selection.flippedCards = new Set();
    state.selection.lastClickedIndex = null;
    state.modalState.artwork = false;
    state.modalState.editor = false;
    state.modalState.upgrade = false;
    state.pixiProps = [];
    state.overlayProps = [];
    state.floatingProps = [];
    state.contextMenuProps = [];
    vi.stubGlobal("ResizeObserver", class ResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    });
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:card"), revokeObjectURL: vi.fn() });
  });

  afterEach(() => {
    cleanup();
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

    pixiProps.onRenderedCardsChange(new Set(["card-1"]));
    await waitFor(() => expect(state.overlayProps.length).toBeGreaterThan(1));

    fireEvent.scroll(screen.getByTestId("pull-to-refresh"), { target: { scrollTop: 48 } });
    expect(state.zoomHook.updateCenterOffset).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("card-controls"));
    expect(state.contextMenuProps.at(-1)).toEqual(expect.objectContaining({ contextMenu: expect.objectContaining({ visible: true, cardUuid: "card-1" }) }));

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
});
