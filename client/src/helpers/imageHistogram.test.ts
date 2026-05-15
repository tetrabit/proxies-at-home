import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateDarknessFactorFromBlob } from './imageHistogram';

type ImageEventHandler = (() => void) | null;

class MockImage {
    width = 2;
    height = 2;
    onload: ImageEventHandler = null;
    onerror: ImageEventHandler = null;
    private shouldFail = false;

    set src(value: string) {
        this.shouldFail = value.includes('fail');
        if (this.shouldFail) {
            this.onerror?.();
            return;
        }
        this.onload?.();
    }
}

describe('imageHistogram', () => {
    const originalImage = globalThis.Image;
    const originalOffscreenCanvas = globalThis.OffscreenCanvas;
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.stubGlobal('Image', MockImage);
        URL.createObjectURL = vi.fn(() => 'blob:histogram-success');
        URL.revokeObjectURL = vi.fn();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        globalThis.Image = originalImage;
        globalThis.OffscreenCanvas = originalOffscreenCanvas;
        URL.createObjectURL = originalCreateObjectUrl;
        URL.revokeObjectURL = originalRevokeObjectUrl;
    });

    it('calculates darkness from pixels using an OffscreenCanvas context', async () => {
        const context = {
            drawImage: vi.fn(),
            getImageData: vi.fn(() => ({
                data: new Uint8ClampedArray([
                    20, 20, 20, 255,
                    240, 240, 240, 255,
                    240, 240, 240, 255,
                    240, 240, 240, 255,
                ]),
            })),
        };
        class MockOffscreenCanvas {
            constructor(public width: number, public height: number) { }
            getContext() {
                return context;
            }
        }
        vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);

        const result = await calculateDarknessFactorFromBlob(new Blob(['image']));

        expect(result).toBe(1);
        expect(context.drawImage).toHaveBeenCalledWith(expect.any(MockImage), 0, 0);
        expect(context.getImageData).toHaveBeenCalledWith(0, 0, 2, 2);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:histogram-success');
    });

    it('falls back to regular canvas and the default when no context is available', async () => {
        vi.stubGlobal('OffscreenCanvas', undefined);
        const canvas = {
            width: 0,
            height: 0,
            getContext: vi.fn(() => null),
        };
        const createElementSpy = vi
            .spyOn(document, 'createElement')
            .mockReturnValue(canvas as unknown as HTMLCanvasElement);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const result = await calculateDarknessFactorFromBlob(new Blob(['image']));

        expect(result).toBe(0.5);
        expect(createElementSpy).toHaveBeenCalledWith('canvas');
        expect(canvas.width).toBe(2);
        expect(canvas.height).toBe(2);
        expect(warnSpy).toHaveBeenCalledWith('[imageHistogram] Could not get canvas context, using default');
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:histogram-success');
    });

    it('returns the default when drawing or reading pixels throws', async () => {
        const error = new Error('canvas failed');
        class ThrowingOffscreenCanvas {
            constructor(public width: number, public height: number) { }
            getContext() {
                return {
                    drawImage: vi.fn(() => {
                        throw error;
                    }),
                    getImageData: vi.fn(),
                };
            }
        }
        vi.stubGlobal('OffscreenCanvas', ThrowingOffscreenCanvas);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const result = await calculateDarknessFactorFromBlob(new Blob(['image']));

        expect(result).toBe(0.5);
        expect(errorSpy).toHaveBeenCalledWith('[imageHistogram] Error calculating darkness factor:', error);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:histogram-success');
    });

    it('returns the default when the image fails to load', async () => {
        URL.createObjectURL = vi.fn(() => 'blob:histogram-fail');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const result = await calculateDarknessFactorFromBlob(new Blob(['image']));

        expect(result).toBe(0.5);
        expect(warnSpy).toHaveBeenCalledWith('[imageHistogram] Failed to load image, using default');
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:histogram-fail');
    });
});
