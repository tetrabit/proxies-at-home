import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

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
import { useSettingsStore } from '@/store/settings';
import { overridesToRenderParams } from './cardCanvasWorker';
import { enforceEffectCacheLimits } from './cacheUtils';
import { getEffectCacheEntry, getEffectProcessor, preRenderEffect, queueBulkPreRender, setEffectCacheEntryWithDpi } from './effectCache';

describe('effectCache', () => {
    function pngBlob(width: number, height: number): Blob {
        const header = new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
            width >>> 24, width >>> 16, width >>> 8, width,
            height >>> 24, height >>> 16, height >>> 8, height,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ]);
        return new Blob([header], { type: 'image/png' });
    }

    function jpegBlob(width: number, height: number): Blob {
        return new Blob([new Uint8Array([
            0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08,
            height >>> 8, height, width >>> 8, width,
        ])], { type: 'image/jpeg' });
    }

    function webpBlob(width: number, height: number): Blob {
        return webpChunkBlob('VP8X', [
            0x00, 0x00, 0x00, 0x00,
            (width - 1) & 0xff, (width - 1) >>> 8, (width - 1) >>> 16,
            (height - 1) & 0xff, (height - 1) >>> 8, (height - 1) >>> 16,
        ]);
    }

    function webpChunkBlob(chunkType: string, payload: readonly number[], declaredRiffSize?: number): Blob {
        const paddedPayloadLength = payload.length + (payload.length % 2);
        const riffSize = declaredRiffSize ?? 4 + 8 + paddedPayloadLength;
        return new Blob([new Uint8Array([
            0x52, 0x49, 0x46, 0x46, riffSize & 0xff, (riffSize >>> 8) & 0xff, (riffSize >>> 16) & 0xff, riffSize >>> 24,
            0x57, 0x45, 0x42, 0x50,
            ...Array.from(chunkType, character => character.charCodeAt(0)),
            payload.length & 0xff, (payload.length >>> 8) & 0xff, (payload.length >>> 16) & 0xff, payload.length >>> 24,
            ...payload,
            ...(payload.length % 2 ? [0x00] : []),
        ])], { type: 'image/webp' });
    }

    const validWebpDimensionChunks = [
        ['VP8X', [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]],
        ['VP8 ', [0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00]],
        ['VP8L', [0x2f, 0x00, 0x00, 0x00, 0x00]],
    ] as const;

    function gifBlob(width: number, height: number): Blob {
        return new Blob([new Uint8Array([
            0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
            width & 0xff, width >>> 8, height & 0xff, height >>> 8,
        ])], { type: 'image/gif' });
    }

    function bmpBlob(width: number, height: number): Blob {
        const header = new Uint8Array(54);
        header.set([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00, 0x28, 0x00, 0x00, 0x00]);
        new DataView(header.buffer).setInt32(18, width, true);
        new DataView(header.buffer).setInt32(22, height, true);
        return new Blob([header], { type: 'image/bmp' });
    }

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(useSettingsStore.getState).mockReturnValue({ dpi: 300 } as ReturnType<typeof useSettingsStore.getState>);
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

        it('stores explicit-DPI cache entries with stable keys and enforces limits', async () => {
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
            expect(enforceEffectCacheLimits).toHaveBeenCalledTimes(1);
        });

        it('serializes explicit-DPI cache enforcement across concurrent writes', async () => {
            let releaseFirstEnforcement: (() => void) | undefined;
            vi.mocked(enforceEffectCacheLimits).mockImplementationOnce(() => new Promise(resolve => {
                releaseFirstEnforcement = () => resolve(0);
            }));

            const first = setEffectCacheEntryWithDpi('image-1', { brightness: 1 }, new Blob(['first']), 600);
            const second = setEffectCacheEntryWithDpi('image-2', { brightness: 1 }, new Blob(['second']), 600);

            await Promise.resolve();
            await Promise.resolve();
            expect(enforceEffectCacheLimits).toHaveBeenCalledTimes(1);

            releaseFirstEnforcement?.();
            await expect(first).resolves.toBeUndefined();
            expect(enforceEffectCacheLimits).toHaveBeenCalledTimes(2);
            await expect(second).resolves.toBeUndefined();
        });

        it('reports explicit-DPI quota write failures without attempting eviction', async () => {
            vi.mocked(db.effectCache.put).mockRejectedValueOnce(new Error('QuotaExceededError'));

            await expect(
                setEffectCacheEntryWithDpi('image-1', { brightness: 1 }, new Blob(['rendered']), 600)
            ).rejects.toThrow('QuotaExceededError');

            expect(enforceEffectCacheLimits).not.toHaveBeenCalled();
        });
    });

    describe('pre-render queueing', () => {
        beforeEach(() => {
            vi.clearAllMocks();
            const processor = getEffectProcessor();
            if (vi.isMockFunction(processor.process)) {
                (processor.process as typeof processor.process & { mockRestore: () => void }).mockRestore();
            }
            processor.destroy();
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

            await vi.waitFor(() => expect(processor.process).toHaveBeenCalledTimes(1));
        });

        it('coalesces queued and active equivalent renditions while delivering completion to every card', async () => {
            const processor = getEffectProcessor();
            let resolveRender: ((blob: Blob) => void) | undefined;
            const rendered = new Blob(['rendered']);
            vi.spyOn(processor, 'process').mockImplementation(() => new Promise(resolve => {
                resolveRender = resolve;
            }));
            const source = new Blob(['export']);

            const first = preRenderEffect(
                { uuid: 'card-1', name: 'First copy', order: 0, isUserUpload: false, imageId: 'image-1', overrides: { brightness: 1, contrast: 2 } },
                source
            );
            const second = preRenderEffect(
                { uuid: 'card-2', name: 'Second copy', order: 1, isUserUpload: false, imageId: 'image-1', overrides: { contrast: 2, brightness: 1, saturation: undefined } },
                source
            );

            await vi.waitFor(() => expect(processor.process).toHaveBeenCalledTimes(1));
            expect(overridesToRenderParams).toHaveBeenCalledTimes(1);

            resolveRender?.(rendered);
            await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
            expect(db.effectCache.put).toHaveBeenCalledTimes(1);
        });

        it('does not coalesce different image revisions, DPIs, or canonical overrides', async () => {
            const processor = getEffectProcessor();
            const resolveRenders: Array<(blob: Blob) => void> = [];
            vi.spyOn(processor, 'process').mockImplementation(() => new Promise(resolve => {
                resolveRenders.push(resolve);
            }));
            const card = { uuid: 'card-1', name: 'Adjusted', order: 0, isUserUpload: false, imageId: 'image-1', overrides: { brightness: 1 } };
            const source = new Blob(['revision-one']);

            const first = preRenderEffect(card, source);
            const differentOverrides = preRenderEffect({ ...card, uuid: 'card-2', overrides: { brightness: 2 } }, source);
            const differentRevision = preRenderEffect({ ...card, uuid: 'card-3' }, new Blob(['revision-two']));
            vi.mocked(useSettingsStore.getState).mockReturnValue({ dpi: 1200 } as ReturnType<typeof useSettingsStore.getState>);
            const differentDpi = preRenderEffect({ ...card, uuid: 'card-4' }, source);

            await vi.waitFor(() => expect(processor.process).toHaveBeenCalledTimes(4));
            resolveRenders.forEach(resolve => resolve(new Blob(['rendered'])));
            await Promise.all([first, differentOverrides, differentRevision, differentDpi]);
        });

        it('clears a rejected shared rendition so the next request retries', async () => {
            const processor = getEffectProcessor();
            const render = vi.spyOn(processor, 'process')
                .mockRejectedValueOnce(new Error('render failed'))
                .mockResolvedValueOnce(new Blob(['retried']));
            const source = new Blob(['export']);
            const card = { uuid: 'card-1', name: 'Adjusted', order: 0, isUserUpload: false, imageId: 'image-1', overrides: { brightness: 1 } };
            const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            await Promise.all([
                preRenderEffect(card, source),
                preRenderEffect({ ...card, uuid: 'card-2' }, source),
            ]);
            await preRenderEffect(card, source);

            expect(render).toHaveBeenCalledTimes(2);
            error.mockRestore();
        });

        it('clears a destroyed shared rendition so a later request can render', async () => {
            const processor = getEffectProcessor();
            const source = new Blob(['export']);
            const card = { uuid: 'card-1', name: 'Adjusted', order: 0, isUserUpload: false, imageId: 'image-1', overrides: { brightness: 1 } };
            global.Worker = class {
                postMessage = vi.fn();
                terminate = vi.fn();
                onmessage: ((e: MessageEvent) => void) | null = null;
                onerror: ((e: ErrorEvent) => void) | null = null;
            } as unknown as typeof Worker;
            global.createImageBitmap = vi.fn().mockImplementation(() => new Promise(() => undefined));
            const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            const first = preRenderEffect(card, source);
            const second = preRenderEffect({ ...card, uuid: 'card-2' }, source);
            processor.destroy();
            await Promise.all([first, second]);
            const render = vi.spyOn(processor, 'process').mockResolvedValueOnce(new Blob(['after-destroy']));
            await preRenderEffect(card, source);

            expect(render).toHaveBeenCalledTimes(1);
            error.mockRestore();
        });

        it('admits distinct content hashes one Blob read at a time before worker rendering', async () => {
            const processor = getEffectProcessor();
            const render = vi.spyOn(processor, 'process').mockResolvedValue(new Blob(['rendered']));
            let activeReads = 0;
            let peakActiveReads = 0;
            const reads = Array.from({ length: 3 }, (_, index) => {
                let release: (() => void) | undefined;
                const source = new Blob([`source-${index}`]);
                const chunk = {
                    arrayBuffer: vi.fn(() => new Promise<ArrayBuffer>(resolve => {
                        activeReads++;
                        peakActiveReads = Math.max(peakActiveReads, activeReads);
                        release = () => {
                            activeReads--;
                            resolve(new Uint8Array([index]).buffer);
                        };
                    })),
                };
                vi.spyOn(source, 'slice').mockReturnValue(chunk as unknown as Blob);
                return { source, chunk, release: () => release?.() };
            });

            queueBulkPreRender(reads.map(({ source }, index) => ({
                card: { uuid: `card-${index}`, name: 'Adjusted', order: index, isUserUpload: false, imageId: `image-${index}`, overrides: { brightness: 1 } },
                exportBlob: source,
            })));

            await vi.waitFor(() => expect(reads[0].chunk.arrayBuffer).toHaveBeenCalledTimes(1));
            expect(reads[1].chunk.arrayBuffer).not.toHaveBeenCalled();
            expect(reads[2].chunk.arrayBuffer).not.toHaveBeenCalled();
            expect(peakActiveReads).toBe(1);

            reads[0].release();
            await vi.waitFor(() => expect(reads[1].chunk.arrayBuffer).toHaveBeenCalledTimes(1));
            expect(reads[2].chunk.arrayBuffer).not.toHaveBeenCalled();
            expect(peakActiveReads).toBe(1);

            reads[1].release();
            await vi.waitFor(() => expect(reads[2].chunk.arrayBuffer).toHaveBeenCalledTimes(1));
            reads[2].release();
            await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(3));
            expect(peakActiveReads).toBe(1);
        });

        it('releases failed content-hash admission so a retry and queued work can run', async () => {
            const processor = getEffectProcessor();
            const render = vi.spyOn(processor, 'process').mockResolvedValue(new Blob(['rendered']));
            const retrySource = new Blob(['retry-source']);
            const retryRead = vi.fn()
                .mockRejectedValueOnce(new Error('hash read failed'))
                .mockResolvedValueOnce(new Uint8Array([1]).buffer);
            vi.spyOn(retrySource, 'slice').mockReturnValue({ arrayBuffer: retryRead } as unknown as Blob);
            const queuedSource = new Blob(['queued-source']);
            const queuedRead = vi.fn().mockResolvedValue(new Uint8Array([2]).buffer);
            vi.spyOn(queuedSource, 'slice').mockReturnValue({ arrayBuffer: queuedRead } as unknown as Blob);
            const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            const retryCard = { uuid: 'retry-card', name: 'Adjusted', order: 0, isUserUpload: false, imageId: 'retry-image', overrides: { brightness: 1 } };

            queueBulkPreRender([
                { card: retryCard, exportBlob: retrySource },
                { card: { ...retryCard, uuid: 'queued-card', imageId: 'queued-image' }, exportBlob: queuedSource },
            ]);

            await vi.waitFor(() => expect(queuedRead).toHaveBeenCalledTimes(1));
            await expect(preRenderEffect(retryCard, retrySource)).resolves.toBeUndefined();
            expect(retryRead).toHaveBeenCalledTimes(2);
            await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
            error.mockRestore();
        });

        it('invalidates active and queued content hashes on destroy without stale rendering', async () => {
            const processor = getEffectProcessor();
            const render = vi.spyOn(processor, 'process').mockResolvedValue(new Blob(['rendered']));
            let releaseActiveRead: (() => void) | undefined;
            const activeSource = new Blob(['active-source']);
            vi.spyOn(activeSource, 'slice').mockReturnValue({
                arrayBuffer: vi.fn(() => new Promise<ArrayBuffer>(resolve => {
                    releaseActiveRead = () => resolve(new Uint8Array([1]).buffer);
                })),
            } as unknown as Blob);
            const queuedSource = new Blob(['queued-source']);
            const queuedRead = vi.fn().mockResolvedValue(new Uint8Array([2]).buffer);
            vi.spyOn(queuedSource, 'slice').mockReturnValue({ arrayBuffer: queuedRead } as unknown as Blob);
            const card = { uuid: 'card-1', name: 'Adjusted', order: 0, isUserUpload: false, imageId: 'image-1', overrides: { brightness: 1 } };
            const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            const active = preRenderEffect(card, activeSource);
            const queued = preRenderEffect({ ...card, uuid: 'card-2', imageId: 'image-2' }, queuedSource);
            await vi.waitFor(() => expect(activeSource.slice).toHaveBeenCalledTimes(1));
            processor.destroy();
            await expect(Promise.all([active, queued])).resolves.toEqual([undefined, undefined]);

            releaseActiveRead?.();
            await Promise.resolve();
            await Promise.resolve();
            expect(queuedRead).not.toHaveBeenCalled();
            expect(render).not.toHaveBeenCalled();

            await expect(preRenderEffect({ ...card, uuid: 'card-3', imageId: 'image-3' }, new Blob(['fresh-source']))).resolves.toBeUndefined();
            expect(render).toHaveBeenCalledTimes(1);
            error.mockRestore();
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
            const existingProcessor = getEffectProcessor();
            if (vi.isMockFunction(existingProcessor.process)) {
                (existingProcessor.process as typeof existingProcessor.process & { mockRestore: () => void }).mockRestore();
            }
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
                width: 1,
                height: 1,
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
            const p = processor.process(pngBlob(1, 1), {} as RenderParams);

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

            const p = processor.process(pngBlob(1, 1), {} as RenderParams);

            vi.advanceTimersByTime(100);
            await expect(p).rejects.toThrow("Worker crashed: Crash!");
        });

        it('defers bitmap decode until a worker admission slot is available', async () => {
            const processor = getEffectProcessor();
            const workers: Array<{
                postMessage: ReturnType<typeof vi.fn>;
                terminate: ReturnType<typeof vi.fn>;
                onmessage: ((e: MessageEvent) => void) | null;
                onerror: ((e: ErrorEvent) => void) | null;
            }> = [];

            global.Worker = class {
                postMessage = vi.fn();
                terminate = vi.fn();
                onmessage: ((e: MessageEvent) => void) | null = null;
                onerror: ((e: ErrorEvent) => void) | null = null;

                constructor() {
                    workers.push(this);
                }
            } as unknown as typeof Worker;
            Object.defineProperty(processor, 'maxWorkers', { configurable: true, value: 1 });

            const first = processor.process(pngBlob(1, 1), {} as RenderParams);
            const second = processor.process(pngBlob(1, 1), {} as RenderParams);

            await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1));

            await Promise.resolve();
            const firstTaskId = workers[0].postMessage.mock.calls[0][0].taskId as string;
            workers[0].onmessage?.({ data: { taskId: firstTaskId, blob: new Blob(['first']) } } as MessageEvent);

            await expect(first).resolves.toBeInstanceOf(Blob);
            await Promise.resolve();
            expect(createImageBitmap).toHaveBeenCalledTimes(2);

            const secondTaskId = workers[0].postMessage.mock.calls[1][0].taskId as string;
            workers[0].onmessage?.({ data: { taskId: secondTaskId, blob: new Blob(['second']) } } as MessageEvent);
            await expect(second).resolves.toBeInstanceOf(Blob);
        });

        it('keeps mixed-size decoded reservations within budget even when workers are free', async () => {
            const processor = getEffectProcessor();
            const workers: Array<{
                postMessage: ReturnType<typeof vi.fn>;
                terminate: ReturnType<typeof vi.fn>;
                onmessage: ((e: MessageEvent) => void) | null;
                onerror: ((e: ErrorEvent) => void) | null;
            }> = [];
            global.Worker = class {
                postMessage = vi.fn();
                terminate = vi.fn();
                onmessage: ((e: MessageEvent) => void) | null = null;
                onerror: ((e: ErrorEvent) => void) | null = null;
                constructor() {
                    workers.push(this);
                }
            } as unknown as typeof Worker;
            Object.defineProperty(processor, 'maxWorkers', { configurable: true, value: 4 });
            global.createImageBitmap = vi.fn()
                .mockResolvedValueOnce({ width: 4000, height: 4000, close: vi.fn() })
                .mockResolvedValueOnce({ width: 2000, height: 2000, close: vi.fn() })
                .mockResolvedValueOnce({ width: 2000, height: 2000, close: vi.fn() });

            const large = processor.process(pngBlob(4000, 4000), {} as RenderParams);
            const firstSmall = processor.process(pngBlob(2000, 2000), {} as RenderParams);
            const deferredSmall = processor.process(pngBlob(2000, 2000), {} as RenderParams);

            await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(2));
            expect(workers).toHaveLength(2);

            const largeTaskId = workers[0].postMessage.mock.calls[0][0].taskId as string;
            workers[0].onmessage?.({ data: { taskId: largeTaskId, blob: new Blob(['large']) } } as MessageEvent);
            await expect(large).resolves.toBeInstanceOf(Blob);

            await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(3));
            const firstSmallTaskId = workers[1].postMessage.mock.calls[0][0].taskId as string;
            workers[1].onmessage?.({ data: { taskId: firstSmallTaskId, blob: new Blob(['small']) } } as MessageEvent);
            const deferredSmallTaskId = workers[0].postMessage.mock.calls[1][0].taskId as string;
            workers[0].onmessage?.({ data: { taskId: deferredSmallTaskId, blob: new Blob(['small']) } } as MessageEvent);

            await expect(Promise.all([firstSmall, deferredSmall])).resolves.toEqual([expect.any(Blob), expect.any(Blob)]);
        });

        it('uses raw-orientation decoding after admitting PNG, JPEG, WebP, GIF, and BMP headers', async () => {
            const processor = getEffectProcessor();
            const sources = [
                pngBlob(100, 101),
                jpegBlob(102, 103),
                webpBlob(104, 105),
                gifBlob(106, 107),
                bmpBlob(108, 109),
            ];

            for (const source of sources) {
                const dimensions = source === sources[0] ? [100, 101]
                    : source === sources[1] ? [102, 103]
                        : source === sources[2] ? [104, 105]
                            : source === sources[3] ? [106, 107]
                                : [108, 109];
                global.createImageBitmap = vi.fn().mockResolvedValue({
                    width: dimensions[0],
                    height: dimensions[1],
                    close: vi.fn(),
                });

                const rendered = processor.process(source, {} as RenderParams);
                await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledWith(source, { imageOrientation: 'none' }));
                await expect(rendered).resolves.toBeInstanceOf(Blob);
            }
        });

        it.each([
            ['PNG IHDR with an invalid length', new Blob([new Uint8Array([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                0x00, 0x00, 0x00, 0x0c, 0x49, 0x48, 0x44, 0x52,
                0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            ])])],
            ['truncated JPEG start-of-frame', new Blob([new Uint8Array([
                0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x01,
            ])])],
            ['WebP chunk length overflow', new Blob([new Uint8Array([
                0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
                0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58,
                0xff, 0xff, 0xff, 0xff,
            ])])],
            ['truncated GIF logical screen', new Blob([new Uint8Array([
                0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01,
            ])])],
            ['BMP without a complete BITMAPINFOHEADER', new Blob([new Uint8Array([
                0x42, 0x4d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
            ])])],
        ])('rejects %s before bitmap decode', async (_description, source) => {
            const processor = getEffectProcessor();
            const rejected = processor.process(source, {} as RenderParams);
            const error = rejected.then(() => undefined, reason => reason);

            await vi.waitFor(async () => {
                await expect(error).resolves.toMatchObject({
                    message: 'Unable to determine image dimensions from the first 524288 bytes',
                });
            });
            expect(createImageBitmap).not.toHaveBeenCalled();
        });

        it('rejects VP8X chunks appended outside a declared-short RIFF container before bitmap decode', async () => {
            const processor = getEffectProcessor();
            const source = new Blob([new Uint8Array([
                0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
                0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            ])]);

            const rejected = processor.process(source, {} as RenderParams);
            const error = rejected.then(() => undefined, reason => reason);
            await vi.waitFor(async () => {
                await expect(error).resolves.toMatchObject({
                    message: 'Unable to determine image dimensions from the first 524288 bytes',
                });
            });
            expect(createImageBitmap).not.toHaveBeenCalled();
        });

        it.each(validWebpDimensionChunks)('admits a bounded, declared WebP %s dimensions chunk', async (chunkType, payload) => {
            const processor = getEffectProcessor();
            const source = webpChunkBlob(chunkType, payload);
            const rendition = processor.process(source, {} as RenderParams);

            await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledWith(source, { imageOrientation: 'none' }));
            await expect(rendition).resolves.toBeInstanceOf(Blob);
        });

        it.each(validWebpDimensionChunks)('rejects a declared-short RIFF with appended %s dimensions before bitmap decode', async (chunkType, payload) => {
            const processor = getEffectProcessor();
            const rejected = processor.process(webpChunkBlob(chunkType, payload, 4), {} as RenderParams);
            const error = rejected.then(() => undefined, reason => reason);

            await vi.waitFor(async () => {
                await expect(error).resolves.toMatchObject({
                    message: 'Unable to determine image dimensions from the first 524288 bytes',
                });
            });
            expect(createImageBitmap).not.toHaveBeenCalled();
        });

        it.each([
            ['a chunk crossing the declared RIFF boundary', webpChunkBlob('VP8X', validWebpDimensionChunks[0][1], 21)],
            ['an odd-length chunk whose padding crosses the declared RIFF boundary', webpChunkBlob('VP8L', validWebpDimensionChunks[2][1], 17)],
        ])('rejects %s before bitmap decode', async (_description, source) => {
            const processor = getEffectProcessor();
            const rejected = processor.process(source, {} as RenderParams);
            const error = rejected.then(() => undefined, reason => reason);

            await vi.waitFor(async () => {
                await expect(error).resolves.toMatchObject({
                    message: 'Unable to determine image dimensions from the first 524288 bytes',
                });
            });
            expect(createImageBitmap).not.toHaveBeenCalled();
        });

        it('rejects a declared RIFF container truncated before its VP8X payload ends', async () => {
            const source = new Blob([new Uint8Array([
                0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
                0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00,
            ])], { type: 'image/webp' });
            const processor = getEffectProcessor();
            const rejected = processor.process(source, {} as RenderParams);
            const error = rejected.then(() => undefined, reason => reason);

            await vi.waitFor(async () => {
                await expect(error).resolves.toMatchObject({
                    message: 'Unable to determine image dimensions from the first 524288 bytes',
                });
            });
            expect(createImageBitmap).not.toHaveBeenCalled();
        });

        it('admits bounded VP8X dimensions from a valid RIFF container larger than the header probe', async () => {
            const containerLength = (513 * 1024);
            const bytes = new Uint8Array(containerLength);
            bytes.set([0x52, 0x49, 0x46, 0x46], 0);
            bytes.set([0x57, 0x45, 0x42, 0x50], 8);
            new DataView(bytes.buffer).setUint32(4, containerLength - 8, true);
            bytes.set([
                0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x4a, 0x55, 0x4e, 0x4b,
            ], 12);
            new DataView(bytes.buffer).setUint32(34, containerLength - 38, true);
            const source = new Blob([bytes], { type: 'image/webp' });
            const processor = getEffectProcessor();
            const rendition = processor.process(source, {} as RenderParams);

            await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledWith(source, { imageOrientation: 'none' }));
            await expect(rendition).resolves.toBeInstanceOf(Blob);
        });

        it.each([
            ['a RIFF size smaller than the mandatory WEBP form', new Blob([new Uint8Array([
                0x52, 0x49, 0x46, 0x46, 0x03, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
            ])], { type: 'image/webp' })],
            ['a RIFF size extending beyond the actual Blob length', new Blob([new Uint8Array([
                0x52, 0x49, 0x46, 0x46, 0xff, 0xff, 0xff, 0xff, 0x57, 0x45, 0x42, 0x50,
            ])], { type: 'image/webp' })],
        ])('rejects %s before bitmap decode', async (_description, source) => {
            const processor = getEffectProcessor();
            const rejected = processor.process(source, {} as RenderParams);
            const error = rejected.then(() => undefined, reason => reason);

            await vi.waitFor(async () => {
                await expect(error).resolves.toMatchObject({
                    message: 'Unable to determine image dimensions from the first 524288 bytes',
                });
            });
            expect(createImageBitmap).not.toHaveBeenCalled();
        });

        it('rejects dimensions that lie beyond the bounded probe of an otherwise valid large RIFF container', async () => {
            const firstChunkPayloadLength = 512 * 1024;
            const vp8xOffset = 20 + firstChunkPayloadLength;
            const bytes = new Uint8Array(vp8xOffset + 18);
            bytes.set([0x52, 0x49, 0x46, 0x46], 0);
            bytes.set([0x57, 0x45, 0x42, 0x50, 0x4a, 0x55, 0x4e, 0x4b], 8);
            new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
            new DataView(bytes.buffer).setUint32(16, firstChunkPayloadLength, true);
            bytes.set([
                0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            ], vp8xOffset);
            const processor = getEffectProcessor();
            const rejected = processor.process(new Blob([bytes], { type: 'image/webp' }), {} as RenderParams);
            const error = rejected.then(() => undefined, reason => reason);

            await vi.waitFor(async () => {
                await expect(error).resolves.toMatchObject({
                    message: 'Unable to determine image dimensions from the first 524288 bytes',
                });
            });
            expect(createImageBitmap).not.toHaveBeenCalled();
        });

        it('uses dimensions from a bounded header probe rather than encoded Blob size', async () => {
            const processor = getEffectProcessor();
            const source = pngBlob(1, 1);
            Object.defineProperty(source, 'size', { value: 3 * 1024 * 1024 * 1024 });
            const slice = vi.spyOn(source, 'slice');

            const rendition = processor.process(source, {} as RenderParams);
            await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledWith(source, { imageOrientation: 'none' }));
            expect(slice).toHaveBeenCalledWith(0, 512 * 1024);
            await vi.waitFor(() => expect(rendition).resolves.toBeInstanceOf(Blob));
        });

        it('rejects a single oversized image without blocking later work', async () => {
            const processor = getEffectProcessor();
            const workers: Array<{
                postMessage: ReturnType<typeof vi.fn>;
                terminate: ReturnType<typeof vi.fn>;
                onmessage: ((e: MessageEvent) => void) | null;
                onerror: ((e: ErrorEvent) => void) | null;
            }> = [];
            global.Worker = class {
                postMessage = vi.fn();
                terminate = vi.fn();
                onmessage: ((e: MessageEvent) => void) | null = null;
                onerror: ((e: ErrorEvent) => void) | null = null;
                constructor() {
                    workers.push(this);
                }
            } as unknown as typeof Worker;
            global.createImageBitmap = vi.fn().mockResolvedValue({ width: 1000, height: 1000, close: vi.fn() });

            const oversized = processor.process(pngBlob(5000, 5000), {} as RenderParams);
            const oversizedError = oversized.then(() => undefined, error => error);
            const admitted = processor.process(pngBlob(1000, 1000), {} as RenderParams);

            await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1));
            await expect(oversizedError).resolves.toMatchObject({
                message: 'Effect decoded surfaces require 300000000 bytes, exceeding the 268435456-byte admission budget',
            });
            expect(workers).toHaveLength(1);
            const admittedTaskId = workers[0].postMessage.mock.calls[0][0].taskId as string;
            workers[0].onmessage?.({ data: { taskId: admittedTaskId, blob: new Blob(['small']) } } as MessageEvent);
            await expect(admitted).resolves.toBeInstanceOf(Blob);
        });

        it('releases decoded-byte admission after a decode failure', async () => {
            const processor = getEffectProcessor();
            Object.defineProperty(processor, 'maxWorkers', { configurable: true, value: 2 });
            let rejectDecode: ((error: Error) => void) | undefined;
            global.createImageBitmap = vi.fn()
                .mockImplementationOnce(() => new Promise<never>((_resolve, reject) => {
                    rejectDecode = reject;
                }))
                .mockResolvedValue({ width: 3400, height: 3400, close: vi.fn() });

            const first = processor.process(pngBlob(3400, 3400), {} as RenderParams);
            const firstError = first.then(() => undefined, error => error);
            const second = processor.process(pngBlob(3400, 3400), {} as RenderParams);

            await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1));
            rejectDecode?.(new Error('decode failed'));
            await expect(firstError).resolves.toMatchObject({ message: 'decode failed' });
            await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(2));
            await expect(second).resolves.toBeInstanceOf(Blob);
        });

        it.each([
            [101, 100],
            [99, 100],
        ])('rejects decoded %ix%i dimensions before canvas allocation and releases the worker for later work', async (width, height) => {
            const processor = getEffectProcessor();
            const workers: Array<{
                postMessage: ReturnType<typeof vi.fn>;
                terminate: ReturnType<typeof vi.fn>;
                onmessage: ((e: MessageEvent) => void) | null;
                onerror: ((e: ErrorEvent) => void) | null;
            }> = [];
            global.Worker = class {
                postMessage = vi.fn();
                terminate = vi.fn();
                onmessage: ((e: MessageEvent) => void) | null = null;
                onerror: ((e: ErrorEvent) => void) | null = null;
                constructor() {
                    workers.push(this);
                }
            } as unknown as typeof Worker;
            const bitmapClose = vi.fn();
            const canvasConstructed = vi.fn();
            global.OffscreenCanvas = class {
                constructor() {
                    canvasConstructed();
                }
                getContext() {
                    return {
                        drawImage: vi.fn(),
                        getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })),
                    };
                }
            } as unknown as typeof OffscreenCanvas;
            global.createImageBitmap = vi.fn()
                .mockResolvedValueOnce({ width, height, close: bitmapClose })
                .mockResolvedValueOnce({ width: 100, height: 100, close: vi.fn() });

            const rejected = processor.process(pngBlob(100, 100), {} as RenderParams);
            const rejectedError = rejected.then(() => undefined, error => error);
            await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1));
            await expect(rejectedError).resolves.toMatchObject({
                message: 'Decoded image dimensions do not match admitted header dimensions',
            });

            expect(canvasConstructed).not.toHaveBeenCalled();
            expect(workers[0].postMessage).not.toHaveBeenCalled();
            expect(bitmapClose).toHaveBeenCalledTimes(1);
            // @ts-expect-error: verifies the physical reservation is released before reuse.
            expect(processor.decodedBytesInFlight).toBe(0);

            const later = processor.process(pngBlob(100, 100), {} as RenderParams);
            const laterError = later.then(() => undefined, error => error);
            await vi.waitFor(() => expect(workers[0].postMessage).toHaveBeenCalledTimes(1));
            processor.destroy();
            await expect(laterError).resolves.toMatchObject({ message: 'Effect processor destroyed' });
            // @ts-expect-error: verifies destroy also clears the second task's reservation.
            expect(processor.decodedBytesInFlight).toBe(0);
            expect(createImageBitmap).toHaveBeenCalledTimes(2);
        });

        it('cancels queued descriptors without decoding them', async () => {
            const processor = getEffectProcessor();
            Object.defineProperty(processor, 'maxWorkers', { configurable: true, value: 1 });
            let resolveDecode: ((bitmap: ImageBitmap) => void) | undefined;
            global.createImageBitmap = vi.fn()
                .mockImplementationOnce(() => new Promise(resolve => {
                    resolveDecode = resolve;
                }))
                .mockResolvedValue({ width: 1, height: 1, close: vi.fn() });

            const active = processor.process(pngBlob(1, 1), {} as RenderParams);
            const activeError = active.then(() => undefined, error => error);
            const queued = processor.process(pngBlob(1, 1), {} as RenderParams);
            const queuedError = queued.then(() => undefined, error => error);
            await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1));
            processor.destroy();
            resolveDecode?.({ width: 100, height: 100, close: vi.fn() } as ImageBitmap);

            await expect(activeError).resolves.toMatchObject({ message: 'Effect processor destroyed' });
            await expect(queuedError).resolves.toMatchObject({ message: 'Effect processor destroyed' });

            const replacement = processor.process(pngBlob(1, 1), {} as RenderParams);
            await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(2));
            await vi.waitFor(() => expect(replacement).resolves.toBeInstanceOf(Blob));
            expect(createImageBitmap).toHaveBeenCalledTimes(2);
        });
    });

    describe('persisted source revision queueing', () => {
        let liveDb: typeof import('../db').db;
        let livePreRenderEffect: typeof preRenderEffect;
        let liveGetEffectProcessor: typeof getEffectProcessor;

        beforeAll(async () => {
            vi.doUnmock('@/db');
            vi.doUnmock('./cacheUtils');
            vi.resetModules();

            ({ db: liveDb } = await import('../db'));
            ({
                getEffectProcessor: liveGetEffectProcessor,
                preRenderEffect: livePreRenderEffect,
            } = await import('./effectCache'));
        });

        beforeEach(() => {
            const processor = liveGetEffectProcessor();
            if (vi.isMockFunction(processor.process)) {
                (processor.process as typeof processor.process & { mockRestore: () => void }).mockRestore();
            }
            processor.destroy();
        });

        it('coalesces independent Dexie reads of one persisted export revision', async () => {
            const imageId = 'r02-dexie-rework-01-same-revision';
            const source = new Blob(['same persisted bytes'], { type: 'image/png' });
            await liveDb.images.put({ id: imageId, refCount: 1, exportBlob: source });

            const firstRead = await liveDb.images.get(imageId);
            const secondRead = await liveDb.images.get(imageId);
            expect(firstRead?.exportBlob).toBeDefined();
            expect(secondRead?.exportBlob).toBeDefined();
            expect(firstRead?.exportBlob).not.toBe(secondRead?.exportBlob);

            let resolveRender: ((blob: Blob) => void) | undefined;
            const processor = liveGetEffectProcessor();
            const render = vi.spyOn(processor, 'process').mockImplementation(() => new Promise(resolve => {
                resolveRender = resolve;
            }));
            const card = {
                name: 'Adjusted',
                order: 0,
                isUserUpload: false,
                imageId,
                overrides: { brightness: 1 },
            };

            const first = livePreRenderEffect({ ...card, uuid: 'r02-card-one' }, firstRead!.exportBlob!);
            const second = livePreRenderEffect({ ...card, uuid: 'r02-card-two' }, secondRead!.exportBlob!);

            await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
            resolveRender?.(new Blob(['rendered']));
            await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
        });

        it('does not coalesce same-size replacement bytes under one persisted image key', async () => {
            const imageId = 'r02-dexie-rework-01-same-size-replacement';
            const firstRevision = new Blob(['0123456789abcdef'], { type: 'image/png' });
            const replacementRevision = new Blob(['fedcba9876543210'], { type: 'image/png' });
            expect(firstRevision.size).toBe(replacementRevision.size);

            const processor = liveGetEffectProcessor();
            const resolveRenders: Array<(blob: Blob) => void> = [];
            const render = vi.spyOn(processor, 'process').mockImplementation(() => new Promise(resolve => {
                resolveRenders.push(resolve);
            }));
            const card = {
                name: 'Adjusted',
                order: 0,
                isUserUpload: false,
                imageId,
                overrides: { brightness: 1 },
            };

            const renders = Promise.all([
                livePreRenderEffect({ ...card, uuid: 'r02-card-old' }, firstRevision),
                livePreRenderEffect({ ...card, uuid: 'r02-card-new' }, replacementRevision),
            ]);

            await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
            resolveRenders.forEach(resolve => resolve(new Blob(['rendered'])));
            await expect(renders).resolves.toEqual([undefined, undefined]);
        });

        it('keeps the newer persisted rendition when an obsolete render settles last', async () => {
            const imageId = 'td-48e40b-superseded-rendition-generation';
            const processor = liveGetEffectProcessor();
            const resolveRenders: Array<(blob: Blob) => void> = [];
            const render = vi.spyOn(processor, 'process').mockImplementation(() => new Promise(resolve => {
                resolveRenders.push(resolve);
            }));
            const card = {
                name: 'Adjusted',
                order: 0,
                isUserUpload: false,
                imageId,
                overrides: { brightness: 1 },
            };

            const obsolete = livePreRenderEffect({ ...card, uuid: 'td-48e40b-obsolete' }, new Blob(['old source revision'], { type: 'image/png' }));
            await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
            const current = livePreRenderEffect({ ...card, uuid: 'td-48e40b-current' }, new Blob(['new source revision'], { type: 'image/png' }));
            await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));

            const currentRendered = new Blob(['new rendered revision'], { type: 'image/png' });
            const obsoleteRendered = new Blob(['old'], { type: 'image/png' });
            expect(currentRendered.size).not.toBe(obsoleteRendered.size);
            resolveRenders[1](currentRendered);
            await expect(current).resolves.toBeUndefined();
            const persistedAfterCurrent = await liveDb.effectCache.filter(entry => entry.key.startsWith(`${imageId}:300:`)).first();
            expect(persistedAfterCurrent).toMatchObject({ size: currentRendered.size });

            resolveRenders[0](obsoleteRendered);
            await expect(obsolete).resolves.toBeUndefined();
            const persistedAfterObsolete = await liveDb.effectCache.filter(entry => entry.key.startsWith(`${imageId}:300:`)).first();
            expect(persistedAfterObsolete).toMatchObject({ size: currentRendered.size });
            await expect(liveDb.effectCache.filter(entry => entry.key.startsWith(`${imageId}:300:`)).count()).resolves.toBe(1);
        });
    });

    describe('explicit-DPI persistence', () => {
        let liveDb: typeof import('../db').db;
        let liveGetEffectCacheEntry: typeof getEffectCacheEntry;
        let liveSetEffectCacheEntryWithDpi: typeof setEffectCacheEntryWithDpi;

        beforeAll(async () => {
            vi.doUnmock('@/db');
            vi.doUnmock('./cacheUtils');
            vi.resetModules();

            ({ db: liveDb } = await import('../db'));
            ({
                getEffectCacheEntry: liveGetEffectCacheEntry,
                setEffectCacheEntryWithDpi: liveSetEffectCacheEntryWithDpi,
            } = await import('./effectCache'));
        });

        it('evicts the older explicit-DPI entry using its stored byte count', async () => {
            const threeGiB = 3 * 1024 * 1024 * 1024;
            const olderBlob = new Blob(['older']);
            const newerBlob = new Blob(['newer']);
            Object.defineProperty(olderBlob, 'size', { value: threeGiB });
            Object.defineProperty(newerBlob, 'size', { value: threeGiB });
            const now = vi.spyOn(Date, 'now')
                .mockReturnValueOnce(1)
                .mockReturnValueOnce(2);

            await liveSetEffectCacheEntryWithDpi('effect-cache-byte-accounting', { brightness: 1 }, olderBlob, 600);
            await liveSetEffectCacheEntryWithDpi('effect-cache-byte-accounting', { brightness: 1 }, newerBlob, 1200);

            now.mockRestore();
            await expect(liveGetEffectCacheEntry('effect-cache-byte-accounting', { brightness: 1 }, 600)).resolves.toBeUndefined();
            await expect(liveGetEffectCacheEntry('effect-cache-byte-accounting', { brightness: 1 }, 1200)).resolves.toBeDefined();
            await expect(liveDb.effectCache.filter(entry => entry.key.startsWith('effect-cache-byte-accounting:1200:')).first())
                .resolves.toMatchObject({ size: threeGiB });
        });

        it('preserves a same-key entry when an explicit-DPI write is rejected for quota', async () => {
            const imageId = 'effect-cache-quota-preserves-prior-entry';
            const overrides = { brightness: 1 };
            const dpi = 600;
            const priorBlob = new Blob(['prior']);

            await liveSetEffectCacheEntryWithDpi(imageId, overrides, priorBlob, dpi);

            const quotaError = new DOMException('Storage quota exceeded', 'QuotaExceededError');
            const put = vi.spyOn(liveDb.effectCache, 'put').mockRejectedValueOnce(quotaError);
            await expect(
                liveSetEffectCacheEntryWithDpi(imageId, overrides, new Blob(['replacement']), dpi)
            ).rejects.toBe(quotaError);
            put.mockRestore();

            await expect(liveGetEffectCacheEntry(imageId, overrides, dpi)).resolves.toBeDefined();
            await expect(liveDb.effectCache.filter(entry => entry.key.startsWith(`${imageId}:${dpi}:`)).first())
                .resolves.toMatchObject({ size: priorBlob.size });
        });
    });
});
