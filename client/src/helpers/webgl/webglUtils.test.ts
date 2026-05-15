import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShader,
  createProgram,
  createTexture,
  createFramebuffer,
  createQuadBuffer,
} from "./webglUtils";

function makeGl(overrides: Partial<WebGL2RenderingContext> = {}) {
  const gl = {
    createShader: vi.fn(() => ({ shader: true } as unknown as WebGLShader)),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => "shader failed"),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({ program: true } as unknown as WebGLProgram)),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => "program failed"),
    deleteProgram: vi.fn(),
    createTexture: vi.fn(() => ({ texture: true } as unknown as WebGLTexture)),
    bindTexture: vi.fn(),
    texImage2D: vi.fn(),
    texParameteri: vi.fn(),
    createFramebuffer: vi.fn(() => ({ framebuffer: true } as unknown as WebGLFramebuffer)),
    bindFramebuffer: vi.fn(),
    framebufferTexture2D: vi.fn(),
    checkFramebufferStatus: vi.fn(() => 0x8CD5),
    createBuffer: vi.fn(() => ({ buffer: true } as unknown as WebGLBuffer)),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    COMPILE_STATUS: 0x8B81,
    LINK_STATUS: 0x8B82,
    FRAMEBUFFER: 0x8D40,
    COLOR_ATTACHMENT0: 0x8CE0,
    TEXTURE_2D: 0x0DE1,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812F,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88E4,
    FRAMEBUFFER_COMPLETE: 0x8CD5,
    ...overrides,
  } as unknown as WebGL2RenderingContext;

  return gl;
}

describe("webglUtils", () => {
  let gl: ReturnType<typeof makeGl>;

  beforeEach(() => {
    gl = makeGl();
  });

  it("creates shaders and programs", () => {
    const shader = createShader(gl, 0x8B31, "void main() {}");
    expect(shader).toEqual({ shader: true });
    expect(gl.shaderSource).toHaveBeenCalledWith(shader, "void main() {}");

    const program = createProgram(gl, shader, shader);
    expect(program).toEqual({ program: true });
    expect(gl.attachShader).toHaveBeenCalledTimes(2);
    expect(gl.linkProgram).toHaveBeenCalledWith(program);
  });

  it("throws when shader or program compilation fails", () => {
    gl.getShaderParameter = vi.fn(() => false);
    expect(() => createShader(gl, 0x8B31, "bad")).toThrow(/Failed to compile shader/);

    gl.getShaderParameter = vi.fn(() => true);
    gl.getProgramParameter = vi.fn(() => false);
    expect(() => createProgram(gl, {} as WebGLShader, {} as WebGLShader)).toThrow(/Failed to link program/);
  });

  it("creates textures, framebuffers, and quad buffers", () => {
    const texture = createTexture(gl, 2, 3);
    expect(texture).toEqual({ texture: true });
    expect(gl.texImage2D).toHaveBeenCalledWith(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      2,
      3,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    );

    const framebuffer = createFramebuffer(gl, texture);
    expect(framebuffer).toEqual({ framebuffer: true });
    expect(gl.framebufferTexture2D).toHaveBeenCalledWith(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0
    );

    const buffer = createQuadBuffer(gl);
    expect(buffer).toEqual({ buffer: true });
    expect(gl.bufferData).toHaveBeenCalled();
  });

  it("creates textures with explicit pixel formats and data", () => {
    const data = new Uint8Array([1, 2, 3, 4]);

    const texture = createTexture(gl, 1, 1, data, 1, 2, 3);

    expect(texture).toEqual({ texture: true });
    expect(gl.texImage2D).toHaveBeenCalledWith(
      gl.TEXTURE_2D,
      0,
      1,
      1,
      1,
      0,
      2,
      3,
      data
    );
  });

  it("throws when WebGL object creation returns null", () => {
    expect(() =>
      createShader(makeGl({ createShader: vi.fn(() => null) }), 0x8B31, "")
    ).toThrow("Failed to create shader");
    expect(() =>
      createProgram(
        makeGl({ createProgram: vi.fn(() => null) }),
        {} as WebGLShader,
        {} as WebGLShader
      )
    ).toThrow("Failed to create program");
    expect(() =>
      createTexture(makeGl({ createTexture: vi.fn(() => null) }), 1, 1)
    ).toThrow("Failed to create texture");
    expect(() =>
      createFramebuffer(
        makeGl({ createFramebuffer: vi.fn(() => null) }),
        {} as WebGLTexture
      )
    ).toThrow("Failed to create framebuffer");
    expect(() =>
      createQuadBuffer(makeGl({ createBuffer: vi.fn(() => null) }))
    ).toThrow("Failed to create buffer");
  });

  it("throws when framebuffer completeness validation fails", () => {
    gl.checkFramebufferStatus = vi.fn(() => 0);

    expect(() =>
      createFramebuffer(gl, { texture: true } as unknown as WebGLTexture)
    ).toThrow("Framebuffer is not complete");
  });
});
