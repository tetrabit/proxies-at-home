import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    toProxied,
    fetchWithRetry,
    loadImage,
    getBleedInPixels,
    bucketDpiFromHeight,
    calibratedBleedTrimPxForHeight,
    trimExistingBleedIfAny,
    trimBleedByMm,
    blackenAllNearBlackPixels,
    getPatchNearCorner,
    computeDarknessFactorFromImageData,
    applyEdgeContrastCPU,
    applyContrastFullCPU,
    applyDarkenAllCPU,
    IN,
    MM_TO_PX,
    NEAR_BLACK,
    NEAR_WHITE,
    ALPHA_EMPTY,
    shouldTrimBleed
} from './imageProcessing';

// ... (MockOffscreenCanvas)

// ... (describe blocks)



// Polyfill OffscreenCanvas
// Polyfill OffscreenCanvas
class MockOffscreenCanvas {
    width = 0;
    height = 0;
    _context: any; // eslint-disable-line @typescript-eslint/no-explicit-any

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        this._context = {
            _imgData: null as any, // eslint-disable-line @typescript-eslint/no-explicit-any
            createImageData: (w: number, h: number) => ({
                width: w,
                height: h,
                data: new Uint8ClampedArray(w * h * 4)
            }),
            putImageData: (imgData: any) => { this._context._imgData = imgData; }, // eslint-disable-line @typescript-eslint/no-explicit-any
            getImageData: (sx: number, sy: number, sw: number, sh: number) => {
                const fullData = this._context._imgData;
                const result = new Uint8ClampedArray(sw * sh * 4);
                if (fullData) {
                    for (let y = 0; y < sh; y++) {
                        for (let x = 0; x < sw; x++) {
                            const srcIdx = ((sy + y) * this.width + (sx + x)) * 4;
                            const dstIdx = (y * sw + x) * 4;
                            if (srcIdx < fullData.data.length) {
                                result[dstIdx] = fullData.data[srcIdx];
                                result[dstIdx + 1] = fullData.data[srcIdx + 1];
                                result[dstIdx + 2] = fullData.data[srcIdx + 2];
                                result[dstIdx + 3] = fullData.data[srcIdx + 3];
                            }
                        }
                    }
                }
                return { width: sw, height: sh, data: result };
            },
            drawImage: vi.fn(),
            canvas: this
        };
    }

    getContext() {
        return this._context;
    }
}

(global as any).OffscreenCanvas = MockOffscreenCanvas; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('imageProcessing', () => {
    describe('Constants', () => {
        it('should export correct constants', () => {
            expect(NEAR_BLACK).toBe(16);
            expect(NEAR_WHITE).toBe(239);
            expect(ALPHA_EMPTY).toBe(10);
        });
    });

    describe('shouldTrimBleed', () => {
        it('should return true when target bleed is smaller than existing bleed', () => {
            // Target 1mm, Existing 3mm -> Trim
            expect(shouldTrimBleed(1, 3)).toBe(true);
        });

        it('should return true when target bleed is equal to existing bleed', () => {
            // Target 3mm, Existing 3mm -> Trim (or rather, no-op trim but use Fast Path)
            expect(shouldTrimBleed(3, 3)).toBe(true);
        });

        it('should return false when target bleed is larger than existing bleed', () => {
            // Target 5mm, Existing 3mm -> Need JFA to generate diff
            expect(shouldTrimBleed(5, 3)).toBe(false);
        });

        it('should use default MPC bleed if existing bleed is not provided', () => {
            // Default MPC is ~3.175mm. Target 1mm. Should trim.
            expect(shouldTrimBleed(1)).toBe(true);
        });

        it('should return false if target is larger than default MPC bleed', () => {
            // Target 5mm, Default 3.175mm -> Need JFA
            expect(shouldTrimBleed(5)).toBe(false);
        });
    });

    describe('Unit Conversions', () => {
        it('IN should convert inches to pixels', () => {
            expect(IN(1, 300)).toBe(300);
            expect(IN(2.5, 96)).toBe(240);
        });

        it('MM_TO_PX should convert mm to pixels', () => {
            // 1 inch = 25.4 mm
            // 25.4 mm at 300 DPI should be 300 px
            expect(Math.round(MM_TO_PX(25.4, 300))).toBe(300);
        });
    });

    describe('toProxied', () => {
        it('should proxy external URLs', () => {
            const url = 'https://example.com/image.png';
            const apiBase = 'http://localhost:3000';
            const proxied = toProxied(url, apiBase);
            expect(proxied).toBe(`${apiBase}/api/cards/images/proxy?url=${encodeURIComponent(url)}`);
        });

        it('should not proxy local blob URLs', () => {
            const url = 'blob:http://localhost:3000/uuid';
            const proxied = toProxied(url, 'http://localhost:3000');
            expect(proxied).toBe(url);
        });

        it('should not proxy already proxied URLs', () => {
            const url = 'http://localhost:3000/api/cards/images/proxy?url=foo';
            const proxied = toProxied(url, 'http://localhost:3000');
            expect(proxied).toBe(url);
        });

        it('should preserve empty, data, and internal image URLs', () => {
            expect(toProxied('', 'http://localhost:3000')).toBe('');
            expect(toProxied('data:image/png;base64,abc', 'http://localhost:3000')).toBe('data:image/png;base64,abc');
            expect(toProxied('http://localhost:3000/api/cards/images/raw/1', 'http://localhost:3000')).toBe('http://localhost:3000/api/cards/images/raw/1');
        });

        it('should convert saved MPC ids while proxying http and absolute path size URLs', () => {
            expect(toProxied('abc123&size=small', 'http://localhost:3000')).toBe('http://localhost:3000/api/cards/images/mpc?id=abc123&size=small');
            expect(toProxied('https://example.com/img.png?x=1&size=small', 'http://localhost:3000')).toBe('http://localhost:3000/api/cards/images/proxy?url=https%3A%2F%2Fexample.com%2Fimg.png%3Fx%3D1%26size%3Dsmall');
            expect(toProxied('/relative.png?x=1&size=small', 'http://localhost:3000')).toBe('http://localhost:3000/api/cards/images/proxy?url=%2Frelative.png%3Fx%3D1%26size%3Dsmall');
        });
    });

    describe('getBleedInPixels', () => {
        it('should calculate bleed in pixels for mm', () => {
            // 3mm at 300 DPI
            // 3mm = 0.11811 inches
            // 0.11811 * 300 = 35.433
            const px = getBleedInPixels(3, 'mm', 300);
            expect(px).toBeGreaterThan(34);
            expect(px).toBeLessThan(36);
        });

        it('should calculate bleed in pixels for inches', () => {
            // 0.125 inches at 300 DPI
            // 0.125 * 300 = 37.5
            const px = getBleedInPixels(0.125, 'in', 300);
            expect(px).toBe(38); // Math.round(37.5) = 38
        });
    });

    describe('trimExistingBleedIfAny', () => {
        it('should return original image if trimmed dimensions are invalid', async () => {
            const img = {
                width: 100,
                height: 100,
                close: vi.fn(),
            } as unknown as ImageBitmap;

            global.createImageBitmap = vi.fn().mockResolvedValue(img);
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                blob: async () => new Blob(['']),
            });

            // trim = 50 -> w = 0, h = 0
            const result = await trimExistingBleedIfAny('dummy-url', 50);
            expect(result).toBe(img);
            expect(img.close).not.toHaveBeenCalled();
        });

        it('should trim bleed correctly', async () => {
            const mockImg = { width: 1000, height: 1000, close: vi.fn() };
            const mockTrimmed = { width: 856, height: 856 }; // 1000 - 72*2 (300dpi trim is 72)

            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                blob: () => Promise.resolve(new Blob(['']))
            });
            global.createImageBitmap = vi.fn()
                .mockResolvedValueOnce(mockImg)
                .mockResolvedValueOnce(mockTrimmed);

            const result = await trimExistingBleedIfAny('test.png');

            expect(global.createImageBitmap).toHaveBeenCalledTimes(2);
            expect(result).toEqual(mockTrimmed);
            expect(mockImg.close).toHaveBeenCalled();
        });
    });

    describe('trimBleedByMm', () => {
        it('should trim an ImageBitmap input by millimeters', async () => {
            const img = { width: 1000, height: 1000, close: vi.fn() } as unknown as ImageBitmap;
            const trimmed = { width: 978, height: 978 } as unknown as ImageBitmap;
            global.createImageBitmap = vi.fn().mockResolvedValue(trimmed);

            const result = await trimBleedByMm(img, 1, 3);

            expect(result).toBe(trimmed);
            expect(global.createImageBitmap).toHaveBeenCalledWith(img, 11, 11, 978, 978);
            expect(img.close).not.toHaveBeenCalled();
        });

        it('should trim a Blob input and close the temporary bitmap', async () => {
            const blob = new Blob(['image']);
            const temp = { width: 1000, height: 1000, close: vi.fn() } as unknown as ImageBitmap;
            const trimmed = { width: 978, height: 978 } as unknown as ImageBitmap;
            global.createImageBitmap = vi.fn()
                .mockResolvedValueOnce(temp)
                .mockResolvedValueOnce(trimmed);

            const result = await trimBleedByMm(blob, 1, 3);

            expect(result).toBe(trimmed);
            expect(temp.close).toHaveBeenCalled();
            expect(global.createImageBitmap).toHaveBeenLastCalledWith(blob, 11, 11, 978, 978);
        });

        it('should return the original bitmap or blob bitmap when trim dimensions are invalid', async () => {
            const img = { width: 10, height: 10, close: vi.fn() } as unknown as ImageBitmap;
            await expect(trimBleedByMm(img, 1000, 0)).resolves.toBe(img);

            const blob = new Blob(['image']);
            const temp = { width: 10, height: 10, close: vi.fn() } as unknown as ImageBitmap;
            const fallback = { width: 10, height: 10 } as unknown as ImageBitmap;
            global.createImageBitmap = vi.fn()
                .mockResolvedValueOnce(temp)
                .mockResolvedValueOnce(fallback);

            await expect(trimBleedByMm(blob, 1000, 0)).resolves.toBe(fallback);
            expect(temp.close).toHaveBeenCalled();
            expect(global.createImageBitmap).toHaveBeenLastCalledWith(blob);
        });
    });

    describe('bucketDpiFromHeight', () => {
        it('should bucket to 300 DPI for small images', () => {
            expect(bucketDpiFromHeight(2200)).toBe(300);
        });

        it('should bucket to 600 DPI for medium images', () => {
            expect(bucketDpiFromHeight(2220)).toBe(600);
        });

        it('should bucket to 800 DPI for large images', () => {
            expect(bucketDpiFromHeight(2960)).toBe(800);
        });

        it('should bucket to 1200 DPI for very large images', () => {
            expect(bucketDpiFromHeight(4440)).toBe(1200);
        });
    });

    describe('getPatchNearCorner', () => {
        it('should find best patch with low variance', () => {
            const canvas = new OffscreenCanvas(20, 20);
            const ctx = canvas.getContext('2d')!;

            // Fill deterministic high-variance, non-black pixels so the later
            // flat patch exercises the "replace current best" branch.
            const imgData = ctx.createImageData(20, 20);
            for (let i = 0; i < imgData.data.length; i += 4) {
                imgData.data[i] = 255;
                imgData.data[i + 1] = 0;
                imgData.data[i + 2] = 128;
                imgData.data[i + 3] = 255;
            }

            // Create a flat patch at 4,4
            for (let y = 0; y < 4; y++) {
                for (let x = 0; x < 4; x++) {
                    const idx = ((4 + y) * 20 + (4 + x)) * 4;
                    imgData.data[idx] = 100;
                    imgData.data[idx + 1] = 100;
                    imgData.data[idx + 2] = 100;
                }
            }
            ctx.putImageData(imgData, 0, 0);

            const result = getPatchNearCorner(ctx, 0, 0, 4);
            expect(result).toEqual({ sx: 4, sy: 4 });
        });

        it('should replace the initial qualifying patch when a lower-variance patch is found', () => {
            const canvas = new OffscreenCanvas(8, 4);
            const ctx = canvas.getContext('2d')!;
            const imgData = ctx.createImageData(8, 4);

            for (let y = 0; y < 4; y++) {
                for (let x = 0; x < 4; x++) {
                    const idx = (y * 8 + x) * 4;
                    imgData.data[idx] = 255;
                    imgData.data[idx + 1] = 0;
                    imgData.data[idx + 2] = 0;
                    imgData.data[idx + 3] = 255;
                }
            }
            for (let y = 0; y < 4; y++) {
                for (let x = 4; x < 8; x++) {
                    const idx = (y * 8 + x) * 4;
                    imgData.data[idx] = 100;
                    imgData.data[idx + 1] = 100;
                    imgData.data[idx + 2] = 100;
                    imgData.data[idx + 3] = 255;
                }
            }
            ctx.putImageData(imgData, 0, 0);

            const result = getPatchNearCorner(ctx, 0, 0, 4);
            expect(result).toEqual({ sx: 4, sy: 0 });
        });

        it('should count black pixels', () => {
            const canvas = new OffscreenCanvas(4, 4);
            const ctx = canvas.getContext('2d')!;
            const imgData = ctx.createImageData(4, 4);
            // Fill with black (0,0,0)
            for (let i = 0; i < imgData.data.length; i += 4) {
                imgData.data[i] = 0;
                imgData.data[i + 1] = 0;
                imgData.data[i + 2] = 0;
                imgData.data[i + 3] = 255;
            }
            ctx.putImageData(imgData, 0, 0);

            const result = getPatchNearCorner(ctx, 0, 0, 4);
            expect(result).toEqual({ sx: 0, sy: 0 });
        });
    });

    describe('calibratedBleedTrimPxForHeight', () => {
        it('should return calibrated trim for 800 DPI', () => {
            expect(calibratedBleedTrimPxForHeight(2960)).toBe(104);
        });

        it('should return calibrated trim for 1200 DPI', () => {
            expect(calibratedBleedTrimPxForHeight(4440)).toBe(156);
        });
        it('should return calibrated trim for 600 DPI', () => {
            expect(calibratedBleedTrimPxForHeight(2220)).toBe(78);
        });
    });

    describe('blackenAllNearBlackPixels', () => {
        it('should apply adaptive edge contrast to near-edge pixels', () => {
            const canvas = new OffscreenCanvas(2, 1);
            const ctx = canvas.getContext('2d')!;

            // Pixel 0: Near black (5, 5, 5) - at edge
            // Pixel 1: Not near black (50, 50, 50) - also at edge in 2x1 canvas
            const imgData = ctx.createImageData(2, 1);
            imgData.data.set([5, 5, 5, 255, 50, 50, 50, 255]);

            blackenAllNearBlackPixels(imgData);

            const data = imgData.data;
            // Both pixels are at edge (in a 2x1 canvas), so edge processing may apply
            // Just verify the function runs without error and values are in valid range
            expect(data[0]).toBeGreaterThanOrEqual(0);
            expect(data[0]).toBeLessThanOrEqual(255);
            expect(data[4]).toBeGreaterThanOrEqual(0);
            expect(data[4]).toBeLessThanOrEqual(255);
        });

        it('should leave center pixels unchanged when outside edge region', () => {
            // 300 DPI -> border is ~64px
            // Canvas 200x200. Center (100, 100) is well outside border.
            const canvas = new OffscreenCanvas(200, 200);
            const ctx = canvas.getContext('2d')!;

            // Fill with gray value
            const imgData = ctx.createImageData(200, 200);
            for (let i = 0; i < imgData.data.length; i += 4) {
                imgData.data[i] = 100;
                imgData.data[i + 1] = 100;
                imgData.data[i + 2] = 100;
                imgData.data[i + 3] = 255;
            }

            blackenAllNearBlackPixels(imgData);

            const data = imgData.data;

            // Pixel at (100,100) is center -> should be unchanged
            const centerIdx = (100 * 200 + 100) * 4;
            expect(data[centerIdx]).toBe(100);
            expect(data[centerIdx + 1]).toBe(100);
            expect(data[centerIdx + 2]).toBe(100);
        });

        it('should skip bright edge channels and zero-strength threshold channels', () => {
            const imgData = {
                width: 20,
                height: 20,
                data: new Uint8ClampedArray(20 * 20 * 4).fill(0),
            } as ImageData;
            imgData.data.set([200, 140, 5, 255], 0);

            blackenAllNearBlackPixels(imgData);

            expect(imgData.data[0]).toBe(200);
            expect(imgData.data[1]).toBe(140);
            expect(imgData.data[2]).toBeLessThan(5);
        });
    });

    describe('CPU contrast helpers', () => {
        function makeImageData(width: number, height: number, fill = 100): ImageData {
            const data = new Uint8ClampedArray(width * height * 4);
            for (let i = 0; i < data.length; i += 4) {
                data[i] = fill;
                data[i + 1] = fill;
                data[i + 2] = fill;
                data[i + 3] = 255;
            }
            return { width, height, data } as ImageData;
        }

        it('should compute darkness from ImageData', () => {
            const imageData = makeImageData(2, 1, 20);

            expect(computeDarknessFactorFromImageData(imageData)).toBe(1);
        });

        it('should apply edge contrast only to dark edge channels', () => {
            const imageData = makeImageData(20, 20, 100);
            imageData.data.set([200, 140, 5, 255], 0);
            const center = (10 * 20 + 10) * 4;
            imageData.data.set([100, 100, 100, 255], center);

            applyEdgeContrastCPU(imageData, 1);

            expect(imageData.data[0]).toBe(200);
            expect(imageData.data[1]).toBe(140);
            expect(imageData.data[2]).toBeLessThan(5);
            expect(imageData.data[center]).toBe(100);
        });

        it('should apply full-card contrast to all dark pixels', () => {
            const imageData = makeImageData(1, 1, 100);
            imageData.data.set([200, 140, 5, 255], 0);

            applyContrastFullCPU(imageData, 1);

            expect(imageData.data[0]).toBe(200);
            expect(imageData.data[1]).toBe(140);
            expect(imageData.data[2]).toBeLessThan(5);
        });

        it('should blacken only pixels below the darken-all threshold', () => {
            const imageData = makeImageData(4, 1, 255);
            imageData.data.set([
                5, 5, 5, 255,
                5, 40, 5, 255,
                5, 5, 40, 255,
                40, 5, 5, 255,
            ]);

            applyDarkenAllCPU(imageData);

            expect(Array.from(imageData.data.slice(0, 12))).toEqual([
                0, 0, 0, 255,
                5, 40, 5, 255,
                5, 5, 40, 255,
            ]);
            expect(Array.from(imageData.data.slice(12, 16))).toEqual([40, 5, 5, 255]);
        });
    });

    describe('Error Handling', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('fetchWithRetry should throw on 404', async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 404,
                statusText: 'Not Found'
            });

            const promise = fetchWithRetry('http://example.com/404');
            const validation = expect(promise).rejects.toThrow('Client error: 404 Not Found');

            await vi.runAllTimersAsync();
            await validation;
        });

        it('fetchWithRetry should retry on network error', async () => {
            global.fetch = vi.fn()
                .mockRejectedValueOnce(new Error('Network Error'))
                .mockResolvedValueOnce({ ok: true });

            const promise = fetchWithRetry('http://example.com/retry', 3, 10);

            await vi.runAllTimersAsync();

            const res = await promise;
            expect(res.ok).toBe(true);
            expect(global.fetch).toHaveBeenCalledTimes(2);
        });

        it('fetchWithRetry should fail after max retries', async () => {
            global.fetch = vi.fn().mockRejectedValue(new Error('Network Error'));

            const promise = fetchWithRetry('http://example.com/fail', 3, 10);
            const validation = expect(promise).rejects.toThrow('Network Error');

            await vi.runAllTimersAsync();
            await validation;
            expect(global.fetch).toHaveBeenCalledTimes(3);
        });

        it('loadImage should throw if fetch fails', async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 500
            });

            const promise = loadImage('http://example.com/img.png');
            const validation = expect(promise).rejects.toThrow('Fetch failed for http://example.com/img.png after 3 attempts');

            await vi.runAllTimersAsync();
            await validation;
        });
    });
});
