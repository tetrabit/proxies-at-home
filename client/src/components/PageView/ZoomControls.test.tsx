import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { ZoomControls } from "./ZoomControls";
import { useSettingsStore } from "@/store/settings";

// Mock the store
vi.mock("@/store/settings", () => ({
    useSettingsStore: vi.fn(),
}));

describe("ZoomControls", () => {
    afterEach(() => {
        vi.useRealTimers();
    });
    it("should reset zoom on double click (desktop)", () => {
        const setZoom = vi.fn();
        (useSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => selector({
            zoom: 1.5,
            setZoom,
        }));

        render(<ZoomControls />);
        const slider = screen.getByRole("slider");

        fireEvent.doubleClick(slider);
        expect(setZoom).toHaveBeenCalledWith(1.0);
    });

    it("should reset zoom on double tap (mobile)", () => {
        const setZoom = vi.fn();
        (useSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => selector({
            zoom: 1.5,
            setZoom,
        }));

        render(<ZoomControls />);
        const slider = screen.getByRole("slider");

        // First tap
        fireEvent.touchStart(slider);

        // Second tap within 300ms
        fireEvent.touchStart(slider);

        expect(setZoom).toHaveBeenCalledWith(1.0);
    });

    it("should not reset zoom on single tap", () => {
        const setZoom = vi.fn();
        (useSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => selector({
            zoom: 1.5,
            setZoom,
        }));

        render(<ZoomControls />);
        const slider = screen.getByRole("slider");

        // Single tap
        fireEvent.touchStart(slider);

        expect(setZoom).not.toHaveBeenCalled();
    });

    it("should not reset zoom on slow double tap", async () => {
        const setZoom = vi.fn();
        (useSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => selector({
            zoom: 1.5,
            setZoom,
        }));

        render(<ZoomControls />);
        const slider = screen.getByRole("slider");

        // Mock Date.now
        const realDateNow = Date.now;
        let currentTime = 1000;
        global.Date.now = () => currentTime;

        // First tap
        fireEvent.touchStart(slider);

        // Advance time > 300ms
        currentTime += 350;

        // Second tap
        fireEvent.touchStart(slider);

        expect(setZoom).not.toHaveBeenCalled();

        // Restore Date.now
        global.Date.now = realDateNow;
    });

    it("should zoom out when zoom out button clicked", () => {
        const setZoom = vi.fn();
        (useSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => selector({
            zoom: 1.5,
            setZoom,
        }));

        render(<ZoomControls />);
        const buttons = screen.getAllByRole("button");
        const zoomOutButton = buttons[0]; // First button is zoom out

        fireEvent.click(zoomOutButton);
        expect(setZoom).toHaveBeenCalledWith(1.4);
    });

    it("should zoom in when zoom in button clicked", () => {
        const setZoom = vi.fn();
        (useSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => selector({
            zoom: 1.5,
            setZoom,
        }));

        render(<ZoomControls />);
        const buttons = screen.getAllByRole("button");
        const zoomInButton = buttons[1]; // Second button is zoom in

        fireEvent.click(zoomInButton);
        expect(setZoom).toHaveBeenCalledWith(1.6);
    });

    it("should change zoom on slider change", () => {
        const setZoom = vi.fn();
        (useSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => selector({
            zoom: 1.0,
            setZoom,
        }));

        render(<ZoomControls />);
        const slider = screen.getByRole("slider");

        fireEvent.change(slider, { target: { value: "75" } });
        expect(setZoom).toHaveBeenCalled();
    });



    it("should map low slider values through the lower zoom range before snapping", () => {
        const setZoom = vi.fn();
        (useSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => selector({
            zoom: 1.0,
            setZoom,
        }));

        render(<ZoomControls />);
        fireEvent.change(screen.getByRole("slider"), { target: { value: "25" } });

        expect(setZoom).toHaveBeenCalledWith(expect.any(Number));
    });

    it("should map high slider values through the upper zoom range", () => {
        const setZoom = vi.fn();
        (useSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => selector({
            zoom: 1.0,
            setZoom,
        }));

        render(<ZoomControls />);
        fireEvent.change(screen.getByRole("slider"), { target: { value: "97" } });

        expect(setZoom).toHaveBeenCalledWith(4.76);
    });

    it("should ignore the slider change emitted by a double tap reset", () => {
        vi.useFakeTimers();
        const setZoom = vi.fn();
        (useSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => selector({
            zoom: 1.5,
            setZoom,
        }));

        render(<ZoomControls />);
        const slider = screen.getByRole("slider");

        fireEvent.touchStart(slider);
        fireEvent.touchStart(slider);
        fireEvent.change(slider, { target: { value: "90" } });
        expect(setZoom).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(200);
        fireEvent.change(slider, { target: { value: "90" } });
        expect(setZoom).toHaveBeenCalledTimes(2);
    });

    it("should render compact mode", () => {
        const setZoom = vi.fn();
        (useSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => selector({
            zoom: 1.0,
            setZoom,
        }));

        render(<ZoomControls compact={true} />);
        // Compact mode now includes slider (but uses xs button size)
        expect(screen.getByRole("slider")).toBeDefined();
        // Still has buttons
        expect(screen.getAllByRole("button").length).toBe(2);
    });

    it("should use controlled mode when zoom and onZoomChange are provided", () => {
        const onZoomChange = vi.fn();
        (useSettingsStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => selector({
            zoom: 1.0,
            setZoom: vi.fn(),
        }));

        render(<ZoomControls zoom={2.0} onZoomChange={onZoomChange} />);
        expect(screen.getByText("2.0x")).toBeDefined();

        const buttons = screen.getAllByRole("button");
        fireEvent.click(buttons[1]); // Zoom in
        expect(onZoomChange).toHaveBeenCalled();
    });
});

