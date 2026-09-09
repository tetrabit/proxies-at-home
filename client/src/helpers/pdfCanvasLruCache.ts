export interface CanvasLike {
  width: number;
  height: number;
}

export interface CanvasCacheLease<T extends CanvasLike> {
  readonly canvas: T;
  release(): void;
}

interface CachedCanvas<T extends CanvasLike> {
  canvas: T;
  bytes: number;
  pins: number;
  disposed: boolean;
}

/**
 * Bounds worker-owned CPU RGBA8 canvases. Browser/driver/GPU allocations are
 * intentionally not measured or reserved here.
 */
export class CanvasLruCache<T extends CanvasLike> {
  private readonly entries = new Map<string, CachedCanvas<T>>();
  private byteCount = 0;

  private byteBudget: number;
  private readonly disposeCanvas: (canvas: T) => void;

  constructor(byteBudget: number, disposeCanvas: (canvas: T) => void) {
    this.byteBudget = byteBudget;
    this.disposeCanvas = disposeCanvas;
  }

  get bytes(): number {
    return this.byteCount;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  acquire(key: string): CanvasCacheLease<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    this.touch(key, entry);
    entry.pins += 1;
    return this.lease(entry);
  }

  admit(key: string, canvas: T): CanvasCacheLease<T> | undefined {
    const bytes = rgba8CanvasBytes(canvas.width, canvas.height);
    if (bytes === undefined || bytes > this.byteBudget) return undefined;

    const existing = this.entries.get(key);
    if (existing) {
      if (existing.canvas === canvas) {
        return this.acquire(key);
      }
      if (existing.pins > 0) return undefined;
      this.remove(key, existing);
    }

    this.evictToBudget(bytes);
    if (this.byteCount + bytes > this.byteBudget) return undefined;

    const entry: CachedCanvas<T> = { canvas, bytes, pins: 1, disposed: false };
    this.entries.set(key, entry);
    this.byteCount += bytes;
    return this.lease(entry);
  }

  setByteBudget(byteBudget: number): void {
    this.byteBudget = Math.max(0, Number.isSafeInteger(byteBudget) ? byteBudget : 0);
    this.evictToBudget();
  }

  clear(): void {
    for (const [key, entry] of this.entries) {
      if (entry.pins === 0) this.remove(key, entry);
    }
  }

  private lease(entry: CachedCanvas<T>): CanvasCacheLease<T> {
    let released = false;
    return {
      canvas: entry.canvas,
      release: () => {
        if (released) return;
        released = true;
        entry.pins -= 1;
        if (entry.pins < 0) entry.pins = 0;
        this.evictToBudget();
      },
    };
  }

  private touch(key: string, entry: CachedCanvas<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evictToBudget(additionalBytes = 0): void {
    for (const [key, entry] of this.entries) {
      if (this.byteCount + additionalBytes <= this.byteBudget) break;
      if (entry.pins === 0) this.remove(key, entry);
    }
  }

  private remove(key: string, entry: CachedCanvas<T>): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    this.byteCount -= entry.bytes;
    if (!entry.disposed) {
      entry.disposed = true;
      this.disposeCanvas(entry.canvas);
    }
  }
}

export function rgba8CanvasBytes(width: number, height: number): number | undefined {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0) {
    return undefined;
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels)) return undefined;
  const bytes = pixels * 4;
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}
