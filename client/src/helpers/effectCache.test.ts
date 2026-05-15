import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RenderParams } from '../components/CardCanvas/types';

// Mock dependencies
vi.mock('@/store/settings', () => ({
    useSettingsStore: {
        getState: vi.fn(() => ({
            dpi: 300,
        })),
    },
}));

vi.mock('@/db', () => ({
    db: {
        effectCache: {
            get: vi.fn().mockResolvedValue(undefined),
            put: vi.fn().mockResolvedValue(undefined),
            update: vi.fn().mockResolvedValue(undefined),
        },
    },
}));

vi.mock('./cacheUtils', () => ({
    enforceEffectCacheLimits: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./cardCanvasWorker', () => ({
    overridesToRenderParams: vi.fn(() => ({})),
}));

// Import after mocks
import { db } from '@/db';
import { overridesToRenderParams } from './cardCanvasWorker';
import { enforceEffectCacheLimits } from './cacheUtils';
import { getEffectCacheEntry, getEffectProcessor, preRenderEffect, queueBulkPreRender, setEffectCacheEntryWithDpi } from './effectCache';

describe('effectCache', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });



    it("should implement Singleton pattern", () => {
        const processor1 = getEffectProcessor();
        const processor2 = getEffectProcessor();
        expect(processor1).toBe(processor2);
    });



    describe('Cache API', () => {
        beforeEach(() => {
            vi.clearAllMocks();
            vi.mocked(db.effectCache.get).mockResolvedValue(undefined);
        });

        it('returns undefined on cache miss and touches entries on cache hit', async () => {
            await expect(getEffectCacheEntry('image-1', { brightness: 1 }, 300)).resolves.toBeUndefined();

            const blob = new Blob(['cached']);
            vi.mocked(db.effectCache.get).mockResolvedValueOnce({
                key: 'cache-key',
                blob,
                size: blob.size,
                cachedAt: 1,
            });

            await expect(getEffectCacheEntry('image-1', { brightness: 1 }, 300)).resolves.toBe(blob);
            expect(db.effectCache.update).toHaveBeenCalledWith(
                expect.stringMatching(/^image-1:300:/),
                expect.objectContaining({ cachedAt: expect.any(Number) })
            );
        });

        it('stores worker cache entries with stable keys and without enforcing limits', async () => {
            const blob = new Blob(['rendered']);

            await setEffectCacheEntryWithDpi(
                'image-1',
                { contrast: undefined, brightness: 2, saturation: 1 },
                blob,
                600
            );

            expect(db.effectCache.put).toHaveBeenCalledWith(
                expect.objectContaining({
                    key: expect.stringMatching(/^image-1:600:/),
                    blob,
                    size: blob.size,
                    cachedAt: expect.any(Number),
                })
            );
            expect(enforceEffectCacheLimits).not.toHaveBeenCalled();
        });
    });

    describe('pre-render queueing', () => {
        beforeEach(() => {
            vi.clearAllMocks();
        });

        it('skips cards without image ids or active overrides', async () => {
            const processor = getEffectProcessor();
            const processSpy = vi.spyOn(processor, 'process');

            await preRenderEffect({ uuid: 'card-1', name: 'No image', order: 0, isUserUpload: false }, new Blob(['a']));
            await preRenderEffect({ uuid: 'card-2', name: 'Defaults', order: 0, isUserUpload: false, imageId: 'image-2', overrides: { brightness: 0 } }, new Blob(['b']));

            expect(processSpy).not.toHaveBeenCalled();
        });

        it('renders active overrides and caches the processed blob', async () => {
            const rendered = new Blob(['rendered']);
            const processor = getEffectProcessor();
            vi.spyOn(processor, 'process').mockResolvedValueOnce(rendered);

            await preRenderEffect(
                { uuid: 'card-1', name: 'Adjusted', order: 0, isUserUpload: false, imageId: 'image-1', overrides: { brightness: 1 } },
                new Blob(['export'])
            );

            expect(overridesToRenderParams).toHaveBeenCalledWith({ brightness: 1 });
            expect(processor.process).toHaveBeenCalledWith(new Blob(['export']), {});
            expect(db.effectCache.put).toHaveBeenCalledWith(expect.objectContaining({ blob: rendered }));
            expect(enforceEffectCacheLimits).toHaveBeenCalledTimes(1);
        });

        it('queues bulk pre-render tasks and ignores empty queues', async () => {
            const processor = getEffectProcessor();
            vi.spyOn(processor, 'process').mockResolvedValue(new Blob(['rendered']));

            queueBulkPreRender([]);
            expect(processor.process).not.toHaveBeenCalled();

            queueBulkPreRender([
                { card: { uuid: 'card-1', name: 'Adjusted', order: 0, isUserUpload: false, imageId: 'image-1', overrides: { brightness: 1 } }, exportBlob: new Blob(['export']) },
            ]);

            await Promise.resolve();
            await Promise.resolve();
            expect(processor.process).toHaveBeenCalledTimes(1);
        });
    });

    describe('EffectProcessor Logic', () => {
        // Type for mock worker constructor
        type MockWorkerClass = new () => {
            postMessage: ReturnType<typeof vi.fn>;
            terminate: ReturnType<typeof vi.fn>;
            onmessage: ((e: MessageEvent) => void) | null;
            onerror: ((e: ErrorEvent) => void) | null;
        };
        let MockWorker: MockWorkerClass;

        beforeEach(() => {
            vi.useFakeTimers();

            // Mock Worker implementation
            MockWorker = class {
                postMessage = vi.fn((data) => {
                    // Simulate async processing
                    Promise.resolve().then(() => {
                        if (this.onmessage) {
                            this.onmessage({ data: { taskId: data.taskId, blob: new Blob(['']), error: null } } as MessageEvent);
                        }
                    });
                });
                terminate = vi.fn();
                onmessage: ((e: MessageEvent) => void) | null = null;
                onerror: ((e: ErrorEvent) => void) | null = null;
                constructor() { }
            };
            global.Worker = MockWorker as unknown as typeof Worker;

            // Mock Browser APIs
            global.createImageBitmap = vi.fn().mockResolvedValue({
                width: 100,
                height: 100,
                close: vi.fn(),
            });

            global.OffscreenCanvas = class {
                constructor() { }
                getContext() {
                    return {
                        drawImage: vi.fn(),
                        getImageData: vi.fn(() => ({
                            data: new Uint8ClampedArray(4),
                            width: 1,
                            height: 1,
                        })),
                    };
                }
            } as unknown as typeof OffscreenCanvas;

            // Access private instance to reset it - using type assertion
            const processor = getEffectProcessor();
            if ('instance' in processor.constructor) {
                processor.destroy();
            }
        });

        afterEach(() => {
            vi.useRealTimers();
            // Clean up
            getEffectProcessor().destroy();
        });

        it("should terminate idle workers after timeout", async () => {
            const processor = getEffectProcessor();

            // Prevent immediate resolution in mock to control flow manually if needed, 
            // but here we just rely on fake timers.

            // Start a task
            const p = processor.process(new Blob(['']), {} as RenderParams);

            // Fast forward processing time
            vi.advanceTimersByTime(100);
            await expect(p).resolves.toBeInstanceOf(Blob);

            // Now worker should be idle and timeout set
            // @ts-expect-error: Accessing private member
            expect(processor.idleWorkers.length).toBe(1);

            // Fast forward idle timeout (e.g. 30s)
            // We need to know the constant value, assuming standard 30s or use constant if imported
            // But constant is from imported module which is not mocked? 
            // Actually I imported real EffectProcessor which imports constants.
            vi.advanceTimersByTime(60000); // 60 seconds should be safe

            // Worker should be terminated
            // @ts-expect-error: Accessing private member
            expect(processor.idleWorkers.length).toBe(0);
        });

        it("should reject pending task on worker error", async () => {
            const processor = getEffectProcessor();

            // Custom mock worker that errors
            global.Worker = class extends (MockWorker as unknown as { new(): Worker }) {
                postMessage = vi.fn((_data: unknown) => {
                    Promise.resolve().then(() => {
                        if (this.onerror) {
                            this.onerror(new ErrorEvent('error', { message: 'Crash!' }));
                        }
                    });
                });
            } as unknown as typeof Worker;

            const p = processor.process(new Blob(['']), {} as RenderParams);

            vi.advanceTimersByTime(100);
            await expect(p).rejects.toThrow("Worker crashed: Crash!");
        });
    });
});
