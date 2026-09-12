import { afterEach, describe, expect, it, vi } from "vitest";
import { createMpcCalibrationOperationScope as createScope } from "./mpcCalibrationOperationScope";
import { createMpcCalibrationQueueTrigger } from "./mpcCalibrationQueueTrigger";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const identity = {
  ownerId: "owner",
  harnessId: "harness",
  connectionId: "connection",
};

const owners: ReturnType<typeof createScope>[] = [];
function createMpcCalibrationOperationScope(...args: Parameters<typeof createScope>) {
  const owner = createScope(...args);
  owners.push(owner);
  return owner;
}
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
});

describe("createMpcCalibrationQueueTrigger", () => {
  it.each(["abort", "dispose"] as const)("rejects notification when its currentness callback causes %s and returns true", async fence => {
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const controller = new AbortController();
    const drain = vi.fn(async () => undefined);
    const trigger: ReturnType<typeof createMpcCalibrationQueueTrigger> = createMpcCalibrationQueueTrigger({
      operation: {
        ...owner.captureAppOperation(),
        signal: controller.signal,
        isCurrent() {
          if (fence === "abort") controller.abort();
          else trigger.dispose();
          return true;
        },
      },
      drain,
    });

    const accepted = trigger.notify(1);
    await flushMicrotasks();
    expect(accepted).toBe(false);
    expect(drain).not.toHaveBeenCalled();
    expect(trigger.isRunning()).toBe(false);
    trigger.dispose();
  });

  it.each(["abort", "dispose"] as const)("does not begin a queued drain when its currentness callback causes %s", async fence => {
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const controller = new AbortController();
    const drain = vi.fn(async () => undefined);
    let cancelOnCheck = false;
    const trigger: ReturnType<typeof createMpcCalibrationQueueTrigger> = createMpcCalibrationQueueTrigger({
      operation: {
        ...owner.captureAppOperation(),
        signal: controller.signal,
        isCurrent() {
          if (cancelOnCheck) {
            if (fence === "abort") controller.abort();
            else trigger.dispose();
          }
          return true;
        },
      },
      drain,
    });

    expect(trigger.notify(1)).toBe(true);
    cancelOnCheck = true;
    await flushMicrotasks();
    expect(drain).not.toHaveBeenCalled();
    expect(trigger.isRunning()).toBe(false);
    trigger.dispose();
  });

  it.each(["abort", "dispose"] as const)("suppresses failure notification when its currentness callback causes %s", async fence => {
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const controller = new AbortController();
    const physical = deferred<void>();
    const drain = vi.fn(() => physical.promise);
    const onFailure = vi.fn();
    let cancelOnCheck = false;
    const trigger: ReturnType<typeof createMpcCalibrationQueueTrigger> = createMpcCalibrationQueueTrigger({
      operation: {
        ...owner.captureAppOperation(),
        signal: controller.signal,
        isCurrent() {
          if (cancelOnCheck) {
            if (fence === "abort") controller.abort();
            else trigger.dispose();
          }
          return true;
        },
      },
      drain,
      onFailure,
    });

    expect(trigger.notify(1)).toBe(true);
    await flushMicrotasks();
    expect(trigger.isRunning()).toBe(true);
    cancelOnCheck = true;
    physical.reject(new Error("controlled settlement"));
    await flushMicrotasks();
    expect(trigger.isRunning()).toBe(false);
    expect(drain).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
    trigger.dispose();
  });

  it.each(["forged", "shadowed", "throwing"] as const)("bounds the %s signal before admitting a drain", async kind => {
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const controller = new AbortController();
    controller.abort();
    const signal = kind === "forged" ? Object.create(AbortSignal.prototype) as AbortSignal : controller.signal;
    if (kind === "shadowed") Object.defineProperty(signal, "aborted", { value: false });
    if (kind === "throwing") Object.defineProperty(signal, "aborted", { get() { throw new Error("untrusted abort property"); } });
    const drain = vi.fn(async () => undefined);
    const trigger = createMpcCalibrationQueueTrigger({
      operation: { ...owner.captureAppOperation(), signal, isCurrent: () => true },
      drain,
    });

    expect(trigger.notify(1)).toBe(false);
    await flushMicrotasks();
    expect(drain).not.toHaveBeenCalled();
    expect(trigger.isRunning()).toBe(false);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid generation %s without scheduling", async generation => {
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const drain = vi.fn(async () => undefined);
    const trigger = createMpcCalibrationQueueTrigger({ operation: owner.captureAppOperation(), drain });
    expect(trigger.notify(generation)).toBe(false);
    await flushMicrotasks();
    expect(drain).not.toHaveBeenCalled();
  });

  it("settles a throwing drain and failure callback without autonomous retry", async () => {
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const drain = vi.fn((): Promise<void> => { throw new Error("controlled drain"); });
    const onFailure = vi.fn(() => { throw new Error("controlled notification"); });
    const trigger = createMpcCalibrationQueueTrigger({ operation: owner.captureAppOperation(), drain, onFailure });
    expect(trigger.notify(1)).toBe(true);
    await flushMicrotasks();
    expect(trigger.isRunning()).toBe(false);
    expect(drain).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith();
    await flushMicrotasks();
    expect(drain).toHaveBeenCalledOnce();
    expect(trigger.notify(1)).toBe(true);
    await flushMicrotasks();
    expect(drain).toHaveBeenCalledTimes(2);
    expect(trigger.isRunning()).toBe(false);
  });

  it("coalesces same-turn notifications to the greatest generation with a receiver-correct current operation", async () => {
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const captured = owner.captureAppOperation();
    const operation = (() => {
      const value = {
        ...captured,
        isCurrent(this: object) {
          expect(this).toBe(value);
          return captured.isCurrent();
        },
      };
      return value;
    })();
    const running = deferred<void>();
    const drain = vi.fn(() => running.promise);
    const trigger = createMpcCalibrationQueueTrigger({ operation, drain });

    expect(trigger.notify(1)).toBe(true);
    expect(trigger.notify(3)).toBe(true);
    expect(trigger.notify(2)).toBe(true);
    expect(drain).not.toHaveBeenCalled();

    await flushMicrotasks();
    expect(drain).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledWith(3);
    expect(trigger.isRunning()).toBe(true);

    running.resolve();
    await flushMicrotasks();
    expect(trigger.isRunning()).toBe(false);
    owner.dispose();
  });

  it("keeps G2 as one deferred follow-up until the physically running G1 settles", async () => {
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const first = deferred<void>();
    const second = deferred<void>();
    const drain = vi.fn((generation: number) => {
      if (generation === 1) {
        expect(trigger.notify(2)).toBe(true);
        return first.promise;
      }
      return second.promise;
    });
    const trigger = (() => {
      const value = createMpcCalibrationQueueTrigger({ operation: owner.captureAppOperation(), drain });
      return value;
    })();

    expect(trigger.notify(1)).toBe(true);
    await flushMicrotasks();
    expect(drain).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenLastCalledWith(1);
    expect(trigger.notify(1)).toBe(true);
    expect(trigger.notify(2)).toBe(true);
    expect(drain).toHaveBeenCalledTimes(1);

    first.resolve();
    await flushMicrotasks();
    expect(drain).toHaveBeenCalledTimes(2);
    expect(drain).toHaveBeenLastCalledWith(2);
    expect(trigger.isRunning()).toBe(true);

    second.resolve();
    await flushMicrotasks();
    expect(trigger.isRunning()).toBe(false);
    owner.dispose();
  });

  it("fences pending and future drains on disposal without claiming the running drain stopped", async () => {
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const first = deferred<void>();
    const drain = vi.fn(() => first.promise);
    const trigger = createMpcCalibrationQueueTrigger({ operation: owner.captureAppOperation(), drain });

    expect(trigger.notify(1)).toBe(true);
    await flushMicrotasks();
    expect(trigger.isRunning()).toBe(true);
    expect(trigger.notify(2)).toBe(true);

    trigger.dispose();
    expect(trigger.isRunning()).toBe(true);
    expect(trigger.notify(3)).toBe(false);
    first.resolve();
    await flushMicrotasks();
    expect(drain).toHaveBeenCalledOnce();
    expect(trigger.isRunning()).toBe(false);
    owner.dispose();
  });

  it("contains a failed drain, invokes bounded failure once, and requires an explicit retry notification", async () => {
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const first = deferred<void>();
    const second = deferred<void>();
    const drain = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onFailure = vi.fn();
    const trigger = createMpcCalibrationQueueTrigger({ operation: owner.captureAppOperation(), drain, onFailure });

    expect(trigger.notify(1)).toBe(true);
    await flushMicrotasks();
    first.reject(new Error("controlled failure"));
    await flushMicrotasks();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledOnce();
    expect(trigger.isRunning()).toBe(false);

    expect(trigger.notify(1)).toBe(true);
    await flushMicrotasks();
    expect(drain).toHaveBeenCalledTimes(2);
    second.resolve();
    await flushMicrotasks();
    owner.dispose();
  });

  it("refuses a pre-aborted captured operation before any drain starts", async () => {
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const operation = owner.captureAppOperation();
    operation.dispose();
    const drain = vi.fn(async () => undefined);
    const trigger = createMpcCalibrationQueueTrigger({ operation, drain });

    expect(trigger.notify(1)).toBe(false);
    await flushMicrotasks();
    expect(drain).not.toHaveBeenCalled();
    expect(trigger.isRunning()).toBe(false);
    owner.dispose();
  });

  it("requires a literal true captured currentness proof and never starts a stale operation", async () => {
    const owner = createMpcCalibrationOperationScope({ target: "linked-web", identity });
    const captured = owner.captureAppOperation();
    const drain = vi.fn(async () => undefined);
    const trigger = createMpcCalibrationQueueTrigger({
      operation: { ...captured, isCurrent: () => "truthy" as never },
      drain,
    });

    expect(trigger.notify(1)).toBe(false);
    await flushMicrotasks();
    expect(drain).not.toHaveBeenCalled();
    owner.dispose();
  });
});
