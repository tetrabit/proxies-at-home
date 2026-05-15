import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePageViewZoom } from "./usePageViewZoom";

const mockPinch = vi.hoisted(() => vi.fn());
const mockDrag = vi.hoisted(() => vi.fn());

vi.mock("@use-gesture/react", () => ({
  usePinch: mockPinch,
  useDrag: mockDrag,
}));

describe("usePageViewZoom", () => {
  beforeEach(() => {
    mockPinch.mockReset();
    mockDrag.mockReset();
  });

  it("centers desktop view and wires pinch/drag handlers", async () => {
    const setZoom = vi.fn();
    let pinchHandler: Parameters<typeof mockPinch>[0] | undefined;
    let dragHandler: Parameters<typeof mockDrag>[0] | undefined;
    mockPinch.mockImplementation((handler) => {
      pinchHandler = handler;
    });
    mockDrag.mockImplementation((handler) => {
      dragHandler = handler;
    });

    const { result } = renderHook(() =>
      usePageViewZoom({
        zoom: 1,
        setZoom,
        active: true,
        mobile: false,
        pageWidth: 200,
        pageHeight: 300,
      })
    );

    const el = document.createElement("div");
    Object.defineProperties(el, {
      clientWidth: { value: 100, configurable: true },
      clientHeight: { value: 80, configurable: true },
      scrollWidth: { value: 500, configurable: true },
      scrollHeight: { value: 400, configurable: true },
      scrollLeft: { value: 0, writable: true, configurable: true },
      scrollTop: { value: 0, writable: true, configurable: true },
      scrollTo: { value: vi.fn(), configurable: true },
    });

    result.current.scrollContainerRef.current = el as HTMLDivElement;
    act(() => {
      result.current.updateCenterOffset();
    });

    expect(result.current.scrollContainerRef.current).toBe(el);
    expect(mockPinch).toHaveBeenCalled();
    expect(mockDrag).toHaveBeenCalled();
    expect(typeof pinchHandler).toBe("function");
    expect(typeof dragHandler).toBe("function");
  });
});
