import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

const artworkState = vi.hoisted(() => ({
    openModal: vi.fn(),
}));

const selectionState = vi.hoisted(() => ({
    selectedCards: new Set<string>(),
    flippedCards: new Set<string>(),
    toggleSelection: vi.fn(),
    toggleFlip: vi.fn(),
}));

const sortableState = vi.hoisted(() => ({
    isDragging: false,
}));

vi.mock("@dnd-kit/sortable", () => ({
    useSortable: ({ id, disabled }: { id: string; disabled?: boolean }) => ({
        attributes: { "data-sortable-disabled": String(!!disabled) },
        listeners: { "data-sortable-listener": id },
        setNodeRef: vi.fn(),
        transition: "transform 100ms ease",
        isDragging: sortableState.isDragging,
    }),
}));

vi.mock("@/store", () => ({
    useArtworkModalStore: (selector: (state: typeof artworkState) => unknown) => selector(artworkState),
}));

vi.mock("@/store/selection", () => ({
    useSelectionStore: (selector: (state: typeof selectionState) => unknown) => selector(selectionState),
}));

vi.mock("@/components/common", () => ({
    PlaceholderCard: ({
        name,
        error,
        onErrorClick,
    }: {
        name: string;
        error?: string;
        onErrorClick: React.MouseEventHandler<HTMLButtonElement>;
    }) => (
        <button type="button" onClick={onErrorClick}>
            {error ? `error:${name}` : `placeholder:${name}`}
        </button>
    ),
}));

import { CardControlsOverlay, type CardControlLayout } from "./CardControlsOverlay";

const card = {
    uuid: "card-1",
    name: "Lightning Bolt",
    imageId: "/api/cards/images/mpc/lightning-bolt",
    isToken: true,
    tokenAddedFrom: ["Goblin Guide"],
} as never;

const layout: CardControlLayout = {
    card,
    globalIndex: 2,
    screenX: 10,
    screenY: 20,
    width: 100,
    height: 140,
    hasImage: true,
};

function renderOverlay(
    overrides: Partial<React.ComponentProps<typeof CardControlsOverlay>> = {},
    layoutOverrides: Partial<CardControlLayout> = {},
) {
    const scrollContainer = document.createElement("div");
    const scrollContainerRef = { current: scrollContainer };
    const props: React.ComponentProps<typeof CardControlsOverlay> = {
        cardLayouts: [{ ...layout, ...layoutOverrides }],
        allCards: [card],
        containerWidth: 320,
        containerHeight: 240,
        scrollContainerRef,
        zoom: 2,
        setContextMenu: vi.fn(),
        ...overrides,
    };

    const result = render(<CardControlsOverlay {...props} />);
    const cardNode = result.container.querySelector("[data-dnd-sortable-item='card-1']") as HTMLElement;
    return { ...result, props, scrollContainer, cardNode };
}

describe("CardControlsOverlay", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        sortableState.isDragging = false;
        selectionState.selectedCards = new Set();
        selectionState.flippedCards = new Set();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("opens artwork and context menus from desktop card controls", () => {
        selectionState.selectedCards = new Set(["card-1"]);
        selectionState.flippedCards = new Set(["card-1"]);
        const onRangeSelect = vi.fn();
        const { props, cardNode } = renderOverlay({ onRangeSelect });

        fireEvent.click(cardNode);
        expect(artworkState.openModal).toHaveBeenCalledWith({
            card,
            index: 2,
            allCards: [card],
            initialTab: "settings",
            initialFace: "back",
            initialArtSource: "mpc",
        });

        fireEvent.contextMenu(cardNode, { clientX: 11, clientY: 22 });
        expect(props.setContextMenu).toHaveBeenCalledWith({
            visible: true,
            x: 11,
            y: 22,
            cardUuid: "card-1",
        });

        fireEvent.click(screen.getByTitle("Select card"), { shiftKey: true });
        expect(onRangeSelect).toHaveBeenCalledWith(2);

        fireEvent.click(screen.getByTestId("flip-button"));
        expect(selectionState.toggleFlip).toHaveBeenCalledWith("card-1");
    });

    it("range-selects from card clicks and handles direct checkbox/drag clicks", () => {
        const onRangeSelect = vi.fn();
        const { cardNode } = renderOverlay({ onRangeSelect });

        fireEvent.click(cardNode, { shiftKey: true });
        expect(onRangeSelect).toHaveBeenCalledWith(2);

        fireEvent.click(screen.getByTitle("Select card"));
        expect(selectionState.toggleSelection).toHaveBeenCalledWith("card-1", 2);

        fireEvent.click(screen.getByTitle("Drag"));
        expect(artworkState.openModal).not.toHaveBeenCalled();
    });

    it("supports multi-select, placeholder error click, dragging styles, and scroll sync", () => {
        sortableState.isDragging = true;
        selectionState.selectedCards = new Set(["other-card"]);
        const { container, scrollContainer, cardNode } = renderOverlay(
            { disabled: true },
            { hasImage: false, card: { ...card, lookupError: "missing art" } as never },
        );

        expect(cardNode).toHaveClass("opacity-0");
        expect(screen.getByText("error:Lightning Bolt")).toBeInTheDocument();

        fireEvent.click(cardNode, { ctrlKey: true });
        expect(selectionState.toggleSelection).toHaveBeenCalledWith("card-1", 2);

        fireEvent.click(screen.getByText("error:Lightning Bolt"));
        expect(artworkState.openModal).toHaveBeenCalledWith({
            card: { ...card, lookupError: "missing art" },
            index: 2,
            allCards: [card],
            initialTab: "artwork",
            initialOpenAdvancedSearch: true,
        });

        scrollContainer.scrollTop = 42;
        fireEvent.scroll(scrollContainer);
        const inner = container.querySelector(".overflow-hidden > div") as HTMLElement;
        expect(inner.style.transform).toBe("translateY(-42px)");
    });

    it("handles mobile single tap and double tap behavior", () => {
        vi.useFakeTimers();
        const { props, cardNode } = renderOverlay({ mobile: true });

        fireEvent.click(cardNode);
        vi.advanceTimersByTime(300);
        expect(artworkState.openModal).toHaveBeenCalledWith(
            expect.objectContaining({ initialTab: "artwork", initialFace: "front" }),
        );

        artworkState.openModal.mockClear();
        fireEvent.click(cardNode, { clientX: 30, clientY: 40 });
        fireEvent.click(cardNode, { clientX: 31, clientY: 41 });
        expect(props.setContextMenu).toHaveBeenCalledWith({
            visible: true,
            x: 31,
            y: 41,
            cardUuid: "card-1",
        });
        vi.advanceTimersByTime(300);
        expect(artworkState.openModal).not.toHaveBeenCalled();
    });

    it("covers mobile selected rendering, ignored mobile context menus, and missing scroll refs", () => {
        selectionState.selectedCards = new Set(["card-1"]);
        const missingScrollRef = { current: null };
        const setContextMenu = vi.fn();

        const { cardNode } = renderOverlay({
            mobile: true,
            scrollContainerRef: missingScrollRef,
            setContextMenu,
        });

        expect(screen.getByTitle("Select card").querySelector("svg")).toBeInTheDocument();

        fireEvent.contextMenu(cardNode, { clientX: 1, clientY: 2 });
        expect(setContextMenu).not.toHaveBeenCalled();
    });
});
