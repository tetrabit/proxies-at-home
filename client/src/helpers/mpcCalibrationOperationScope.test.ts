import "fake-indexeddb/auto";
import Dexie from "dexie";
import { describe, expect, it } from "vitest";
import type { CalibrationHarnessPersistenceIdentity } from "../../../shared/calibrationHarnessLocalState";
import {
  MpcCalibrationOperationCancelledError,
  createMpcCalibrationOperationScope,
} from "./mpcCalibrationOperationScope";

const identity = () => ({ ownerId: "owner", harnessId: "harness", connectionId: "connection" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("mpc calibration operation scope", () => {
  it("exposes a controller-owned operation scope factory", () => {
    expect(createMpcCalibrationOperationScope).toEqual(expect.any(Function));
  });

  it("captures an app operation with a synchronous currentness guard", () => {
    const scope = createMpcCalibrationOperationScope({ target: "local", identity: identity() });
    const operation = scope.captureAppOperation();
    const status: string[] = [];

    operation.guard(() => status.push("published"));

    expect(operation.isCurrent()).toBe(true);
    expect(status).toEqual(["published"]);
  });

  it.each(["local", "linked-web"] as const)(
    "captures an explicit absent identity for unauthenticated %s work without fabricating a namespace",
    target => {
      const scope = createMpcCalibrationOperationScope({ target, identity: null });
      const operation = scope.captureAppOperation();
      const requireAuthenticatedIdentity = (
        value: Readonly<CalibrationHarnessPersistenceIdentity>
      ) => value;

      expect(operation.identity).toBeNull();
      // @ts-expect-error A pre-authentication capture must be narrowed before owner-bound use.
      requireAuthenticatedIdentity(operation.identity);
    }
  );

  it("fences null-to-real-to-null identity replacements and preserves frozen detached real captures", () => {
    const scope = createMpcCalibrationOperationScope({ target: "linked-web", identity: null });
    const beforeAuthentication = scope.captureAppOperation();

    scope.replaceIdentity(identity());
    const authenticated = scope.captureAppOperation();
    scope.replaceIdentity(null);
    const afterSignOut = scope.captureAppOperation();

    expect(beforeAuthentication.isCurrent()).toBe(false);
    expect(authenticated.isCurrent()).toBe(false);
    expect(authenticated.identity).toEqual(identity());
    expect(Object.isFrozen(authenticated.identity)).toBe(true);
    expect(afterSignOut.identity).toBeNull();
    expect(afterSignOut.isCurrent()).toBe(true);
  });

  it("cancels and disposes unauthenticated first-authentication work after auth or mode replacement", async () => {
    const scope = createMpcCalibrationOperationScope({ target: "linked-web", identity: null });
    const authenticationOperation = scope.captureAppOperation();
    let cancelled = 0;
    authenticationOperation.onCancel(() => { cancelled += 1; });
    const later = deferred<string>();
    const status: string[] = [];
    const pending = later.promise.then(() => authenticationOperation.guard(() => status.push("late")));

    scope.replaceAuthentication({ epoch: 1 });
    later.resolve("session");
    await pending;
    expect(authenticationOperation.isCurrent()).toBe(false);
    expect(authenticationOperation.signal.aborted).toBe(true);
    expect(cancelled).toBe(1);
    expect(status).toEqual([]);

    const modeOperation = scope.captureAppOperation();
    scope.replaceTarget("local");
    expect(modeOperation.isCurrent()).toBe(false);
    expect(modeOperation.signal.aborted).toBe(true);

    const locallyUnauthenticated = scope.captureUiOperation();
    scope.dispose();
    scope.dispose();
    expect(locallyUnauthenticated.isCurrent()).toBe(false);
    expect(locallyUnauthenticated.signal.aborted).toBe(true);
  });

  it("keeps non-null identities strict while admitting only explicit null absence", () => {
    expect(() => createMpcCalibrationOperationScope({ target: "local", identity: undefined as never })).toThrow();
    expect(() => createMpcCalibrationOperationScope({ target: "local", identity: { ownerId: "owner" } as never })).toThrow();
  });

  it.each(["target", "authentication", "same-identity", "different-identity", "connection", "controller"] as const)(
    "suppresses stale deferred success, error, and finally status after %s replacement",
    async replacement => {
      const scope = createMpcCalibrationOperationScope({ target: "local", identity: identity() });
      const success = scope.captureAppOperation();
      const failure = scope.captureAppOperation();
      const status: string[] = [];
      const laterSuccess = deferred<string>();
      const laterFailure = deferred<string>();
      const successPromise = laterSuccess.promise.then(() => success.guard(() => status.push("success"))).finally(() => success.guard(() => status.push("success-finally")));
      const failurePromise = laterFailure.promise.catch(() => failure.guard(() => status.push("error"))).finally(() => failure.guard(() => status.push("error-finally")));

      if (replacement === "target") scope.replaceTarget("linked-web");
      if (replacement === "authentication") scope.replaceAuthentication({ epoch: 2 });
      if (replacement === "same-identity") scope.replaceIdentity(identity());
      if (replacement === "different-identity") scope.replaceIdentity({ ...identity(), connectionId: "other-connection" });
      if (replacement === "connection") scope.replaceConnection({ id: "other" });
      if (replacement === "controller") scope.replaceController({ id: "other" });

      laterSuccess.resolve("late");
      laterFailure.reject(new Error("late"));
      await Promise.all([successPromise, failurePromise]);

      expect(success.isCurrent()).toBe(false);
      expect(failure.isCurrent()).toBe(false);
      expect(status).toEqual([]);
    }
  );

  it("keeps each new captured operation usable while old target, authentication, and same-identity epochs are fenced", () => {
    const scope = createMpcCalibrationOperationScope({ target: "local", identity: identity() });
    const beforeTarget = scope.captureAppOperation();
    scope.replaceTarget("linked-web");
    const afterTarget = scope.captureAppOperation();
    scope.replaceAuthentication({ epoch: 2 });
    const afterAuthentication = scope.captureAppOperation();
    scope.replaceIdentity(identity());
    const current = scope.captureAppOperation();

    expect(beforeTarget.isCurrent()).toBe(false);
    expect(afterTarget.isCurrent()).toBe(false);
    expect(afterAuthentication.isCurrent()).toBe(false);
    expect(current.isCurrent()).toBe(true);
  });

  it("captures target and exact identity before caller options can be mutated", () => {
    const options = { target: "local" as const, identity: identity() };
    const scope = createMpcCalibrationOperationScope(options);
    const operation = scope.captureAppOperation();
    options.identity.ownerId = "mutated-owner";

    expect(operation.target).toBe("local");
    expect(operation.identity).toEqual(identity());
    expect(Object.isFrozen(operation.identity)).toBe(true);
  });

  it("cancels only the UI-owned modal operation and leaves app and sibling operations current", () => {
    const scope = createMpcCalibrationOperationScope({ target: "local", identity: identity() });
    const app = scope.captureAppOperation();
    const closedModal = scope.captureUiOperation();
    const siblingModal = scope.captureUiOperation();

    closedModal.dispose();

    expect(closedModal.isCurrent()).toBe(false);
    expect(closedModal.signal.aborted).toBe(true);
    expect(app.isCurrent()).toBe(true);
    expect(siblingModal.isCurrent()).toBe(true);
  });

  it("disposes the app lifetime once and invalidates every owned operation", () => {
    const scope = createMpcCalibrationOperationScope({ target: "local", identity: identity() });
    const app = scope.captureAppOperation();
    const ui = scope.captureUiOperation();

    scope.dispose();
    scope.dispose();

    expect(app.isCurrent()).toBe(false);
    expect(ui.isCurrent()).toBe(false);
    expect(app.signal.aborted).toBe(true);
    expect(ui.signal.aborted).toBe(true);
  });

  it("does not retain a new operation captured after app disposal", () => {
    const scope = createMpcCalibrationOperationScope({ target: "local", identity: identity() });
    scope.dispose();
    const late = scope.captureUiOperation();

    expect(late.isCurrent()).toBe(false);
    expect(late.signal.aborted).toBe(true);
  });

  it("releases only its owned cancellation listener and makes repeated cleanup idempotent", () => {
    const scope = createMpcCalibrationOperationScope({ target: "local", identity: identity() });
    const operation = scope.captureUiOperation();
    let ownedCalls = 0;
    let externalCalls = 0;
    const externalListener = () => { externalCalls += 1; };
    operation.signal.addEventListener("abort", externalListener);
    const removeOwned = operation.onCancel(() => { ownedCalls += 1; });

    removeOwned();
    removeOwned();
    operation.dispose();
    operation.dispose();

    expect(ownedCalls).toBe(0);
    expect(externalCalls).toBe(1);
  });

  it("rolls back real private Dexie writes when the captured guard becomes stale inside the transaction", async () => {
    const database = new Dexie(`operation-scope-${crypto.randomUUID()}`);
    database.version(1).stores({ bindings: "id", cache: "id" });
    await database.open();
    const bindings = database.table<{ id: string; value: string }>("bindings");
    const cache = database.table<{ id: string; bytes: Uint8Array }>("cache");
    await bindings.put({ id: "binding", value: "before-binding" });
    await cache.put({ id: "cache", bytes: new Uint8Array([1, 2, 3]) });
    const scope = createMpcCalibrationOperationScope({ target: "local", identity: identity() });
    const operation = scope.captureAppOperation();

    try {
      await expect(database.transaction("rw", bindings, cache, async () => {
        await bindings.put({ id: "binding", value: "after-binding" });
        await cache.put({ id: "cache", bytes: new Uint8Array([9, 8, 7]) });
        scope.replaceAuthentication({ epoch: 2 });
        operation.assertCurrent();
      })).rejects.toBeInstanceOf(MpcCalibrationOperationCancelledError);

      expect(await bindings.get("binding")).toEqual({ id: "binding", value: "before-binding" });
      expect(Array.from((await cache.get("cache"))!.bytes)).toEqual([1, 2, 3]);
    } finally {
      database.close();
    }
  });
});
