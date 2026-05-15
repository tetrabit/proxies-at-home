import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./webgl/webglUtils", () => ({
  createShader: vi.fn((_gl, type: number) => ({ kind: "shader", type })),
  createProgram: vi.fn((_gl, _vs, fs) => ({ kind: "program", fs })),
  createTexture: vi.fn((_gl, width: number, height: number) => ({
    kind: "texture",
    width,
    height,
  })),
  createFramebuffer: vi.fn((_gl, texture) => ({
    kind: "framebuffer",
    texture,
  })),
  createQuadBuffer: vi.fn(() => ({ kind: "buffer" })),
}));

import {
  __webglImageProcessingTestInternals,
  deriveSourceBleedPixelsFromGeometry,
  generateBleedCanvasWebGL,
  getCardPixelDimensionsForBleed,
  processCardImageWebGL,
  processExistingBleedWebGL,
  renderBleedCanvasDirect,
} from "./webglImageProcessing";
import { getBleedInPixels } from "./imageProcessing";

describe("getCardPixelDimensionsForBleed", () => {
  it("clamps negative bleed while deriving fixed physical dimensions from bleed and DPI", () => {
    expect(getCardPixelDimensionsForBleed(-5, 300)).toMatchObject({
      width: 744,
      height: 1039,
      bleedPx: 0,
    });

    expect(getCardPixelDimensionsForBleed(0, 300)).toMatchObject({
      width: 744,
      height: 1039,
      bleedPx: 0,
    });

    expect(getCardPixelDimensionsForBleed(3.175, 1200)).toMatchObject({
      width: 3276,
      height: 4457,
      bleedPx: 150,
    });
  });
});

describe("deriveSourceBleedPixelsFromGeometry", () => {
  it("returns zero bleed pixels when no usable input bleed is provided", () => {
    expect(deriveSourceBleedPixelsFromGeometry(1000, 1400, 0)).toEqual({
      bleedPxX: 0,
      bleedPxY: 0,
    });
    expect(deriveSourceBleedPixelsFromGeometry(1000, 1400, -1)).toEqual({
      bleedPxX: 0,
      bleedPxY: 0,
    });
  });

  it("derives source bleed pixels from bitmap geometry instead of export dpi", () => {
    const result = deriveSourceBleedPixelsFromGeometry(694, 944, 3.175);
    const oldDpiBasedBleedPx = Math.round(getBleedInPixels(3.175, "mm", 1200));

    expect(result).toEqual({
      bleedPxX: 32,
      bleedPxY: 32,
    });
    expect(result.bleedPxX).not.toBe(oldDpiBasedBleedPx);
    expect(result.bleedPxY).not.toBe(oldDpiBasedBleedPx);
  });

  it("keeps inner content dimensions close to card content geometry", () => {
    const widthPx = 694;
    const heightPx = 944;
    const bleed = deriveSourceBleedPixelsFromGeometry(widthPx, heightPx, 3.175);

    const contentWidth = widthPx - bleed.bleedPxX * 2;
    const contentHeight = heightPx - bleed.bleedPxY * 2;
    const actualAspect = contentWidth / contentHeight;
    const expectedAspect = 63 / 88;

    expect(actualAspect).toBeCloseTo(expectedAspect, 2);
  });
});

describe("webglImageProcessing test internals", () => {
  const makeGl = () => {
    const calls: string[] = [];
    return {
      calls,
      VERTEX_SHADER: 1,
      FRAGMENT_SHADER: 2,
      FRAMEBUFFER: 3,
      TEXTURE0: 10,
      TEXTURE1: 11,
      TEXTURE_2D: 12,
      TRIANGLES: 13,
      ARRAY_BUFFER: 14,
      FLOAT: 15,
      COLOR_BUFFER_BIT: 16,
      TEXTURE_MIN_FILTER: 17,
      TEXTURE_MAG_FILTER: 18,
      LINEAR: 19,
      RG32F: 20,
      RG: 21,
      isContextLost: vi.fn(() => false),
      viewport: vi.fn((...args: unknown[]) =>
        calls.push(`viewport:${args.join(",")}`)
      ),
      getExtension: vi.fn(() => ({ loseContext: vi.fn() })),
      deleteShader: vi.fn(),
      useProgram: vi.fn(),
      uniform2f: vi.fn(),
      getUniformLocation: vi.fn((_program, name: string) => ({ name })),
      uniform1i: vi.fn(),
      uniform1f: vi.fn(),
      bindFramebuffer: vi.fn(),
      activeTexture: vi.fn(),
      bindTexture: vi.fn(),
      drawArrays: vi.fn(),
      bindBuffer: vi.fn(),
      enableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      clearColor: vi.fn(),
      clear: vi.fn(),
      texParameteri: vi.fn(),
      deleteTexture: vi.fn(),
      deleteFramebuffer: vi.fn(),
      deleteProgram: vi.fn(),
      deleteBuffer: vi.fn(),
    } as unknown as WebGL2RenderingContext & { calls: string[] };
  };

  class MockOffscreenCanvas {
    width: number;
    height: number;
    listeners: Record<string, (event: { preventDefault(): void }) => void> = {};
    gl = makeGl();

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }

    getContext(kind: string) {
      if (kind === "webgl2") return this.gl;
      if (kind === "2d") {
        return {
          imageSmoothingQuality: "low",
          drawImage: vi.fn(),
          getImageData: vi.fn(() => ({
            data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]),
          })),
        };
      }
      return null;
    }

    addEventListener(
      type: string,
      listener: (event: { preventDefault(): void }) => void
    ) {
      this.listeners[type] = listener;
    }

    convertToBlob() {
      return Promise.resolve(new Blob(["canvas"]));
    }
  }

  beforeEach(() => {
    vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);
  });

  it("manages WebGL context reuse, resize, silent loss, explicit loss, and release", () => {
    const manager = new __webglImageProcessingTestInternals.WebGLContextManager(
      "test"
    );

    const first = manager.getContext(10, 20);
    expect(first.isNew).toBe(true);
    const second = manager.getContext(30, 40);
    expect(second.isNew).toBe(false);
    expect(second.canvas.width).toBe(30);
    expect(second.canvas.height).toBe(40);

    vi.mocked(second.gl.isContextLost).mockReturnValueOnce(true);
    const third = manager.getContext(5, 6);
    expect(third.isNew).toBe(true);

    third.canvas.listeners.webglcontextlost({ preventDefault: vi.fn() });
    const fourth = manager.getContext(7, 8);
    expect(fourth.isNew).toBe(true);

    manager.handleContextLost();
    manager.release();

    const releasable = new __webglImageProcessingTestInternals.WebGLContextManager(
      "release"
    );
    const releasableContext = releasable.getContext(3, 3);
    releasable.release();
    expect(releasableContext.gl.getExtension).toHaveBeenCalledWith(
      "WEBGL_lose_context"
    );
  });

  it("computes and caches darkness factor and falls back without 2d context", () => {
    const img = { width: 2, height: 1 } as ImageBitmap;
    const first =
      __webglImageProcessingTestInternals.computeDarknessFactor(img);
    const second =
      __webglImageProcessingTestInternals.computeDarknessFactor(img);
    expect(second).toBe(first);

    class No2dCanvas extends MockOffscreenCanvas {
      override getContext(kind: string) {
        return kind === "2d" ? null : super.getContext(kind);
      }
    }
    vi.stubGlobal("OffscreenCanvas", No2dCanvas);
    expect(
      __webglImageProcessingTestInternals.computeDarknessFactor({
        width: 1,
        height: 1,
      } as ImageBitmap)
    ).toBe(0.5);
  });

  it("initializes programs, runs JFA steps, and calculates both placement branches", () => {
    const gl = makeGl();
    const programs = __webglImageProcessingTestInternals.initWebGLPrograms(gl);
    expect(programs).toHaveProperty("init");
    expect(gl.deleteShader).toHaveBeenCalledTimes(4);

    const resultTexture = __webglImageProcessingTestInternals.runJfaSteps(
      gl,
      { kind: "step" } as unknown as WebGLProgram,
      { kind: "texA" } as unknown as WebGLTexture,
      { kind: "texB" } as unknown as WebGLTexture,
      { kind: "fbA" } as unknown as WebGLFramebuffer,
      { kind: "fbB" } as unknown as WebGLFramebuffer,
      4,
      2
    );
    expect(resultTexture).toEqual({ kind: "texA" });
    expect(gl.drawArrays).toHaveBeenCalledTimes(2);

    expect(
      __webglImageProcessingTestInternals.calculateImagePlacement(
        { width: 8, height: 2 } as ImageBitmap,
        4,
        4
      )
    ).toMatchObject({
      drawHeight: 4,
      drawWidth: 16,
      offsetX: 6,
      offsetY: 0,
    });
    expect(
      __webglImageProcessingTestInternals.calculateImagePlacement(
        { width: 2, height: 8 } as ImageBitmap,
        4,
        4
      )
    ).toMatchObject({
      drawWidth: 4,
      drawHeight: 16,
      offsetX: 0,
      offsetY: 6,
    });
  });



  it("generates a WebGL bleed canvas for input-bleed and fallback placement branches", async () => {
    const withBleed = await generateBleedCanvasWebGL(
      { width: 69, height: 94 } as ImageBitmap,
      0.125,
      {
        unit: "in",
        dpi: 20,
        inputBleed: 0.125,
        darkenMode: "uniform",
        darkenThreshold: 10,
        darkenContrast: 1.5,
        darkenEdgeWidth: 0.2,
        darkenAmount: 0.8,
        darkenBrightness: -25,
      }
    );
    expect(withBleed.width).toBeGreaterThan(0);
    expect(withBleed.height).toBeGreaterThan(0);

    const fallback = await generateBleedCanvasWebGL(
      { width: 2, height: 2 } as ImageBitmap,
      1,
      { unit: "mm", dpi: 10, inputBleed: 100 }
    );
    expect(fallback.width).toBeGreaterThan(0);
  });

  it("processes generated-bleed card images for each darken output family", async () => {
    const base = await processCardImageWebGL(
      { width: 20, height: 30 } as ImageBitmap,
      1,
      { exportDpi: 20, displayDpi: 10, darkenMode: 1 }
    );
    expect(base.exportBlob).toBeInstanceOf(Blob);
    expect(base.displayBlob).toBeInstanceOf(Blob);
    expect(base.exportBlobDarkenAll).toBeInstanceOf(Blob);
    expect(base.baseDisplayBlob).toBe(base.displayBlob);

    const edges = await processCardImageWebGL(
      { width: 20, height: 30 } as ImageBitmap,
      1,
      { exportDpi: 20, displayDpi: 10, inputHasBleedMm: 0.5, darkenMode: 2 }
    );
    expect(edges.exportBlobContrastEdges).toBeInstanceOf(Blob);
    expect(edges.exportBlobDarkened).toBe(edges.exportBlobContrastEdges);

    const full = await processCardImageWebGL(
      { width: 20, height: 30 } as ImageBitmap,
      0.05,
      { unit: "in", exportDpi: 20, displayDpi: 10, inputHasBleedMm: 1, darkenMode: 3 }
    );
    expect(full.exportBlobContrastFull).toBeInstanceOf(Blob);
  });

  it("processes existing-bleed images for normal and selected darken modes", async () => {
    const normal = await processExistingBleedWebGL(
      { width: 20, height: 30 } as ImageBitmap,
      1,
      { exportDpi: 20, displayDpi: 10, darkenMode: 0 }
    );
    expect(normal.exportBlob).toBeInstanceOf(Blob);
    expect(normal.baseExportBlob).toBe(normal.exportBlob);
    expect(normal.exportBlobDarkened).toBeUndefined();

    const edges = await processExistingBleedWebGL(
      { width: 20, height: 30 } as ImageBitmap,
      0.05,
      { unit: "in", exportDpi: 20, displayDpi: 10, darkenMode: 2 }
    );
    expect(edges.exportBlobContrastEdges).toBeInstanceOf(Blob);
    expect(edges.exportBlobDarkened).toBe(edges.exportBlobContrastEdges);

    const full = await processExistingBleedWebGL(
      { width: 20, height: 30 } as ImageBitmap,
      1,
      { exportDpi: 20, displayDpi: 10, darkenMode: 3 }
    );
    expect(full.exportBlobContrastFull).toBeInstanceOf(Blob);
  });

  it("renders a direct bleed canvas through the mocked WebGL path", async () => {
    const canvas = await renderBleedCanvasDirect(
      { width: 2, height: 2 } as ImageBitmap,
      6,
      8,
      { mimeType: "image/png", darkenMode: 2 }
    );

    expect(canvas.width).toBe(6);
    expect(canvas.height).toBe(8);
  });
});
