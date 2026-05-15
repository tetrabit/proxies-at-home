import { describe, expect, it } from "vitest";
import { DARKEN_FUNCTIONS_GLSL, DARKEN_UNIFORMS_GLSL } from "./sharedShaders";
import { DEFAULT_RENDER_PARAMS } from "./types";

describe("CardCanvas shader/type exports", () => {
  it("exports darken uniforms consumed by canvas renderers", () => {
    expect(DARKEN_UNIFORMS_GLSL).toContain("uniform float u_darknessFactor");
    expect(DARKEN_UNIFORMS_GLSL).toContain("uniform int u_darkenMode");
    expect(DARKEN_UNIFORMS_GLSL).toContain("uniform float u_darkenBrightness");
  });

  it("exports all shared darkening functions", () => {
    expect(DARKEN_FUNCTIONS_GLSL).toContain("vec3 applyDarkenAll");
    expect(DARKEN_FUNCTIONS_GLSL).toContain("vec3 applyEdgeContrast");
    expect(DARKEN_FUNCTIONS_GLSL).toContain("vec3 applyFullContrast");
    expect(DARKEN_FUNCTIONS_GLSL).toContain("u_resolution");
  });

  it("keeps default render parameters aligned with disabled effects", () => {
    expect(DEFAULT_RENDER_PARAMS).toMatchObject({
      darkenMode: "none",
      brightness: 0,
      contrast: 1,
      saturation: 1,
      holoEffect: "none",
      colorReplaceEnabled: false,
      gamma: 1,
      vignetteAmount: 0,
    });
  });
});
