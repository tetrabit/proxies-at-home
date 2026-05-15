import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { PageViewFloatingControls } from "./PageViewFloatingControls";
import { usePageViewSettings } from "@/hooks/usePageViewSettings";
import { useCardEditorModalStore } from "@/store";

// Mock dependencies
vi.mock("@/hooks/usePageViewSettings", () => ({
    usePageViewSettings: vi.fn(),
}));

vi.mock("@/store", () => ({
    useCardEditorModalStore: vi.fn(),
}));

vi.mock("../ZoomControls", () => ({
    ZoomControls: () => <div data-testid="zoom-controls">ZoomControls</div>,
}));

vi.mock("../UndoRedoControls", () => ({
    UndoRedoControls: () => <div data-testid="undo-redo-controls">UndoRedoControls</div>,
}));

vi.mock("@/hooks/useOnClickOutside", () => ({
    useOnClickOutside: (_ref: unknown, handler: () => void) => {
        (window as unknown as { __outsideHandler?: () => void }).__outsideHandler = handler;
    },
}));

describe("PageViewFloatingControls", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        // Default mocks
        vi.mocked(usePageViewSettings).mockReturnValue({
            settingsPanelWidth: 300,
            isSettingsPanelCollapsed: false,
            uploadPanelWidth: 300,
            isUploadPanelCollapsed: false,
        });

        vi.mocked(useCardEditorModalStore).mockImplementation((selector: (state: { open: boolean }) => unknown) => selector({
            open: false,
        }));
    });

    describe("common visibility logic", () => {
        it("should return null if hasCards is false", () => {
            render(<PageViewFloatingControls hasCards={false} mobile={false} />);
            expect(screen.queryByTestId("zoom-controls")).toBeNull();
            expect(screen.queryByTestId("undo-redo-controls")).toBeNull();
        });

        it("should return null if card editor is open", () => {
            vi.mocked(useCardEditorModalStore).mockImplementation((selector: (state: { open: boolean }) => unknown) => selector({
                open: true,
            }));
            render(<PageViewFloatingControls hasCards={true} mobile={false} />);
            expect(screen.queryByTestId("zoom-controls")).toBeNull();
        });
    });

    describe("desktop view", () => {
        it("should render zoom and undo/redo controls", () => {
            render(<PageViewFloatingControls hasCards={true} mobile={false} />);
            expect(screen.getByTestId("zoom-controls")).toBeDefined();
            expect(screen.getByTestId("undo-redo-controls")).toBeDefined();
        });

        it("should not render the MPC calibration launcher as a floating control", () => {
            render(<PageViewFloatingControls hasCards={true} mobile={false} />);
            expect(screen.queryByTestId("open-mpc-calibration-floating")).toBeNull();
            expect(screen.queryByLabelText("Open MPC Calibration Harness")).toBeNull();
        });

        it("should position based on panel state (expanded)", () => {
            const { container } = render(<PageViewFloatingControls hasCards={true} mobile={false} />);
            // We can check if the style attribute is applied correctly, 
            // though checking exact pixels usually requires computed style which jsdom mocks.
            // Just verifying it renders is good for functionality.
            expect(container.innerHTML).toContain("right: 320px"); // 300 + 20
        });

        it("should position based on panel state (collapsed)", () => {
            vi.mocked(usePageViewSettings).mockReturnValue({
                settingsPanelWidth: 300,
                isSettingsPanelCollapsed: true,
                uploadPanelWidth: 300,
                isUploadPanelCollapsed: true,
            });
            const { container } = render(<PageViewFloatingControls hasCards={true} mobile={false} />);
            expect(container.innerHTML).toContain("right: 80px"); // 60 + 20
        });
    });

    describe("mobile view", () => {
        it("should render mobile controls", () => {
            render(<PageViewFloatingControls hasCards={true} mobile={true} />);
            // Mobile initially hides ZoomControls, but shows toggle button
            expect(screen.queryByTestId("zoom-controls")).toBeNull();
            // Undo redo is visible
            expect(screen.getByTestId("undo-redo-controls")).toBeDefined();
            // Toggle button exists
            expect(screen.getByRole("button")).toBeDefined();
        });

        it("should toggle zoom controls on button click", () => {
            render(<PageViewFloatingControls hasCards={true} mobile={true} />);

            const toggleBtn = screen.getByRole("button");
            fireEvent.click(toggleBtn);

            expect(screen.getByTestId("zoom-controls")).toBeDefined();

            fireEvent.click(toggleBtn);
            expect(screen.queryByTestId("zoom-controls")).toBeNull();
        });

        it("should close zoom controls when clicking outside", async () => {
            const addEventListenerSpy = vi.spyOn(window, "addEventListener");
            render(<PageViewFloatingControls hasCards={true} mobile={true} />);

            // Open it
            fireEvent.click(screen.getByRole("button"));
            expect(screen.getByTestId("zoom-controls")).toBeDefined();

            const clickHandler = addEventListenerSpy.mock.calls.find(([type]) => type === "click")?.[1];
            expect(clickHandler).toBeTypeOf("function");

            const event = new MouseEvent("click", { bubbles: true, cancelable: true });
            Object.defineProperty(event, "target", { value: document.body });

            await act(async () => {
                (clickHandler as EventListener)(event);
            });
            expect(screen.queryByTestId("zoom-controls")).toBeNull();
            addEventListenerSpy.mockRestore();
        });

        it("should close zoom controls via useOnClickOutside", () => {
            render(<PageViewFloatingControls hasCards={true} mobile={true} />);

            // Outside click while collapsed should be ignored by the showMobileZoomControls guard.
            fireEvent.click(document.body);
            expect(screen.queryByTestId("zoom-controls")).toBeNull();

            fireEvent.click(screen.getByRole("button"));
            expect(screen.getByTestId("zoom-controls")).toBeDefined();

            act(() => {
                (window as unknown as { __outsideHandler?: () => void }).__outsideHandler?.();
            });

            expect(screen.queryByTestId("zoom-controls")).toBeNull();
        });

    });
});
