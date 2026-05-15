import { describe, expect, it, vi } from 'vitest';

vi.mock('pixi.js', () => {
  class Filter {
    resources: Record<string, { uniforms: Record<string, unknown> }>;

    constructor(options: { resources: Record<string, Record<string, { value: unknown }>> }) {
      this.resources = Object.fromEntries(
        Object.entries(options.resources).map(([resourceName, uniforms]) => [
          resourceName,
          {
            uniforms: Object.fromEntries(
              Object.entries(uniforms).map(([uniformName, uniform]) => [uniformName, uniform.value])
            ),
          },
        ])
      );
    }
  }

  return {
    Filter,
    GlProgram: { from: vi.fn((program) => program) },
  };
});

import { DarkenFilter } from './DarkenFilter';

describe('DarkenFilter', () => {
  it('maps darken settings to shader uniforms', () => {
    const filter = new DarkenFilter();
    const uniforms = filter.resources.darkenUniforms.uniforms;

    filter.darknessFactor = 0.6;
    filter.darkenThreshold = 0.2;
    filter.darkenContrast = 1.4;
    filter.darkenEdgeWidth = 0.12;
    filter.darkenAmount = 0.33;
    filter.darkenBrightness = 0.44;
    filter.textureResolution = [1024, 768];

    expect(filter.darknessFactor).toBe(0.6);
    expect(filter.darkenThreshold).toBe(0.2);
    expect(filter.darkenContrast).toBe(1.4);
    expect(filter.darkenEdgeWidth).toBe(0.12);
    expect(filter.darkenAmount).toBe(0.33);
    expect(filter.darkenBrightness).toBe(0.44);
    expect(filter.textureResolution).toEqual([1024, 768]);

    filter.darkenMode = 'none';
    expect(uniforms.u_darkenMode).toBe(0);
    filter.darkenMode = 'darken-all';
    expect(uniforms.u_darkenMode).toBe(1);
    filter.darkenMode = 'contrast-edges';
    expect(uniforms.u_darkenMode).toBe(2);
    filter.darkenMode = 'contrast-full';
    expect(uniforms.u_darkenMode).toBe(3);

    expect(filter.darkenMode).toBe('none');
  });
});
