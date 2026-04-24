import { describe, expect, it } from 'vitest';

import { deriveSourceBleedPixelsFromGeometry, getCardPixelDimensionsForBleed } from './webglImageProcessing';
import { getBleedInPixels } from './imageProcessing';

describe('getCardPixelDimensionsForBleed', () => {
    it('derives fixed physical dimensions from bleed and DPI', () => {
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

describe('deriveSourceBleedPixelsFromGeometry', () => {
    it('returns zero bleed pixels when no input bleed is provided', () => {
        expect(deriveSourceBleedPixelsFromGeometry(1000, 1400, 0)).toEqual({
            bleedPxX: 0,
            bleedPxY: 0,
        });
    });

    it('derives source bleed pixels from bitmap geometry instead of export dpi', () => {
        const result = deriveSourceBleedPixelsFromGeometry(694, 944, 3.175);
        const oldDpiBasedBleedPx = Math.round(getBleedInPixels(3.175, 'mm', 1200));

        expect(result).toEqual({
            bleedPxX: 32,
            bleedPxY: 32,
        });
        expect(result.bleedPxX).not.toBe(oldDpiBasedBleedPx);
        expect(result.bleedPxY).not.toBe(oldDpiBasedBleedPx);
    });

    it('keeps inner content dimensions close to card content geometry', () => {
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
