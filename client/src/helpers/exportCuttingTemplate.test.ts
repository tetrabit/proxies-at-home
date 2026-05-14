import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadCuttingTemplate,
  generateCuttingTemplateSVG,
  settingsToCuttingTemplate,
  type CuttingTemplateSettings,
} from './exportCuttingTemplate';

vi.mock('./debug', () => ({ debugLog: vi.fn() }));

describe('exportCuttingTemplate', () => {
  const base: CuttingTemplateSettings = {
    pageWidthMm: 279.4,
    pageHeightMm: 215.9,
    columns: 2,
    rows: 1,
    bleedMm: 3,
    spacingMm: 2,
    positionOffsetXMm: 1,
    positionOffsetYMm: -1,
    portrait: false,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('converts inches and disabled bleed to template settings', () => {
    expect(settingsToCuttingTemplate(8.5, 11, 'in', 3, 3, false, 0.125, 'in', 1, 2, 3, true)).toEqual({
      pageWidthMm: 215.89999999999998,
      pageHeightMm: 279.4,
      columns: 3,
      rows: 3,
      bleedMm: 0,
      spacingMm: 1,
      positionOffsetXMm: 2,
      positionOffsetYMm: 3,
      portrait: true,
    });
  });

  it('converts inch bleed when bleed is enabled', () => {
    const settings = settingsToCuttingTemplate(8.5, 11, 'in', 1, 1, true, 0.125, 'in', 0, 0, 0, false);
    expect(settings.bleedMm).toBeCloseTo(3.175);
  });

  it('converts millimeter bleed and emits landscape card rectangles', () => {
    const settings = settingsToCuttingTemplate(279.4, 215.9, 'mm', 1, 1, true, 2, 'mm', 0, 0, 0, false);
    const svg = generateCuttingTemplateSVG(settings);
    expect(svg).toContain('width="279.4mm"');
    expect(svg).toContain('Page: 279.4mm x 215.9mm');
    expect(svg).toContain('Cards: 1 standard MTG cards');
    expect(svg).toContain('width="63" height="88"');
  });

  it('rotates portrait templates and labels rows', () => {
    const svg = generateCuttingTemplateSVG({ ...base, portrait: true });
    expect(svg).toContain('width="215.9mm"');
    expect(svg).toContain('(portrait)');
    expect(svg).toContain('<!-- Row 1 -->');
    expect(svg).toContain('width="88" height="63"');
  });

  it('downloads a named SVG and revokes the object URL later', () => {
    const link = document.createElement('a');
    const click = vi.spyOn(link, 'click').mockImplementation(() => undefined);
    vi.spyOn(document, 'createElement').mockReturnValue(link);
    const append = vi.spyOn(document.body, 'appendChild');
    const remove = vi.spyOn(document.body, 'removeChild');

    downloadCuttingTemplate(base);

    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(append).toHaveBeenCalledWith(link);
    expect(click).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(link);
    vi.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  it('downloads portrait filenames for portrait settings', () => {
    const link = document.createElement('a');
    vi.spyOn(link, 'click').mockImplementation(() => undefined);
    vi.spyOn(document, 'createElement').mockReturnValue(link);

    downloadCuttingTemplate({ ...base, portrait: true });
    expect(link.download).toBe('cutting_template_letter_landscape_2x1_3mm_bleed_portrait.svg');
  });

  it('uses custom dimensions in filenames when no common page size matches', () => {
    const link = document.createElement('a');
    vi.spyOn(link, 'click').mockImplementation(() => undefined);
    vi.spyOn(document, 'createElement').mockReturnValue(link);

    downloadCuttingTemplate({ ...base, pageWidthMm: 123.4, pageHeightMm: 234.5 });
    expect(link.download).toBe('cutting_template_123x235mm_2x1_3mm_bleed_landscape.svg');
  });
});
