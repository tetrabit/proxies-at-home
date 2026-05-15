import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useZoomShortcuts } from "./useZoomShortcuts";

describe("useZoomShortcuts", () => {
  it("handles keyboard and wheel zoom shortcuts on a custom target", () => {
    let zoom = 1;
    const setZoom = vi.fn((next) => {
      zoom = typeof next === "function" ? next(zoom) : next;
    });
    const target = document.createElement("div");
    const { unmount } = renderHook(() =>
      useZoomShortcuts({
        setZoom,
        isOpen: true,
        minZoom: 0.5,
        maxZoom: 2,
        step: 0.5,
        targetRef: { current: target },
      })
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", ctrlKey: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "-", metaKey: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", ctrlKey: true }));
      target.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true }));
    });

    expect(setZoom).toHaveBeenCalledTimes(4);
    expect(zoom).toBe(1);
    unmount();
  });

  it("attaches wheel shortcuts to window when no targetRef is provided", () => {
    const setZoom = vi.fn();
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() =>
      useZoomShortcuts({
        setZoom,
        isOpen: true,
      })
    );

    expect(addSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith("wheel", expect.any(Function), { passive: false });

    unmount();

    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("wheel", expect.any(Function));
  });

  it("does nothing when the shortcuts panel is closed", () => {
    const setZoom = vi.fn();
    renderHook(() =>
      useZoomShortcuts({
        setZoom,
        isOpen: false,
      })
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", ctrlKey: true }));
      window.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true }));
    });

    expect(setZoom).not.toHaveBeenCalled();
  });
});
