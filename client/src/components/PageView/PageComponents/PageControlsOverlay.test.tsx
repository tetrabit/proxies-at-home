import type { ComponentProps } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const selectionState = vi.hoisted(() => ({
    selectedCards: new Set<string>(),
    selectCards: vi.fn(),
    clearSelection: vi.fn(),
}));

const actionMocks = vi.hoisted(() => ({
    undoableDeleteCardsBatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/store/selection", () => ({
    useSelectionStore: (selector: (state: typeof selectionState) => unknown) => selector(selectionState),
}));

vi.mock("@/helpers/undoableActions", () => ({
    undoableDeleteCardsBatch: (...args: unknown[]) => actionMocks.undoableDeleteCardsBatch(...args),
}));

import { PageControlsOverlay, type PageControlLayout } from "./PageControlsOverlay";

const pageLayouts: PageControlLayout[] = [
    {
        pageIndex: 0,
        screenX: 0,
        screenY: 20,
        width: 300,
        height: 420,
        cardUuids: ["card-1", "card-2"],
    },
    {
        pageIndex: 1,
        screenX: 0,
        screenY: 460,
        width: 300,
        height: 420,
        cardUuids: ["card-3"],
    },
];

function renderOverlay(
    overrides: Partial<ComponentProps<typeof PageControlsOverlay>> = {},
) {
    const scrollContainer = document.createElement("div");
    const scrollContainerRef = { current: scrollContainer };
    const props: ComponentProps<typeof PageControlsOverlay> = {
        pageLayouts,
        containerWidth: 300,
        containerHeight: 240,
        scrollContainerRef,
        ...overrides,
    };

    const result = render(<PageControlsOverlay {...props} />);
    return { ...result, props, scrollContainer };
}

describe("PageControlsOverlay", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        selectionState.selectedCards = new Set<string>();
        actionMocks.undoableDeleteCardsBatch.mockResolvedValue(undefined);
    });

    it("renders page controls anchored to every page and syncs scroll", () => {
        const { container, scrollContainer } = renderOverlay();

        expect(screen.getByTestId("page-controls-0")).toHaveStyle({
            left: "292px",
            top: "28px",
            transform: "translateX(-100%)",
        });
        expect(screen.getByText("Page 1")).toBeInTheDocument();
        expect(screen.getByText("Page 2")).toBeInTheDocument();

        scrollContainer.scrollTop = 75;
        fireEvent.scroll(scrollContainer);
        const inner = container.querySelector(".overflow-hidden > div") as HTMLElement;
        expect(inner.style.transform).toBe("translateY(-75px)");
    });

    it("selects all cards on a page without clearing other selected pages", () => {
        renderOverlay();

        fireEvent.click(screen.getByTestId("page-select-all-0"));
        expect(selectionState.selectCards).toHaveBeenCalledWith(["card-1", "card-2"]);
        expect(selectionState.clearSelection).not.toHaveBeenCalled();
    });

    it("deletes all cards on a page as one undoable action and clears selection", async () => {
        renderOverlay();

        fireEvent.click(screen.getByTestId("page-delete-1"));

        await waitFor(() => {
            expect(actionMocks.undoableDeleteCardsBatch).toHaveBeenCalledWith(["card-3"]);
        });
        expect(selectionState.clearSelection).toHaveBeenCalled();
    });

    it("disables empty and already-selected page actions while preserving mobile labels", () => {
        selectionState.selectedCards = new Set(["card-1", "card-2"]);
        renderOverlay({
            mobile: true,
            pageLayouts: [
                pageLayouts[0],
                { ...pageLayouts[1], cardUuids: [] },
            ],
        });

        expect(screen.getByTestId("page-select-all-0")).toBeDisabled();
        expect(screen.getByTestId("page-select-all-0")).toHaveTextContent("Selected");
        expect(screen.getByTestId("page-select-all-0").querySelector("span")).toHaveClass("sr-only");
        expect(screen.getByTestId("page-select-all-1")).toBeDisabled();
        expect(screen.getByTestId("page-delete-1")).toBeDisabled();
    });

    it("renders without a scroll container ref", () => {
        const { container } = renderOverlay({ scrollContainerRef: { current: null } });

        expect(screen.getByTestId("page-controls-0")).toBeInTheDocument();
        const inner = container.querySelector(".overflow-hidden > div") as HTMLElement;
        expect(inner.style.transform).toBe("");
    });
});
