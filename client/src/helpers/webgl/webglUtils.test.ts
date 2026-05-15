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
});
