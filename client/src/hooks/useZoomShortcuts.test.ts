import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useZoomShortcuts } from "./useZoomShortcuts";

describe("useZoomShortcuts", () => {
  it("handles keyboard and wheel zoom shortcuts", () => {
    const setZoom = vi.fn();
    const target = document.createElement("div");
    const { unmount } = renderHook(() =>
      useZoomShortcuts({
        setZoom,
        isOpen: true,
        minZoom: 0.1,
        maxZoom: 5,
        step: 0.5,
        targetRef: { current: target },
      })
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", ctrlKey: true }));
      target.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true }));
    });

    expect(setZoom).toHaveBeenCalled();
    unmount();
  });
});
