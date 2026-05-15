/**
 * PageControlsOverlay - per-page actions for PixiJS-rendered pages.
 *
 * Renders HTML controls anchored to each page so users can select or delete the
 * cards on that page without relying on global selection controls.
 */

import { memo, useCallback, useEffect, useRef, type RefObject } from "react";
import { CheckSquare, Trash2 } from "lucide-react";
import { undoableDeleteCardsBatch } from "@/helpers/undoableActions";
import { useSelectionStore } from "@/store/selection";

export interface PageControlLayout {
    pageIndex: number;
    screenX: number;
    screenY: number;
    width: number;
    height: number;
    cardUuids: string[];
}

interface PageControlsOverlayProps {
    pageLayouts: PageControlLayout[];
    containerWidth: number;
    containerHeight: number;
    scrollContainerRef: RefObject<HTMLDivElement | null>;
    mobile?: boolean;
}

const PageControl = memo(function PageControl({
    pageIndex,
    screenX,
    screenY,
    width,
    cardUuids,
    mobile,
}: PageControlLayout & { mobile?: boolean }) {
    const selectedCards = useSelectionStore((state) => state.selectedCards);
    const selectCards = useSelectionStore((state) => state.selectCards);
    const clearSelection = useSelectionStore((state) => state.clearSelection);
    const pageNumber = pageIndex + 1;
    const hasCards = cardUuids.length > 0;
    const isPageSelected = hasCards && cardUuids.every((uuid) => selectedCards.has(uuid));

    const handleSelectPage = useCallback(() => {
        selectCards(cardUuids);
    }, [cardUuids, selectCards]);

    const handleDeletePage = useCallback(async () => {
        await undoableDeleteCardsBatch(cardUuids);
        clearSelection();
    }, [cardUuids, clearSelection]);

    return (
        <div
            data-testid={`page-controls-${pageIndex}`}
            className="absolute z-30 flex overflow-hidden rounded-lg border border-gray-300 bg-white/95 text-gray-700 shadow-lg backdrop-blur-sm dark:border-gray-600 dark:bg-gray-800/95 dark:text-gray-200"
            style={{
                left: screenX + width - 8,
                top: screenY + 8,
                transform: "translateX(-100%)",
                pointerEvents: "auto",
            }}
        >
            <span className="flex items-center border-r border-gray-300 px-2 text-xs font-semibold dark:border-gray-600">
                Page {pageNumber}
            </span>
            <button
                type="button"
                data-testid={`page-select-all-${pageIndex}`}
                aria-label={`Select all cards on page ${pageNumber}`}
                title={isPageSelected ? `Page ${pageNumber} selected` : `Select all cards on page ${pageNumber}`}
                disabled={!hasCards || isPageSelected}
                onClick={handleSelectPage}
                className="flex items-center gap-1 border-r border-gray-300 px-2 py-2 text-xs font-medium transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700"
            >
                <CheckSquare className="size-4" />
                <span className={mobile ? "sr-only" : undefined}>
                    {isPageSelected ? "Selected" : "Select Page"}
                </span>
            </button>
            <button
                type="button"
                data-testid={`page-delete-${pageIndex}`}
                aria-label={`Delete page ${pageNumber}`}
                title={`Delete page ${pageNumber}`}
                disabled={!hasCards}
                onClick={handleDeletePage}
                className="flex items-center gap-1 px-2 py-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40"
            >
                <Trash2 className="size-4" />
                <span className={mobile ? "sr-only" : undefined}>Delete Page</span>
            </button>
        </div>
    );
});

/**
 * PageControlsOverlay - Container for all per-page controls.
 * It uses the same direct scroll sync strategy as CardControlsOverlay so the
 * controls stay visually attached to their page while the sticky canvas scrolls.
 */
export const PageControlsOverlay = memo(function PageControlsOverlay({
    pageLayouts,
    containerWidth,
    containerHeight,
    scrollContainerRef,
    mobile,
}: PageControlsOverlayProps) {
    const innerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const scrollContainer = scrollContainerRef.current;
        const inner = innerRef.current;
        if (!scrollContainer || !inner) return;

        const handleScroll = () => {
            inner.style.transform = `translateY(${-scrollContainer.scrollTop}px)`;
        };

        handleScroll();

        scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
        return () => scrollContainer.removeEventListener("scroll", handleScroll);
    }, [scrollContainerRef]);

    return (
        <div
            className="absolute left-0 top-0 overflow-hidden pointer-events-none"
            style={{
                width: containerWidth,
                height: containerHeight,
            }}
        >
            <div ref={innerRef}>
                {pageLayouts.map((layout) => (
                    <PageControl key={layout.pageIndex} {...layout} mobile={mobile} />
                ))}
            </div>
        </div>
    );
});

export default PageControlsOverlay;
