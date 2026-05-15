import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ImageProcessor, Priority } from "./imageProcessor";

type TrackedMockWorker = Worker & {
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    onmessage: ((event: MessageEvent) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
};

type TrackedWorkerConstructor = typeof Worker & {
    instances: TrackedMockWorker[];
};

function workerInstances() {
    return (global.Worker as unknown as TrackedWorkerConstructor).instances;
}

describe("ImageProcessor", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // Reset the singleton instance before each test
        // We need to access the private static instance to reset it
        // @ts-expect-error: Accessing private member for testing
        ImageProcessor.instance = undefined;
        // @ts-expect-error: Accessing private member for testing
        ImageProcessor.instances = new Set();

        // Mock Worker
        global.Worker = class MockWorker {
            static instances: MockWorker[] = [];
            postMessage = vi.fn();
            terminate = vi.fn();
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;
            constructor() {
                MockWorker.instances.push(this);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;

        // Mock navigator.hardwareConcurrency
        Object.defineProperty(navigator, 'hardwareConcurrency', {
            value: 16,
            configurable: true,
        });

        // Mock URL
        global.URL = class MockURL {
            constructor() { }
            toString() { return "mock-url"; }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
    });

    afterEach(() => {
        ImageProcessor.destroyAll();
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("should implement Singleton pattern", () => {
        const instance1 = ImageProcessor.getInstance();
        const instance2 = ImageProcessor.getInstance();
        expect(instance1).toBe(instance2);
    });

    it("should cap maxWorkers at 8", () => {
        // Mock high concurrency
        Object.defineProperty(navigator, 'hardwareConcurrency', {
            value: 32,
            configurable: true,
        });

        const instance = ImageProcessor.getInstance();
        // Access private maxWorkers
        // @ts-expect-error: Accessing private member for testing
        expect(instance.baseMaxWorkers).toBe(8);
    });

    it("should process one task", async () => {
        const instance = ImageProcessor.getInstance();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = instance.process({} as unknown as any);

        // Check if worker was created
        // @ts-expect-error: Accessing private member
        expect(instance.allWorkers.size).toBe(1);

        // Prevent unhandled rejection by catching the promise
        p.catch(() => { });
    });

    it("should cancel queued tasks and terminate workers", async () => {
        const instance = ImageProcessor.getInstance();

        // Create 8 tasks to fill the pool
        const activePromises = [];
        for (let i = 0; i < 8; i++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            activePromises.push(instance.process({} as unknown as any));
        }

        // Create 9th task (should be queued)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const queuedPromise = instance.process({} as unknown as any);

        // Cancel
        instance.cancelAll();

        // Expect queued promise to reject
        await expect(queuedPromise).rejects.toThrow("Cancelled");

        // active promises should also be rejected or handled, but we focus on state here

        // Expect workers to be cleared
        // @ts-expect-error: Accessing private member
        expect(instance.allWorkers.size).toBe(0);
    });

    it("should use hardwareConcurrency - 1 if less than cap", () => {
        Object.defineProperty(navigator, 'hardwareConcurrency', {
            value: 8,
            configurable: true,
        });

        const instance = ImageProcessor.getInstance();
        // @ts-expect-error: Accessing private member for testing
        expect(instance.baseMaxWorkers).toBe(7);
    });

    it("should have at least 1 worker", () => {
        Object.defineProperty(navigator, 'hardwareConcurrency', {
            value: 1,
            configurable: true,
        });

        const instance = ImageProcessor.getInstance();
        // @ts-expect-error: Accessing private member for testing
        expect(instance.baseMaxWorkers).toBe(1);
    });

    it("should use Firefox worker limits and hardware fallback", () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 Firefox/120',
            configurable: true,
        });
        Object.defineProperty(navigator, 'hardwareConcurrency', {
            value: undefined,
            configurable: true,
        });

        const instance = ImageProcessor.getInstance();

        // Fallback concurrency is 4, so the pool reserves one core.
        // @ts-expect-error: Accessing private member for testing
        expect(instance.baseMaxWorkers).toBe(3);
    });

    it("should prewarm workers and retire idle workers after timeout", () => {
        const instance = ImageProcessor.getInstance();

        instance.prewarm(1);

        const [worker] = workerInstances();
        // @ts-expect-error: Accessing private member for testing
        expect(instance.idleWorkers).toHaveLength(1);

        vi.runOnlyPendingTimers();

        expect(worker.terminate).toHaveBeenCalled();
        // @ts-expect-error: Accessing private member for testing
        expect(instance.allWorkers.size).toBe(0);
    });

    it("should not prewarm beyond the worker cap", () => {
        Object.defineProperty(navigator, 'hardwareConcurrency', {
            value: 1,
            configurable: true,
        });
        const instance = ImageProcessor.getInstance();

        instance.prewarm(1);
        instance.prewarm(1);

        expect(workerInstances()).toHaveLength(1);
    });

    it("should prioritize HIGH priority tasks", async () => {
        const instance = ImageProcessor.getInstance();

        // Fill the pool (8 workers)
        for (let i = 0; i < 8; i++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            instance.process({ uuid: `fill-${i}` } as any);
        }

        // Queue a LOW priority task
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lowP = instance.process({ uuid: "low" } as any, Priority.LOW);
        lowP.catch(() => { });

        // Queue a HIGH priority task
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const highP = instance.process({ uuid: "high" } as any, Priority.HIGH);
        highP.catch(() => { });

        // Verify queue state
        // @ts-expect-error: Accessing private member
        expect(instance.lowPriorityQueue.length).toBe(1);
        // @ts-expect-error: Accessing private member
        expect(instance.highPriorityQueue.length).toBe(1);
        // @ts-expect-error: Accessing private member
        expect(instance.highPriorityQueue[0].message.uuid).toBe("high");
        // @ts-expect-error: Accessing private member
        expect(instance.lowPriorityQueue[0].message.uuid).toBe("low");
    });

    it("should promote LOW priority task to HIGH if requested again", async () => {
        const instance = ImageProcessor.getInstance();

        // Fill the pool
        for (let i = 0; i < 8; i++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            instance.process({ uuid: `fill-${i}` } as any);
        }

        // Queue a LOW priority task
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p1 = instance.process({ uuid: "promote-me" } as any, Priority.LOW);
        p1.catch(() => { });

        // Verify it's in low queue
        // @ts-expect-error: Accessing private member
        expect(instance.lowPriorityQueue.length).toBe(1);
        // @ts-expect-error: Accessing private member
        expect(instance.highPriorityQueue.length).toBe(0);

        // Request same task with HIGH priority
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p2 = instance.process({ uuid: "promote-me" } as any, Priority.HIGH);
        p2.catch(() => { });

        // Verify it moved to high queue
        // @ts-expect-error: Accessing private member
        expect(instance.lowPriorityQueue.length).toBe(0);
        // @ts-expect-error: Accessing private member
        expect(instance.highPriorityQueue.length).toBe(1);
        // @ts-expect-error: Accessing private member
        expect(instance.highPriorityQueue[0].message.uuid).toBe("promote-me");

        // The first promise should have been rejected with "Promoted..."
        await expect(p1).rejects.toThrow("Promoted to high priority");
    });

    it("should promote a queued task through the explicit promotion API", async () => {
        const instance = ImageProcessor.getInstance();

        for (let i = 0; i < 8; i++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            instance.process({ uuid: `fill-${i}` } as any).catch(() => { });
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const queued = instance.process({ uuid: "manual-promote" } as any, Priority.LOW);
        queued.catch(() => { });

        instance.promoteToHighPriority("manual-promote");

        // @ts-expect-error: Accessing private member for testing
        expect(instance.lowPriorityQueue).toHaveLength(0);
        // @ts-expect-error: Accessing private member for testing
        expect(instance.highPriorityQueue[0].message.uuid).toBe("manual-promote");
    });

    it("should ignore explicit promotion when the task is not queued", () => {
        const instance = ImageProcessor.getInstance();

        instance.promoteToHighPriority("missing");

        // @ts-expect-error: Accessing private member for testing
        expect(instance.highPriorityQueue).toHaveLength(0);
        // @ts-expect-error: Accessing private member for testing
        expect(instance.lowPriorityQueue).toHaveLength(0);
    });

    it("should reject when queue exceeds MAX_QUEUE_SIZE", async () => {
        const instance = ImageProcessor.getInstance();


        // Fill queue to limit (need to account for active workers + queue)
        // MAX_QUEUE_SIZE is 200, active workers max 8.
        // So we need > 208 tasks to trigger rejection.
        for (let i = 0; i < 250; i++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const p = instance.process({ uuid: `fill-queue-${i}` } as any);
            p.catch(() => { });
        }

        // Try to add one more
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const overflow = instance.process({ uuid: "overflow" } as any);
        await expect(overflow).rejects.toThrow("Processing queue full");
    });

    it("should call activity callback", async () => {
        const instance = ImageProcessor.getInstance();
        const callback = vi.fn();
        const unsubscribe = instance.onActivityChange(callback);

        // Start a task
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = instance.process({ uuid: "activity-test" } as any);
        p.catch(() => { });

        expect(callback).toHaveBeenCalledWith(true);

        // Finish task (mock worker message)
        // Access private worker logic via any cast if necessary or verify state change
        // Since we can't easily trigger the worker response in this mock setup without deeper hooks,
        // we'll verify the listener was registered and called on start.

        unsubscribe();
    });

    it("should resolve worker responses, reuse idle workers, and notify inactive state", async () => {
        const instance = ImageProcessor.getInstance();
        const callback = vi.fn();
        instance.onActivityChange(callback);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const first = instance.process({ uuid: "first" } as any, Priority.HIGH);
        const [worker] = workerInstances();

        worker.onmessage?.({
            data: { uuid: "first", error: "done" },
        } as MessageEvent);

        await expect(first).resolves.toEqual({ uuid: "first", error: "done" });
        expect(callback).toHaveBeenCalledWith(false);
        // @ts-expect-error: Accessing private member for testing
        expect(instance.idleWorkers).toHaveLength(1);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const second = instance.process({ uuid: "second" } as any, Priority.HIGH);
        expect(workerInstances()).toHaveLength(1);
        worker.onmessage?.({
            data: { uuid: "second", error: "done" },
        } as MessageEvent);

        await expect(second).resolves.toEqual({ uuid: "second", error: "done" });
        expect(worker.postMessage).toHaveBeenCalledWith({ uuid: "second" });
    });

    it("should keep activity active until all concurrent tasks complete", async () => {
        const instance = ImageProcessor.getInstance();
        const callback = vi.fn();
        instance.onActivityChange(callback);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const first = instance.process({ uuid: "first" } as any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const second = instance.process({ uuid: "second" } as any);
        const [firstWorker, secondWorker] = workerInstances();

        firstWorker.onmessage?.({
            data: { uuid: "first", error: "done" },
        } as MessageEvent);

        await expect(first).resolves.toEqual({ uuid: "first", error: "done" });
        expect(callback).not.toHaveBeenCalledWith(false);

        secondWorker.onmessage?.({
            data: { uuid: "second", error: "done" },
        } as MessageEvent);
        await expect(second).resolves.toEqual({ uuid: "second", error: "done" });
        expect(callback).toHaveBeenCalledWith(false);
    });

    it("should terminate failed workers and reject the active task", async () => {
        const instance = ImageProcessor.getInstance();
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const task = instance.process({ uuid: "boom" } as any);
        const [worker] = workerInstances();
        const error = new ErrorEvent("error", { message: "worker failed" });

        worker.onerror?.(error);

        await expect(task).rejects.toBe(error);
        expect(worker.terminate).toHaveBeenCalled();
        // @ts-expect-error: Accessing private member for testing
        expect(instance.allWorkers.size).toBe(0);
        errorSpy.mockRestore();
    });

    it("should cancel cleanly when no tasks are active", () => {
        const instance = ImageProcessor.getInstance();
        const callback = vi.fn();
        instance.onActivityChange(callback);

        instance.cancelAll();

        expect(callback).not.toHaveBeenCalled();
    });

    it("should destroy manually seeded idle workers without timeout handles", () => {
        const instance = ImageProcessor.getInstance();
        const worker = new Worker("mock-url");
        // @ts-expect-error: Accessing private member for testing
        instance.idleWorkers.push({ worker, timeoutId: null });
        // @ts-expect-error: Accessing private member for testing
        instance.allWorkers.add(worker);

        instance.destroy();

        expect(worker.terminate).toHaveBeenCalled();
        // @ts-expect-error: Accessing private member for testing
        expect(instance.allWorkers.size).toBe(0);
    });

    it("should reuse manually seeded idle workers without timeout handles", async () => {
        const instance = ImageProcessor.getInstance();
        const worker = new Worker("mock-url");
        // @ts-expect-error: Accessing private member for testing
        instance.idleWorkers.push({ worker, timeoutId: null });
        // @ts-expect-error: Accessing private member for testing
        instance.allWorkers.add(worker);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const task = instance.process({ uuid: "manual-idle" } as any);
        worker.onmessage?.({
            data: { uuid: "manual-idle", error: "done" },
        } as MessageEvent);

        await expect(task).resolves.toEqual({ uuid: "manual-idle", error: "done" });
        expect(worker.postMessage).toHaveBeenCalledWith({ uuid: "manual-idle" });
    });

    it("should tolerate terminating workers that are idle-only or already absent", () => {
        const instance = ImageProcessor.getInstance();
        const idleOnlyWorker = new Worker("mock-url");
        // @ts-expect-error: Accessing private member for testing
        instance.idleWorkers.push({ worker: idleOnlyWorker, timeoutId: null });

        // @ts-expect-error: Accessing private member for testing
        instance.terminateWorker(idleOnlyWorker);
        // @ts-expect-error: Accessing private member for testing
        instance.terminateWorker(new Worker("mock-url"));

        expect(idleOnlyWorker.terminate).not.toHaveBeenCalled();
        // @ts-expect-error: Accessing private member for testing
        expect(instance.idleWorkers).toHaveLength(0);
    });
});
