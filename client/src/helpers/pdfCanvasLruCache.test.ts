import { describe, expect, test } from "vitest";
import { CanvasLruCache, rgba8CanvasBytes } from "./pdfCanvasLruCache";

type FakeCanvas = {
  width: number;
  height: number;
  disposed: number;
};

function canvas(width: number, height: number): FakeCanvas {
  return { width, height, disposed: 0 };
}

function disposeCanvas(value: FakeCanvas): void {
  value.disposed += 1;
  value.width = 0;
  value.height = 0;
}

describe("CanvasLruCache", () => {
  test("evicts the least recently used unpinned canvas to admit an over-budget canvas", () => {
    const cache = new CanvasLruCache<FakeCanvas>(80, disposeCanvas);
    const first = canvas(2, 5); // 40 RGBA8 bytes
    const second = canvas(2, 5); // 40 RGBA8 bytes
    const replacement = canvas(2, 5); // 40 RGBA8 bytes

    cache.admit("first", first)?.release();
    cache.admit("second", second)?.release();
    cache.acquire("first")?.release(); // first is most recently used
    cache.admit("replacement", replacement)?.release();

    expect(cache.keys()).toEqual(["first", "replacement"]);
    expect(cache.bytes).toBe(80);
    expect(second.disposed).toBe(1);
    expect(second.width).toBe(0);
    expect(second.height).toBe(0);
  });

  test("keeps pinned canvases alive until release then evicts them under the current budget", () => {
    const cache = new CanvasLruCache<FakeCanvas>(80, disposeCanvas);
    const active = canvas(2, 5);
    const inactive = canvas(2, 5);
    const activeLease = cache.admit("active", active)!;
    cache.admit("inactive", inactive)?.release();

    cache.setByteBudget(40);
    expect(cache.keys()).toEqual(["active"]);
    expect(active.disposed).toBe(0);
    expect(inactive.disposed).toBe(1);

    cache.setByteBudget(0);
    expect(active.disposed).toBe(0);
    activeLease.release();
    activeLease.release();

    expect(cache.keys()).toEqual([]);
    expect(cache.bytes).toBe(0);
    expect(active.disposed).toBe(1);
  });

  test("does not cache an oversized canvas while leaving its active surface usable", () => {
    const cache = new CanvasLruCache<FakeCanvas>(40, disposeCanvas);
    const oversized = canvas(4, 4); // 64 RGBA8 bytes

    expect(cache.admit("oversized", oversized)).toBeUndefined();
    expect(cache.keys()).toEqual([]);
    expect(cache.bytes).toBe(0);
    expect(oversized).toMatchObject({ width: 4, height: 4, disposed: 0 });
  });

  test("accounts for zero dimensions and rejects unsafe byte products without disposal", () => {
    const cache = new CanvasLruCache<FakeCanvas>(0, disposeCanvas);
    const zero = canvas(0, 10);
    const zeroLease = cache.admit("zero", zero)!;

    expect(rgba8CanvasBytes(0, 10)).toBe(0);
    expect(rgba8CanvasBytes(Number.MAX_SAFE_INTEGER, 2)).toBeUndefined();
    zeroLease.release();
    cache.clear();
    cache.clear();

    expect(zero.disposed).toBe(1);
    expect(cache.bytes).toBe(0);
  });
});
