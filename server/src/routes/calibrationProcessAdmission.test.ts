import { describe, expect, it, vi } from "vitest";
import {
  CalibrationAdmissionQueueFullError,
  CalibrationAdmissionTimeoutError,
  createCalibrationProcessAdmission,
} from "./calibrationProcessAdmission.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("calibration process admission", () => {
  it("caps active commands and dispatches queued commands in FIFO order", async () => {
    const admission = createCalibrationProcessAdmission({ maxActive: 1, maxQueued: 2 });
    const first = deferred<void>();
    const started: string[] = [];

    const firstResult = admission.enqueue(async () => {
      started.push("first");
      await first.promise;
      return "first";
    });
    const secondResult = admission.enqueue(async () => {
      started.push("second");
      return "second";
    });

    expect(started).toEqual(["first"]);
    expect(admission.stats()).toEqual({ active: 1, queued: 1 });

    first.resolve();
    await expect(firstResult).resolves.toBe("first");
    await expect(secondResult).resolves.toBe("second");
    expect(started).toEqual(["first", "second"]);
    expect(admission.stats()).toEqual({ active: 0, queued: 0 });
  });

  it("removes an aborted command while it is queued", async () => {
    const admission = createCalibrationProcessAdmission({ maxActive: 1, maxQueued: 1 });
    const first = deferred<void>();
    const started = vi.fn();
    const queuedAbort = new AbortController();

    const active = admission.enqueue(async () => {
      await first.promise;
    });
    const queued = admission.enqueue(async () => started(), { signal: queuedAbort.signal });

    queuedAbort.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(admission.stats()).toEqual({ active: 1, queued: 0 });

    first.resolve();
    await active;
    expect(started).not.toHaveBeenCalled();
  });

  it("counts queue wait against a command deadline and rejects a full bounded queue", async () => {
    let now = 0;
    const admission = createCalibrationProcessAdmission({
      maxActive: 1,
      maxQueued: 1,
      now: () => now,
    });
    const first = deferred<void>();
    const queuedStart = vi.fn();

    const active = admission.enqueue(async () => {
      await first.promise;
    });
    const queued = admission.enqueue(async () => queuedStart(), { timeoutMs: 20 });

    expect(() => admission.enqueue(async () => undefined)).toThrow(CalibrationAdmissionQueueFullError);

    now = 20;
    first.resolve();
    await active;
    await expect(queued).rejects.toBeInstanceOf(CalibrationAdmissionTimeoutError);
    expect(queuedStart).not.toHaveBeenCalled();
  });
});
