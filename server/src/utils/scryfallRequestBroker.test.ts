import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScryfallRequestBroker } from "./scryfallRequestBroker.js";

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

async function settlePromises(): Promise<void> {
  // A physical request may include its own cleanup promise before the broker's
  // settlement handler releases the next FIFO slot.
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

describe("ScryfallRequestBroker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches mixed callers in FIFO order with at least 100ms between physical requests", async () => {
    const broker = new ScryfallRequestBroker();
    const catalog = deferred<string>();
    const router = deferred<string>();
    const tokens = deferred<string>();
    const dispatches: Array<{ caller: string; at: number }> = [];

    const enqueue = (caller: string, request: Deferred<string>) =>
      broker.enqueue(() => {
        dispatches.push({ caller, at: Date.now() });
        return request.promise;
      });

    const catalogResult = enqueue("catalog", catalog);
    const routerResult = enqueue("router", router);
    const tokenResult = enqueue("tokens", tokens);

    expect(dispatches).toEqual([{ caller: "catalog", at: 0 }]);

    catalog.resolve("catalog result");
    await settlePromises();
    await vi.advanceTimersByTimeAsync(99);
    expect(dispatches).toEqual([{ caller: "catalog", at: 0 }]);

    await vi.advanceTimersByTimeAsync(1);
    expect(dispatches).toEqual([
      { caller: "catalog", at: 0 },
      { caller: "router", at: 100 },
    ]);

    router.resolve("router result");
    await settlePromises();
    await vi.advanceTimersByTimeAsync(100);
    expect(dispatches).toEqual([
      { caller: "catalog", at: 0 },
      { caller: "router", at: 100 },
      { caller: "tokens", at: 200 },
    ]);

    tokens.resolve("token result");
    await expect(Promise.all([catalogResult, routerResult, tokenResult])).resolves.toEqual([
      "catalog result",
      "router result",
      "token result",
    ]);
  });

  it("keeps the lease until the active physical request settles", async () => {
    const broker = new ScryfallRequestBroker();
    const first = deferred<void>();
    const second = deferred<void>();
    let active = 0;
    let maxActive = 0;
    const dispatches: number[] = [];

    const queue = (request: Deferred<void>) =>
      broker.enqueue(() => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        dispatches.push(Date.now());
        return request.promise.finally(() => {
          active -= 1;
        });
      });

    const firstResult = queue(first);
    const secondResult = queue(second);

    await vi.advanceTimersByTimeAsync(500);
    expect(dispatches).toEqual([0]);
    expect(active).toBe(1);
    expect(maxActive).toBe(1);

    first.resolve();
    await settlePromises();
    expect(dispatches).toEqual([0, 500]);
    expect(active).toBe(1);
    expect(maxActive).toBe(1);

    second.resolve();
    await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([undefined, undefined]);
    expect(active).toBe(0);
    expect(maxActive).toBe(1);
  });

  it("releases after a rejected request and continues with the next FIFO request", async () => {
    const broker = new ScryfallRequestBroker();
    const rejected = deferred<string>();
    const recovered = deferred<string>();
    const dispatches: string[] = [];

    const firstResult = broker.enqueue(() => {
      dispatches.push("failing request");
      return rejected.promise;
    });
    const recoveredResult = broker.enqueue(() => {
      dispatches.push("recovery request");
      return recovered.promise;
    });

    rejected.reject(new Error("Scryfall unavailable"));
    await expect(firstResult).rejects.toThrow("Scryfall unavailable");
    await settlePromises();
    await vi.advanceTimersByTimeAsync(99);
    expect(dispatches).toEqual(["failing request"]);

    await vi.advanceTimersByTimeAsync(1);
    expect(dispatches).toEqual(["failing request", "recovery request"]);

    recovered.resolve("recovered");
    await expect(recoveredResult).resolves.toBe("recovered");
  });

  it("cancels queued work and keeps an aborted active request leased until its physical request settles", async () => {
    const broker = new ScryfallRequestBroker();
    const activeRequest = deferred<string>();
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const dispatches: string[] = [];
    let operationWasAborted = false;

    const activeResult = broker.enqueue(
      (signal) => {
        dispatches.push("active");
        signal.addEventListener("abort", () => {
          operationWasAborted = true;
        });
        return activeRequest.promise;
      },
      { signal: activeController.signal }
    );
    const queuedResult = broker.enqueue(
      () => {
        dispatches.push("queued");
        return Promise.resolve("should not dispatch");
      },
      { signal: queuedController.signal }
    );
    const afterActive = broker.enqueue(() => {
      dispatches.push("after active");
      return Promise.resolve("next request");
    });

    queuedController.abort();
    activeController.abort();
    await expect(queuedResult).rejects.toMatchObject({ name: "AbortError" });
    await expect(activeResult).rejects.toMatchObject({ name: "AbortError" });
    expect(operationWasAborted).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(dispatches).toEqual(["active"]);

    activeRequest.reject(new Error("physical request aborted"));
    await settlePromises();
    expect(dispatches).toEqual(["active", "after active"]);
    await expect(afterActive).resolves.toBe("next request");
  });
});
