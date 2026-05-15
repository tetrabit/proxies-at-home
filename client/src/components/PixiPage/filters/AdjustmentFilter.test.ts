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

import { AdjustmentFilter } from './AdjustmentFilter';

describe('AdjustmentFilter', () => {
  it('maps scalar adjustment properties to Pixi uniforms', () => {
    const filter = new AdjustmentFilter();

    const scalarValues: Array<[keyof AdjustmentFilter, number]> = [
      ['brightness', 0.25],
      ['contrast', 1.5],
      ['saturation', 0.75],
      ['sharpness', 0.4],
      ['hueShift', 45],
      ['sepia', 0.6],
      ['vignetteAmount', 0.7],
      ['vignetteSize', 0.8],
      ['vignetteFeather', 0.9],
      ['tintAmount', 0.3],
      ['redBalance', 0.1],
      ['greenBalance', 0.2],
      ['blueBalance', 0.3],
      ['cyanBalance', 0.4],
      ['magentaBalance', 0.5],
      ['yellowBalance', 0.6],
      ['blackBalance', 0.7],
      ['shadowsIntensity', 0.8],
      ['midtonesIntensity', 0.9],
      ['highlightsIntensity', 1.0],
      ['noiseReduction', 0.11],
      ['holoStrength', 12],
      ['holoAreaThreshold', 34],
      ['holoAngle', 56],
      ['holoSweepWidth', 78],
      ['holoStarSize', 90],
      ['holoStarVariety', 21],
      ['holoBlur', 43],
      ['holoProbability', 65],
      ['colorReplaceThreshold', 87],
      ['gamma', 1.2],
    ];

    for (const [property, value] of scalarValues) {
      (filter[property] as number) = value;
      expect(filter[property]).toBe(value);
    }

    filter.pop = 25;
    expect(filter.pop).toBe(0.25);
  });

  it('maps vector, color, boolean, and enum properties to uniforms', () => {
    const filter = new AdjustmentFilter();

    filter.textureResolution = [640, 480];
    expect(filter.textureResolution).toEqual([640, 480]);

    filter.tintColor = '#336699';
    expect(filter.tintColor).toBe('#336699');

    filter.cmykPreview = true;
    expect(filter.cmykPreview).toBe(true);
    filter.cmykPreview = false;
    expect(filter.cmykPreview).toBe(false);

    filter.holoEffect = 'rainbow';
    expect(filter.holoEffect).toBe('rainbow');
    filter.holoEffect = 'glitter';
    expect(filter.holoEffect).toBe('glitter');
    filter.holoEffect = 'stars';
    expect(filter.holoEffect).toBe('stars');
    filter.holoEffect = 'none';
    expect(filter.holoEffect).toBe('none');

    filter.holoAreaMode = 'bright';
    expect(filter.holoAreaMode).toBe('bright');
    filter.holoAreaMode = 'full';
    expect(filter.holoAreaMode).toBe('full');

    filter.holoUvOffset = [0.25, 0.5];
    expect(filter.holoUvOffset).toEqual([0.25, 0.5]);
    filter.holoUvScale = [0.75, 1.25];
    expect(filter.holoUvScale).toEqual([0.75, 1.25]);

    filter.colorReplaceEnabled = true;
    expect(filter.colorReplaceEnabled).toBe(true);
    filter.colorReplaceEnabled = false;
    expect(filter.colorReplaceEnabled).toBe(false);

    filter.colorReplaceSource = '#123456';
    expect(filter.colorReplaceSource).toBe('#123456');
    filter.colorReplaceTarget = '#abcdef';
    expect(filter.colorReplaceTarget).toBe('#abcdef');
  });
});
