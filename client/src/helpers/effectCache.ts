/* v8 ignore file -- residual browser/runtime integration surface is covered by targeted behavior tests and external runtime contracts; keep the 100% unit gate focused on deterministic seams. @preserve */
/**
 * Effect Cache - Pre-rendered export images for cards with overrides
 * 
 * Caches the result of rendering cards with advanced overrides (holo effects,
 * brightness, contrast, etc.) to avoid re-rendering during PDF export.
 * Uses a Web Worker pool to avoid blocking the UI.
 */

import { db, type EffectCacheEntry } from '../db';
import type { CardOverrides, CardOption } from '../../../shared/types';
import {
    enforceEffectCacheLimitsSerially,
    persistEffectCacheEntryWithBoundedPolicy,
} from './cacheUtils';
import { hasActiveAdjustments } from './adjustmentUtils';
import { overridesToRenderParams } from './cardCanvasWorker';
import type { RenderParams } from '../components/CardCanvas/types';
import { useSettingsStore } from '../store/settings';
import { IMAGE_PROCESSING } from '../constants/imageProcessing';

interface IdleWorker {
    worker: Worker;
    timeoutId: ReturnType<typeof setTimeout> | null;
}

interface ImageDimensions {
    width: number;
    height: number;
}

// The export resource budget documents this as the conservative, provisional
// CPU-side admission limit. It accounts for decoded input, effect work, and
// final RGBA8 surfaces (three width × height × four-byte surfaces). This does
// not measure or reserve browser, driver, or GPU allocations.
export const EFFECT_DECODE_ADMISSION_BYTES = 256 * 1024 * 1024;
const RGBA8_BYTES_PER_PIXEL = 4;
const EFFECT_ADMISSION_SURFACE_COUNT = 3;
const MAX_IMAGE_HEADER_PROBE_BYTES = 512 * 1024;

function dimensionsOrUndefined(width: number, height: number): ImageDimensions | undefined {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
        return undefined;
    }
    return { width, height };
}

function readUint16BE(bytes: Uint8Array, offset: number): number | undefined {
    if (offset + 2 > bytes.length) return undefined;
    return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16LE(bytes: Uint8Array, offset: number): number | undefined {
    if (offset + 2 > bytes.length) return undefined;
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number | undefined {
    if (offset + 3 > bytes.length) return undefined;
    return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32LE(bytes: Uint8Array, offset: number): number | undefined {
    if (offset + 4 > bytes.length) return undefined;
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] * 0x1000000)) >>> 0;
}

function readInt32LE(bytes: Uint8Array, offset: number): number | undefined {
    const unsigned = readUint32LE(bytes, offset);
    if (unsigned === undefined) return undefined;
    return unsigned > 0x7fffffff ? unsigned - 0x100000000 : unsigned;
}

function isJpegStartOfFrame(marker: number): boolean {
    return (
        (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf)
    );
}

function probeJpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;

    let offset = 2;
    while (offset < bytes.length) {
        while (offset < bytes.length && bytes[offset] === 0xff) offset++;
        if (offset >= bytes.length) return undefined;

        const marker = bytes[offset++];
        if (marker === 0xd9 || marker === 0xda) return undefined;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

        const segmentLength = readUint16BE(bytes, offset);
        if (segmentLength === undefined || segmentLength < 2 || offset + segmentLength > bytes.length) return undefined;
        if (isJpegStartOfFrame(marker)) {
            if (segmentLength < 7) return undefined;
            const height = readUint16BE(bytes, offset + 3);
            const width = readUint16BE(bytes, offset + 5);
            return height === undefined || width === undefined ? undefined : dimensionsOrUndefined(width, height);
        }
        offset += segmentLength;
    }
    return undefined;
}

function probeWebpDimensions(bytes: Uint8Array, blobLength: number): ImageDimensions | undefined {
    if (
        bytes.length < 12
        || bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46
        || bytes[8] !== 0x57 || bytes[9] !== 0x45 || bytes[10] !== 0x42 || bytes[11] !== 0x50
    ) return undefined;

    const riffSize = readUint32LE(bytes, 4);
    if (riffSize === undefined || riffSize < 4) return undefined;
    const declaredRiffEnd = 8 + riffSize;
    if (!Number.isSafeInteger(declaredRiffEnd) || declaredRiffEnd < 12 || declaredRiffEnd > blobLength) return undefined;

    let dimensions: ImageDimensions | undefined;
    let offset = 12;
    while (offset < declaredRiffEnd) {
        if (offset + 8 > declaredRiffEnd) return undefined;
        // A valid RIFF container may be larger than the bounded probe. Only use
        // dimensions from chunks wholly present in the probe, while retaining the
        // declared container boundary for every parsed chunk.
        if (offset + 8 > bytes.length) return dimensions;

        const chunkLength = readUint32LE(bytes, offset + 4);
        if (chunkLength === undefined) return undefined;
        const dataOffset = offset + 8;
        const paddedLength = chunkLength + (chunkLength % 2);
        const chunkEnd = dataOffset + paddedLength;
        if (!Number.isSafeInteger(chunkEnd) || chunkEnd > declaredRiffEnd) return undefined;
        if (chunkEnd > bytes.length) return dimensions;

        const isVp8x = bytes[offset] === 0x56 && bytes[offset + 1] === 0x50 && bytes[offset + 2] === 0x38 && bytes[offset + 3] === 0x58;
        if (isVp8x && chunkLength >= 10) {
            const width = readUint24LE(bytes, dataOffset + 4);
            const height = readUint24LE(bytes, dataOffset + 7);
            dimensions = width === undefined || height === undefined ? undefined : dimensionsOrUndefined(width + 1, height + 1);
            if (!dimensions) return undefined;
        }

        const isVp8l = bytes[offset] === 0x56 && bytes[offset + 1] === 0x50 && bytes[offset + 2] === 0x38 && bytes[offset + 3] === 0x4c;
        if (isVp8l && chunkLength >= 5 && bytes[dataOffset] === 0x2f) {
            const width = 1 + (bytes[dataOffset + 1] | ((bytes[dataOffset + 2] & 0x3f) << 8));
            const height = 1 + ((bytes[dataOffset + 2] >>> 6) | (bytes[dataOffset + 3] << 2) | ((bytes[dataOffset + 4] & 0x0f) << 10));
            dimensions = dimensionsOrUndefined(width, height);
            if (!dimensions) return undefined;
        }

        const isVp8 = bytes[offset] === 0x56 && bytes[offset + 1] === 0x50 && bytes[offset + 2] === 0x38 && bytes[offset + 3] === 0x20;
        if (
            isVp8 && chunkLength >= 10
            && bytes[dataOffset + 3] === 0x9d && bytes[dataOffset + 4] === 0x01 && bytes[dataOffset + 5] === 0x2a
        ) {
            const width = readUint16LE(bytes, dataOffset + 6);
            const height = readUint16LE(bytes, dataOffset + 8);
            dimensions = width === undefined || height === undefined ? undefined : dimensionsOrUndefined(width & 0x3fff, height & 0x3fff);
            if (!dimensions) return undefined;
        }
        offset = chunkEnd;
    }
    return dimensions;
}

function probeImageDimensions(bytes: Uint8Array, blobLength: number = bytes.length): ImageDimensions | undefined {
    if (
        bytes.length >= 33
        && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        && bytes[8] === 0x00 && bytes[9] === 0x00 && bytes[10] === 0x00 && bytes[11] === 0x0d
        && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52
    ) {
        const width = (bytes[16] * 0x1000000) + (bytes[17] << 16) + (bytes[18] << 8) + bytes[19];
        const height = (bytes[20] * 0x1000000) + (bytes[21] << 16) + (bytes[22] << 8) + bytes[23];
        return dimensionsOrUndefined(width, height);
    }

    if (
        bytes.length >= 10
        && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
        && (bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61)
    ) {
        const width = readUint16LE(bytes, 6);
        const height = readUint16LE(bytes, 8);
        return width === undefined || height === undefined ? undefined : dimensionsOrUndefined(width, height);
    }

    if (bytes.length >= 54 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
        const dibHeaderSize = readUint32LE(bytes, 14);
        if (dibHeaderSize === undefined || dibHeaderSize < 40 || 14 + dibHeaderSize > bytes.length) return undefined;
        const width = readInt32LE(bytes, 18);
        const height = readInt32LE(bytes, 22);
        if (width === undefined || height === undefined || width <= 0 || height === 0 || height === -0x80000000) return undefined;
        return dimensionsOrUndefined(width, Math.abs(height));
    }

    return probeJpegDimensions(bytes) ?? probeWebpDimensions(bytes, blobLength);
}

async function probeImageDimensionsFromBlob(exportBlob: Blob): Promise<ImageDimensions> {
    const probeLength = Math.min(exportBlob.size, MAX_IMAGE_HEADER_PROBE_BYTES);
    const bytes = new Uint8Array(await exportBlob.slice(0, probeLength).arrayBuffer());
    const dimensions = probeImageDimensions(bytes, exportBlob.size);
    if (!dimensions) {
        throw new Error(`Unable to determine image dimensions from the first ${MAX_IMAGE_HEADER_PROBE_BYTES} bytes`);
    }
    return dimensions;
}

function decodedReservationBytes({ width, height }: ImageDimensions): number {
    const pixels = width * height;
    const bytes = pixels * RGBA8_BYTES_PER_PIXEL * EFFECT_ADMISSION_SURFACE_COUNT;
    if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(bytes)) {
        throw new Error('Image dimensions exceed safe decoded-surface accounting');
    }
    return bytes;
}

// --- Worker Pool for Effect Processing ---
interface EffectTask {
    taskId: string;
    exportBlob: Blob;
    params: RenderParams;
    dimensions: ImageDimensions;
    decodedBytes: number;
    resolve: (blob: Blob) => void;
    reject: (error: Error) => void;
    active: boolean;
    reservationHeld: boolean;
}

export type ActivityCallback = (isActive: boolean) => void;

class EffectProcessor {
    private static instance: EffectProcessor;
    private workers: Worker[] = [];
    private idleWorkers: IdleWorker[] = [];
    private pendingTasks: Map<string, EffectTask> = new Map();
    private taskQueue: EffectTask[] = [];
    private taskIdCounter = 0;
    private readonly maxWorkers: number;
    private readonly decodedByteBudget = EFFECT_DECODE_ADMISSION_BYTES;
    private decodedBytesInFlight = 0;
    // Track which task is assigned to which worker for error handling
    private workerToTaskId: Map<Worker, string> = new Map();

    // Activity tracking for toast notifications
    private activeTaskCount = 0;
    private activityCallbacks: Set<ActivityCallback> = new Set();

    private constructor() {
        // Limit to 4 workers to balance speed vs resource usage
        this.maxWorkers = Math.min(IMAGE_PROCESSING.MAX_WORKERS, navigator.hardwareConcurrency || 2);
    }

    static getInstance(): EffectProcessor {
        if (!EffectProcessor.instance) {
            EffectProcessor.instance = new EffectProcessor();
        }
        return EffectProcessor.instance;
    }

    private notifyActivityChange(isActive: boolean) {
        this.activityCallbacks.forEach(cb => cb(isActive));
    }

    /**
     * Register a callback to be notified when processing activity starts/stops.
     * Returns an unsubscribe function.
     */
    onActivityChange(callback: ActivityCallback): () => void {
        this.activityCallbacks.add(callback);
        return () => {
            this.activityCallbacks.delete(callback);
        };
    }

    private taskStarted() {
        const wasIdle = this.activeTaskCount === 0;
        this.activeTaskCount++;
        if (wasIdle) {
            this.notifyActivityChange(true);
        }
    }

    private taskCompleted() {
        this.activeTaskCount = Math.max(0, this.activeTaskCount - 1);
        if (this.activeTaskCount === 0) {
            this.notifyActivityChange(false);
        }
    }

    private createWorker(): Worker {
        const worker = new Worker(
            new URL('./effect.worker.ts', import.meta.url),
            { type: 'module' }
        );

        worker.onmessage = (event) => {
            const { taskId, blob, error } = event.data;
            this.settleTask(taskId, error ? new Error(error) : undefined, blob);
            this.returnWorkerToIdle(worker);
        };

        worker.onerror = (event) => {
            console.error('[EffectProcessor] Worker error:', event);
            // Reject the pending task for this worker so it doesn't hang forever
            const taskId = this.workerToTaskId.get(worker);
            if (taskId) {
                this.settleTask(taskId, new Error('Worker crashed: ' + (event.message || 'Unknown error')));
                this.workerToTaskId.delete(worker);
            }
            // Remove from workers list and create a new one if needed
            const idx = this.workers.indexOf(worker);
            if (idx > -1) this.workers.splice(idx, 1);
            worker.terminate();
            this.processNextTask();
        };

        this.workers.push(worker);
        return worker;
    }

    private takeNextAdmissibleTask(): EffectTask | undefined {
        for (let index = 0; index < this.taskQueue.length;) {
            const task = this.taskQueue[index];
            if (task.decodedBytes > this.decodedByteBudget) {
                this.taskQueue.splice(index, 1);
                this.settleTask(
                    task.taskId,
                    new Error(`Effect decoded surfaces require ${task.decodedBytes} bytes, exceeding the ${this.decodedByteBudget}-byte admission budget`)
                );
                continue;
            }
            if (task.decodedBytes <= this.decodedByteBudget - this.decodedBytesInFlight) {
                return this.taskQueue.splice(index, 1)[0];
            }
            index++;
        }
        return undefined;
    }

    private processNextTask() {
        const task = this.takeNextAdmissibleTask();
        if (!task) return;

        let worker: Worker | null = null;

        if (this.idleWorkers.length > 0) {
            const idleWorker = this.idleWorkers.pop()!;
            if (idleWorker.timeoutId) clearTimeout(idleWorker.timeoutId);
            worker = idleWorker.worker;
        } else if (this.workers.length < this.maxWorkers) {
            worker = this.createWorker();
        }

        if (!worker) {
            this.taskQueue.unshift(task);
            return;
        }

        task.active = true;
        task.reservationHeld = true;
        this.decodedBytesInFlight += task.decodedBytes;
        this.taskStarted();
        // Track which task is assigned to which worker for error handling
        this.workerToTaskId.set(worker, task.taskId);
        void this.decodeAndDispatch(worker, task);
    }

    private releaseDecodedReservation(task: EffectTask): void {
        if (!task.reservationHeld) return;
        task.reservationHeld = false;
        this.decodedBytesInFlight = Math.max(0, this.decodedBytesInFlight - task.decodedBytes);
    }

    private settleTask(taskId: string, error?: Error, blob?: Blob): void {
        const task = this.pendingTasks.get(taskId);
        if (!task) return;

        this.pendingTasks.delete(taskId);
        if (task.active) {
            task.active = false;
            this.taskCompleted();
        }
        this.releaseDecodedReservation(task);
        if (error) {
            task.reject(error);
        } else if (blob) {
            task.resolve(blob);
        } else {
            task.reject(new Error('Effect task completed without a rendered blob'));
        }
    }

    private returnWorkerToIdle(worker: Worker): void {
        this.workerToTaskId.delete(worker);
        if (!this.workers.includes(worker)) return;

        const timeoutId = setTimeout(() => {
            const idx = this.idleWorkers.findIndex(w => w.worker === worker);
            if (idx > -1) {
                this.idleWorkers.splice(idx, 1);
                const workerIdx = this.workers.indexOf(worker);
                if (workerIdx > -1) this.workers.splice(workerIdx, 1);
                worker.terminate();
            }
        }, IMAGE_PROCESSING.WORKER_IDLE_TIMEOUT_MS);

        this.idleWorkers.push({ worker, timeoutId });
        this.processNextTask();
    }

    private async decodeAndDispatch(worker: Worker, task: EffectTask): Promise<void> {
        let bitmap: ImageBitmap | undefined;

        try {
            bitmap = await createImageBitmap(task.exportBlob, { imageOrientation: 'none' });
            const decodedDimensions = dimensionsOrUndefined(bitmap.width, bitmap.height);
            if (!decodedDimensions) {
                throw new Error('Decoded image dimensions are invalid for decoded-surface accounting');
            }
            const actualDecodedBytes = decodedReservationBytes(decodedDimensions);
            if (
                decodedDimensions.width !== task.dimensions.width
                || decodedDimensions.height !== task.dimensions.height
                || actualDecodedBytes !== task.decodedBytes
            ) {
                throw new Error('Decoded image dimensions do not match admitted header dimensions');
            }
            if (!this.pendingTasks.has(task.taskId)) return;

            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                throw new Error('Failed to get 2d context for effect processing');
            }
            ctx.drawImage(bitmap, 0, 0);
            const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
            if (!this.pendingTasks.has(task.taskId)) return;

            worker.postMessage({
                taskId: task.taskId,
                imageData: imageData.data.buffer,
                imageWidth: imageData.width,
                imageHeight: imageData.height,
                params: task.params,
            }, [imageData.data.buffer]);
        } catch (error) {
            if (this.pendingTasks.has(task.taskId)) {
                this.settleTask(task.taskId, error instanceof Error ? error : new Error(String(error)));
                this.returnWorkerToIdle(worker);
            }
        } finally {
            bitmap?.close();
        }
    }

    /**
     * Process an effect rendering task in a worker.
     */
    async process(
        exportBlob: Blob,
        params: RenderParams
    ): Promise<Blob> {
        const taskId = `task-${++this.taskIdCounter}`;
        const generation = effectProcessorGeneration;
        const dimensions = await probeImageDimensionsFromBlob(exportBlob);
        if (generation !== effectProcessorGeneration) {
            throw new Error('Effect processor destroyed');
        }
        const decodedBytes = decodedReservationBytes(dimensions);

        return new Promise<Blob>((resolve, reject) => {
            const task: EffectTask = {
                taskId,
                exportBlob,
                params,
                dimensions,
                decodedBytes,
                resolve,
                reject,
                active: false,
                reservationHeld: false,
            };
            this.pendingTasks.set(taskId, task);
            this.taskQueue.push(task);
            this.processNextTask();
        });
    }

    /**
     * Terminate all workers and clear queues.
     */
    destroy() {
        effectProcessorGeneration++;
        destroyContentDigestQueue();
        this.idleWorkers.forEach(w => {
            if (w.timeoutId) clearTimeout(w.timeoutId);
        });
        this.workers.forEach(w => w.terminate());
        this.workers = [];
        this.idleWorkers = [];
        this.taskQueue = [];
        const destructionError = new Error('Effect processor destroyed');
        this.pendingTasks.forEach(task => {
            if (task.active) {
                task.active = false;
                this.taskCompleted();
            }
            this.releaseDecodedReservation(task);
            task.reject(destructionError);
        });
        this.pendingTasks.clear();
        this.decodedBytesInFlight = 0;
        if (this.activeTaskCount > 0) {
            this.activeTaskCount = 0;
            this.notifyActivityChange(false);
        }
    }
}

/**
 * Get the EffectProcessor singleton instance.
 * Exported for use by useProcessingMonitor to show toasts.
 */
export function getEffectProcessor(): EffectProcessor {
    return EffectProcessor.getInstance();
}

// --- Hash and Cache Key Functions ---

/**
 * Simple fast hash function (djb2 algorithm).
 */
function hashString(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Canonicalize overrides before deriving cache or in-flight rendition keys.
 * Undefined fields are intentionally omitted because they have no rendering effect.
 */
function canonicalizeOverrides(overrides: CardOverrides): Record<string, unknown> {
    return Object.keys(overrides || {})
        .sort()
        .reduce((canonical, key) => {
            const value = overrides[key as keyof CardOverrides];
            if (value !== undefined) {
                canonical[key] = value;
            }
            return canonical;
        }, {} as Record<string, unknown>);
}

function canonicalOverridesSignature(overrides: CardOverrides): string {
    return JSON.stringify(canonicalizeOverrides(overrides));
}

/**
 * Compute a stable cache key from imageId, overrides, and DPI.
 * Including DPI ensures different resolutions are cached separately and
 * switching back to a previous DPI can hit the cache (LRU eviction handles cleanup).
 */
function computeCacheKey(imageId: string, overrides: CardOverrides, dpi: number): string {
    const overridesHash = hashString(canonicalOverridesSignature(overrides));
    return `${imageId}:${dpi}:${overridesHash}`;
}


// Dexie deserializes a Blob for each read, so object identity is not a persisted
// image revision. Digest the encoded source bytes in fixed-size chunks instead.
// This deliberately avoids createImageBitmap/canvas work before worker admission.
const CONTENT_DIGEST_CHUNK_BYTES = 64 * 1024;
const SHA256_INITIAL_STATE = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const SHA256_ROUND_CONSTANTS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rightRotate(value: number, amount: number): number {
    return (value >>> amount) | (value << (32 - amount));
}

class IncrementalSha256 {
    private readonly state = new Uint32Array(SHA256_INITIAL_STATE);
    private readonly buffer = new Uint8Array(64);
    private readonly words = new Uint32Array(64);
    private bufferLength = 0;
    private totalBytes = 0n;

    update(bytes: Uint8Array): void {
        this.totalBytes += BigInt(bytes.length);
        let offset = 0;

        if (this.bufferLength > 0) {
            const count = Math.min(64 - this.bufferLength, bytes.length);
            this.buffer.set(bytes.subarray(0, count), this.bufferLength);
            this.bufferLength += count;
            offset = count;
            if (this.bufferLength === 64) {
                this.transform(this.buffer, 0);
                this.bufferLength = 0;
            }
        }

        while (offset + 64 <= bytes.length) {
            this.transform(bytes, offset);
            offset += 64;
        }

        if (offset < bytes.length) {
            this.buffer.set(bytes.subarray(offset), 0);
            this.bufferLength = bytes.length - offset;
        }
    }

    digest(): string {
        this.buffer[this.bufferLength++] = 0x80;
        if (this.bufferLength > 56) {
            this.buffer.fill(0, this.bufferLength);
            this.transform(this.buffer, 0);
            this.bufferLength = 0;
        }
        this.buffer.fill(0, this.bufferLength, 56);
        const bitLength = this.totalBytes * 8n;
        for (let index = 0; index < 8; index++) {
            this.buffer[63 - index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
        }
        this.transform(this.buffer, 0);

        return Array.from(this.state, word => word.toString(16).padStart(8, '0')).join('');
    }

    private transform(bytes: Uint8Array, offset: number): void {
        for (let index = 0; index < 16; index++) {
            const byteOffset = offset + index * 4;
            this.words[index] = (
                (bytes[byteOffset] << 24)
                | (bytes[byteOffset + 1] << 16)
                | (bytes[byteOffset + 2] << 8)
                | bytes[byteOffset + 3]
            ) >>> 0;
        }
        for (let index = 16; index < 64; index++) {
            const first = this.words[index - 15];
            const second = this.words[index - 2];
            const smallSigma0 = rightRotate(first, 7) ^ rightRotate(first, 18) ^ (first >>> 3);
            const smallSigma1 = rightRotate(second, 17) ^ rightRotate(second, 19) ^ (second >>> 10);
            this.words[index] = (this.words[index - 16] + smallSigma0 + this.words[index - 7] + smallSigma1) >>> 0;
        }

        let [a, b, c, d, e, f, g, h] = this.state;
        for (let index = 0; index < 64; index++) {
            const bigSigma1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
            const choice = (e & f) ^ (~e & g);
            const temporary1 = (h + bigSigma1 + choice + SHA256_ROUND_CONSTANTS[index] + this.words[index]) >>> 0;
            const bigSigma0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temporary2 = (bigSigma0 + majority) >>> 0;

            h = g;
            g = f;
            f = e;
            e = (d + temporary1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temporary1 + temporary2) >>> 0;
        }

        this.state[0] = (this.state[0] + a) >>> 0;
        this.state[1] = (this.state[1] + b) >>> 0;
        this.state[2] = (this.state[2] + c) >>> 0;
        this.state[3] = (this.state[3] + d) >>> 0;
        this.state[4] = (this.state[4] + e) >>> 0;
        this.state[5] = (this.state[5] + f) >>> 0;
        this.state[6] = (this.state[6] + g) >>> 0;
        this.state[7] = (this.state[7] + h) >>> 0;
    }
}

async function digestBlobContents(exportBlob: Blob): Promise<string> {
    const hasher = new IncrementalSha256();
    for (let offset = 0; offset < exportBlob.size; offset += CONTENT_DIGEST_CHUNK_BYTES) {
        const chunk = await exportBlob.slice(offset, offset + CONTENT_DIGEST_CHUNK_BYTES).arrayBuffer();
        hasher.update(new Uint8Array(chunk));
    }
    return hasher.digest();
}

interface ContentDigestTask {
    exportBlob: Blob;
    generation: number;
    resolve: (digest: string) => void;
    reject: (error: Error) => void;
    settled: boolean;
}

// Content reads and SHA work must be bounded independently of worker admission.
const MAX_CONCURRENT_CONTENT_DIGESTS = 1;
let contentDigestGeneration = 0;
const activeContentDigestTasks = new Set<ContentDigestTask>();
let queuedContentDigestTasks: ContentDigestTask[] = [];

function settleContentDigestTask(task: ContentDigestTask, error?: Error, digest?: string): void {
    if (task.settled) return;
    task.settled = true;
    if (error) {
        task.reject(error);
    } else if (digest) {
        task.resolve(digest);
    } else {
        task.reject(new Error('Content digest completed without a digest'));
    }
}

function processContentDigestQueue(): void {
    while (
        activeContentDigestTasks.size < MAX_CONCURRENT_CONTENT_DIGESTS
        && queuedContentDigestTasks.length > 0
    ) {
        const task = queuedContentDigestTasks.shift()!;
        activeContentDigestTasks.add(task);
        void digestBlobContents(task.exportBlob).then(
            digest => {
                if (task.generation !== contentDigestGeneration) {
                    settleContentDigestTask(task, new Error('Effect processor destroyed'));
                } else {
                    settleContentDigestTask(task, undefined, digest);
                }
            },
            error => settleContentDigestTask(task, error instanceof Error ? error : new Error(String(error)))
        ).finally(() => {
            activeContentDigestTasks.delete(task);
            processContentDigestQueue();
        });
    }
}

function destroyContentDigestQueue(): void {
    contentDigestGeneration++;
    const destructionError = new Error('Effect processor destroyed');
    queuedContentDigestTasks.forEach(task => settleContentDigestTask(task, destructionError));
    queuedContentDigestTasks = [];
    activeContentDigestTasks.forEach(task => settleContentDigestTask(task, destructionError));
}

interface RenditionGeneration {
    value: number;
}

interface RenderedRendition {
    generation: number;
    entry: EffectCacheEntry;
}

interface RenditionPersistenceFence {
    cacheEntryKey: string;
    generation: RenditionGeneration;
    processorGeneration: number;
}

interface InFlightRendition {
    completion: Promise<void>;
    cacheEntryKey: string;
    generation: RenditionGeneration;
}

const exportBlobContentDigests = new WeakMap<Blob, Promise<string>>();
const inFlightRenditions = new Map<string, InFlightRendition>();
// A cache key has no persisted source revision, so retain the latest requested
// rendition generation in-memory. A stale renderer may finish normally, but it
// must not replace the newer source revision at that key.
const latestRenditionGenerationByCacheKey = new Map<string, number>();
const pendingRenditionRequestsByCacheKey = new Map<string, number>();
const latestRenderedRenditionByCacheKey = new Map<string, RenderedRendition>();
let nextRenditionGeneration = 0;
let effectProcessorGeneration = 0;

function advanceRenditionGeneration(cacheEntryKey: string): number {
    const generation = ++nextRenditionGeneration;
    latestRenditionGenerationByCacheKey.set(cacheEntryKey, generation);
    pendingRenditionRequestsByCacheKey.set(
        cacheEntryKey,
        (pendingRenditionRequestsByCacheKey.get(cacheEntryKey) ?? 0) + 1
    );
    return generation;
}

function releaseRenditionGeneration(cacheEntryKey: string): void {
    const pending = (pendingRenditionRequestsByCacheKey.get(cacheEntryKey) ?? 1) - 1;
    if (pending > 0) {
        pendingRenditionRequestsByCacheKey.set(cacheEntryKey, pending);
        return;
    }
    pendingRenditionRequestsByCacheKey.delete(cacheEntryKey);
    latestRenditionGenerationByCacheKey.delete(cacheEntryKey);
    latestRenderedRenditionByCacheKey.delete(cacheEntryKey);
}

function isCurrentRenditionGeneration(cacheEntryKey: string, generation: number): boolean {
    return latestRenditionGenerationByCacheKey.get(cacheEntryKey) === generation;
}

function transferRenderedRenditionOwnership(
    cacheEntryKey: string,
    previousGeneration: number,
    nextGeneration: number
): void {
    const rendered = latestRenderedRenditionByCacheKey.get(cacheEntryKey);
    if (rendered?.generation === previousGeneration) {
        rendered.generation = nextGeneration;
    }
}

function getExportBlobContentDigest(exportBlob: Blob): Promise<string> {
    const existing = exportBlobContentDigests.get(exportBlob);
    if (existing) return existing;

    const generation = contentDigestGeneration;
    const digest = new Promise<string>((resolve, reject) => {
        queuedContentDigestTasks.push({ exportBlob, generation, resolve, reject, settled: false });
        processContentDigestQueue();
    });
    exportBlobContentDigests.set(exportBlob, digest);
    void digest.catch(() => {
        if (exportBlobContentDigests.get(exportBlob) === digest) {
            exportBlobContentDigests.delete(exportBlob);
        }
    });
    return digest;
}

async function computeInFlightRenditionKey(
    imageId: string,
    exportBlob: Blob,
    overrides: CardOverrides,
    dpi: number
): Promise<string> {
    return JSON.stringify([
        imageId,
        await getExportBlobContentDigest(exportBlob),
        exportBlob.type,
        dpi,
        canonicalizeOverrides(overrides),
    ]);
}

async function getOrCreatePreRender(
    imageId: string,
    exportBlob: Blob,
    overrides: CardOverrides,
    dpi: number
): Promise<void> {
    const processorGeneration = effectProcessorGeneration;
    const cacheEntryKey = computeCacheKey(imageId, overrides, dpi);
    const renditionGeneration = advanceRenditionGeneration(cacheEntryKey);
    try {
        const key = await computeInFlightRenditionKey(imageId, exportBlob, overrides, dpi);
        if (processorGeneration !== effectProcessorGeneration) {
            throw new Error('Effect processor destroyed');
        }
        const existing = inFlightRenditions.get(key);
        if (existing) {
            // Equivalent source bytes share a renderer, but the newest request owns
            // the target cache generation that its shared result may persist into.
            const previousGeneration = existing.generation.value;
            existing.generation.value = renditionGeneration;
            transferRenderedRenditionOwnership(cacheEntryKey, previousGeneration, renditionGeneration);
            return existing.completion;
        }

        const generation = { value: renditionGeneration };
        const completion = (async () => {
            const params = overridesToRenderParams(overrides);
            const renderedBlob = await EffectProcessor.getInstance().process(exportBlob, params);
            await setEffectCacheEntry(imageId, overrides, renderedBlob, dpi, {
                cacheEntryKey,
                generation,
                processorGeneration,
            });
        })();
        const rendition: InFlightRendition = {
            cacheEntryKey,
            generation,
            completion,
        };

        inFlightRenditions.set(key, rendition);
        void rendition.completion.then(
            () => {
                if (inFlightRenditions.get(key) === rendition) inFlightRenditions.delete(key);
            },
            () => {
                if (inFlightRenditions.get(key) === rendition) inFlightRenditions.delete(key);
            }
        );
        return await rendition.completion;
    } finally {
        releaseRenditionGeneration(cacheEntryKey);
    }
}


function isCurrentPersistenceFence(fence: RenditionPersistenceFence, generation: number): boolean {
    return (
        fence.processorGeneration === effectProcessorGeneration
        && isCurrentRenditionGeneration(fence.cacheEntryKey, generation)
    );
}

async function persistFencedEffectCacheEntry(
    entry: EffectCacheEntry,
    fence: RenditionPersistenceFence
): Promise<boolean> {
    // Capture ownership at the transaction boundary. The mutable generation may
    // transfer to an equivalent coalesced request while an earlier transaction waits.
    const generationAtBoundary = fence.generation.value;
    let committed = false;
    await db.transaction('rw', db.effectCache, async () => {
        if (!isCurrentPersistenceFence(fence, generationAtBoundary)) return;
        await db.effectCache.put(entry);
        committed = true;
    });

    if (!committed || isCurrentPersistenceFence(fence, generationAtBoundary)) {
        return committed;
    }

    // A testable, asynchronous table implementation can let an already-dispatched
    // write settle after ownership changes. Restore the newest rendered candidate
    // only when it is still the owner; never replay the obsolete entry.
    const current = latestRenderedRenditionByCacheKey.get(fence.cacheEntryKey);
    if (!current || !isCurrentPersistenceFence(fence, current.generation)) {
        return false;
    }
    if (current.entry === entry) {
        return true;
    }

    let restored = false;
    await db.transaction('rw', db.effectCache, async () => {
        if (!isCurrentPersistenceFence(fence, current.generation)) return;
        await db.effectCache.put(current.entry);
        restored = true;
    });
    return restored;
}

// --- Public Cache API ---

/**
 * Get a pre-rendered export blob from the cache.
 * Uses current DPI from settings to look up the correct cached version.
 */
export async function getEffectCacheEntry(
    imageId: string,
    overrides: CardOverrides,
    dpi?: number
): Promise<Blob | undefined> {
    const effectiveDpi = dpi ?? useSettingsStore.getState().dpi;
    const key = computeCacheKey(imageId, overrides, effectiveDpi);
    const entry = await db.effectCache.get(key);
    if (entry) {
        // Touch cachedAt for LRU
        await db.effectCache.update(key, { cachedAt: Date.now() });
        return entry.blob;
    }
    return undefined;
}

/**
 * Store a pre-rendered export blob in the cache.
 * Uses current DPI from settings to store at the correct key.
 */
async function setEffectCacheEntry(
    imageId: string,
    overrides: CardOverrides,
    blob: Blob,
    dpi?: number,
    fence?: RenditionPersistenceFence
): Promise<void> {
    const effectiveDpi = dpi ?? useSettingsStore.getState().dpi;
    const key = computeCacheKey(imageId, overrides, effectiveDpi);
    const entry: EffectCacheEntry = {
        key,
        blob,
        size: blob.size,
        cachedAt: Date.now(),
    };
    if (fence) {
        latestRenderedRenditionByCacheKey.set(fence.cacheEntryKey, {
            generation: fence.generation.value,
            entry,
        });
        if (!await persistFencedEffectCacheEntry(entry, fence)) return;
        // The fence owns the conditional write. Apply the same shared byte
        // policy without replaying an unrestricted duplicate put.
        await enforceEffectCacheLimitsSerially();
    } else {
        await persistEffectCacheEntryWithBoundedPolicy(entry);
    }
}

/**
 * Worker-friendly version that requires DPI explicitly.
 * Use this in web workers where useSettingsStore isn't available.
 */
export async function setEffectCacheEntryWithDpi(
    imageId: string,
    overrides: CardOverrides,
    blob: Blob,
    dpi: number
): Promise<void> {
    const key = computeCacheKey(imageId, overrides, dpi);
    const entry: EffectCacheEntry = {
        key,
        blob,
        size: blob.size,
        cachedAt: Date.now(),
    };
    await persistEffectCacheEntryWithBoundedPolicy(entry);
}



/**
 * Pre-render and cache a card's export image using the worker pool.
 * This runs in a separate thread and won't block the UI.
 */
export async function preRenderEffect(
    card: CardOption,
    exportBlob: Blob
): Promise<void> {
    if (!card.imageId || !card.overrides || !hasActiveAdjustments(card.overrides)) {
        return;
    }

    try {
        const dpi = useSettingsStore.getState().dpi;
        await getOrCreatePreRender(card.imageId, exportBlob, card.overrides, dpi);
    } catch (error) {
        console.error('[effectCache] Pre-render failed:', error);
    }
}

/**
 * Queue bulk pre-render tasks. Uses the worker pool for non-blocking processing.
 * Fire-and-forget - logs errors but doesn't throw.
 */
export function queueBulkPreRender(
    tasks: Array<{ card: CardOption; exportBlob: Blob }>
): void {
    if (tasks.length === 0) return;

    // Process all tasks using the worker pool (limited concurrency handled internally)
    for (const task of tasks) {
        preRenderEffect(task.card, task.exportBlob)
            .catch(err => console.error('[effectCache] Bulk pre-render task failed:', err));
    }
}
