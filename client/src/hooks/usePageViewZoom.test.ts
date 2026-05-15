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
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
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

  it("applies mobile fallback and pinch movement branches", () => {
    const setZoom = vi.fn();
    let pinchHandler: Parameters<typeof mockPinch>[0] | undefined;
    mockPinch.mockImplementation((handler) => {
      pinchHandler = handler;
    });
    mockDrag.mockImplementation(() => {});

    const { result, rerender } = renderHook(
      ({ zoom }) =>
        usePageViewZoom({
          zoom,
          setZoom,
          active: true,
          mobile: true,
          pageWidth: 200,
          pageHeight: 300,
        }),
      { initialProps: { zoom: 1 } }
    );

    const el = document.createElement("div");
    Object.defineProperties(el, {
      clientWidth: { value: 200, configurable: true },
      clientHeight: { value: 100, configurable: true },
      scrollWidth: { value: 600, configurable: true },
      scrollHeight: { value: 400, configurable: true },
      scrollLeft: { value: 10, writable: true, configurable: true },
      scrollTop: { value: 20, writable: true, configurable: true },
      getBoundingClientRect: {
        value: () => ({ left: 5, top: 7 }),
        configurable: true,
      },
    });
    result.current.scrollContainerRef.current = el as HTMLDivElement;

    act(() => {
      pinchHandler?.({
        offset: [2],
        origin: [45, 57],
        first: true,
        last: false,
        event: new Event("touchmove"),
      } as never);
    });
    expect(setZoom).toHaveBeenCalledWith(2);
    expect(result.current.isPinching).toBe(true);

    rerender({ zoom: 2 });
    expect((el as HTMLDivElement).scrollLeft).toBeGreaterThan(10);
    expect((el as HTMLDivElement).scrollTop).toBeGreaterThan(20);

    act(() => {
      pinchHandler?.({
        offset: [2.5],
        origin: [45, 57],
        first: false,
        last: true,
        event: new Event("touchmove"),
      } as never);
    });
    expect(setZoom).toHaveBeenLastCalledWith(2.5);
  });

  it("ignores keyboard drag events and updates zoom on shift-drag", () => {
    const setZoom = vi.fn();
    let dragHandler: Parameters<typeof mockDrag>[0] | undefined;
    mockPinch.mockImplementation(() => {});
    mockDrag.mockImplementation((handler) => {
      dragHandler = handler;
    });

    renderHook(() =>
      usePageViewZoom({
        zoom: 1,
        setZoom,
        active: true,
        mobile: false,
        pageWidth: 200,
        pageHeight: 300,
      })
    );

    const keyEvent = new Event("keydown");
    expect(
      dragHandler?.({
        movement: [0, 100],
        shiftKey: true,
        first: true,
        last: false,
        memo: 1,
        event: keyEvent,
      } as never)
    ).toBe(1);
    expect(setZoom).not.toHaveBeenCalled();

    act(() => {
      dragHandler?.({
        movement: [0, 120],
        shiftKey: true,
        first: true,
        last: true,
        memo: 1,
        event: new PointerEvent("pointermove"),
      } as never);
    });
    expect(setZoom).toHaveBeenCalledWith(0.1);
  });
});
