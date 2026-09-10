import { describe, expect, it } from "vitest";
import { pLimit } from "./pLimit.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("pLimit", () => {
  it("starts work immediately only until the concurrency cap is occupied", async () => {
    const limit = pLimit(2);
    const first = deferred<string>();
    const second = deferred<string>();
    const starts: string[] = [];

    const firstResult = limit(() => {
      starts.push("first");
      return first.promise;
    });
    const secondResult = limit(() => {
      starts.push("second");
      return second.promise;
    });
    const queuedResult = limit(() => {
      starts.push("queued");
      return Promise.resolve("queued");
    });

    expect(starts).toEqual(["first", "second"]);

    first.resolve("first");
    await expect(firstResult).resolves.toBe("first");
    await expect(queuedResult).resolves.toBe("queued");
    expect(starts).toEqual(["first", "second", "queued"]);

    second.resolve("second");
    await expect(secondResult).resolves.toBe("second");
  });

  it("starts queued work in FIFO order as slots are released", async () => {
    const limit = pLimit(1);
    const first = deferred<string>();
    const second = deferred<string>();
    const starts: string[] = [];

    const firstResult = limit(() => {
      starts.push("first");
      return first.promise;
    });
    const secondResult = limit(() => {
      starts.push("second");
      return second.promise;
    });
    const thirdResult = limit(() => {
      starts.push("third");
      return Promise.resolve("third");
    });

    first.resolve("first");
    await expect(firstResult).resolves.toBe("first");
    expect(starts).toEqual(["first", "second"]);

    second.resolve("second");
    await expect(secondResult).resolves.toBe("second");
    await expect(thirdResult).resolves.toBe("third");
    expect(starts).toEqual(["first", "second", "third"]);
  });

  it("rejects the failed task and releases its slot for queued work", async () => {
    const limit = pLimit(1);
    const starts: string[] = [];

    const failed = limit(() => {
      starts.push("failed");
      return Promise.reject(new Error("expected failure"));
    });
    const recovered = limit(() => {
      starts.push("recovered");
      return Promise.resolve("recovered");
    });

    await expect(failed).rejects.toThrow("expected failure");
    await expect(recovered).resolves.toBe("recovered");
    expect(starts).toEqual(["failed", "recovered"]);
  });
});
