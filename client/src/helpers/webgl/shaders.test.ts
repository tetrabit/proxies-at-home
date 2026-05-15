import { describe, expect, it } from "vitest";
import { VS_QUAD, FS_INIT, FS_STEP, FS_FINAL } from "./shaders";

describe("webgl shaders", () => {
  it("exports the expected shader program fragments", () => {
    expect(VS_QUAD).toContain("#version 300 es");
    expect(VS_QUAD).toContain("gl_Position");
    expect(FS_INIT).toContain("uniform sampler2D u_image");
    expect(FS_INIT).toContain("outColor = vec4(-1.0, -1.0, 0.0, 0.0)");
    expect(FS_STEP).toContain("uniform sampler2D u_seeds");
    expect(FS_STEP).toContain("bestSeed");
    expect(FS_FINAL).toContain("uniform sampler2D u_seeds");
    expect(FS_FINAL).toContain("outColor");
  });
});
