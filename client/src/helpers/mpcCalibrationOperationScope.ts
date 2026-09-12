import {
  validateCalibrationHarnessPersistenceIdentity,
  type CalibrationHarnessPersistenceIdentity,
} from "../../../shared/calibrationHarnessLocalState";
import type { MpcCalibrationTransportTarget } from "./mpcCalibrationTransportSelection";

export type MpcCalibrationOperationScopeOptions = Readonly<{
  target: MpcCalibrationTransportTarget;
  /** Null is an explicit pre-authentication lifetime, not a persistence namespace. */
  identity: CalibrationHarnessPersistenceIdentity | null;
  /** Opaque controller identity captured only to fence an operation lifetime. */
  controller?: unknown;
  /** Opaque connection identity captured only to fence an operation lifetime. */
  connection?: unknown;
  /** Opaque authentication identity captured only to fence an operation lifetime. */
  authentication?: unknown;
}>;

export type MpcCalibrationCapturedOperation = Readonly<{
  target: MpcCalibrationTransportTarget;
  /** Nullable until a caller obtains and validates an authenticated identity. */
  identity: Readonly<CalibrationHarnessPersistenceIdentity> | null;
  signal: AbortSignal;
  /** C3/C5-compatible synchronous currentness predicate. */
  isCurrent: () => boolean;
  /** Use inside the actual persistence transaction, including after awaited writes. */
  assertCurrent: () => void;
  /** Runs a synchronous publication only while the captured operation is current. */
  guard: <T>(callback: () => T) => T | undefined;
  /** Releases this operation only; it never ends the application/connection lifetime. */
  dispose: () => void;
  /** Adds a listener owned by this operation and returns idempotent owned cleanup. */
  onCancel: (listener: () => void) => () => void;
}>;

export type MpcCalibrationOperationScope = Readonly<{
  captureAppOperation: () => MpcCalibrationCapturedOperation;
  captureUiOperation: () => MpcCalibrationCapturedOperation;
  replaceTarget: (target: MpcCalibrationTransportTarget) => void;
  replaceController: (controller: unknown) => void;
  replaceConnection: (connection: unknown) => void;
  replaceAuthentication: (authentication: unknown) => void;
  replaceIdentity: (identity: CalibrationHarnessPersistenceIdentity | null) => void;
  /** Ends the app/connection owner and invalidates every remaining captured operation. */
  dispose: () => void;
}>;

export class MpcCalibrationOperationCancelledError extends Error {
  constructor() {
    super("calibration operation is no longer current");
    this.name = "MpcCalibrationOperationCancelledError";
  }
}

type Context = {
  target: MpcCalibrationTransportTarget;
  identity: Readonly<CalibrationHarnessPersistenceIdentity> | null;
  controller: unknown;
  connection: unknown;
  authentication: unknown;
};

type ActiveOperation = {
  generation: symbol;
  controller: AbortController;
  cancel: () => void;
};

function captureIdentity(
  value: CalibrationHarnessPersistenceIdentity | null
): Readonly<CalibrationHarnessPersistenceIdentity> | null {
  if (value === null) return null;
  const identity = validateCalibrationHarnessPersistenceIdentity(value);
  return Object.freeze({
    ownerId: identity.ownerId,
    harnessId: identity.harnessId,
    connectionId: identity.connectionId,
  });
}

function captureTarget(value: MpcCalibrationTransportTarget): MpcCalibrationTransportTarget {
  if (value === "local" || value === "linked-web" || value === "linked-electron") return value;
  throw new TypeError("Invalid calibration transport target");
}

/**
 * Owns only local AbortControllers and operation bookkeeping. Aborting renderer
 * work requests local promise cancellation; it does not claim a physical IPC
 * write has stopped or clear any downstream protocol state.
 */
export function createMpcCalibrationOperationScope(
  options: MpcCalibrationOperationScopeOptions
): MpcCalibrationOperationScope {
  let context: Context = {
    target: captureTarget(options.target),
    identity: captureIdentity(options.identity),
    controller: options.controller,
    connection: options.connection,
    authentication: options.authentication,
  };
  let currentGeneration = Symbol("mpc-calibration-operation");
  let appAlive = true;
  const active = new Set<ActiveOperation>();

  const invalidateAppLifetime = () => {
    currentGeneration = Symbol("mpc-calibration-operation");
    for (const operation of [...active]) operation.cancel();
  };

  const capture = (): MpcCalibrationCapturedOperation => {
    const capturedContext = context;
    const capturedGeneration = currentGeneration;
    const controller = new AbortController();
    const listeners = new Set<() => void>();
    let disposed = false;
    const activeOperation: ActiveOperation = {
      generation: capturedGeneration,
      controller,
      cancel: () => {},
    };
    const isCurrent = () => appAlive
      && !disposed
      && !controller.signal.aborted
      && currentGeneration === capturedGeneration
      && active.has(activeOperation);
    const releaseListeners = () => {
      for (const listener of listeners) controller.signal.removeEventListener("abort", listener);
      listeners.clear();
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      active.delete(activeOperation);
      controller.abort();
      releaseListeners();
    };
    activeOperation.cancel = dispose;
    if (appAlive) {
      active.add(activeOperation);
    } else {
      disposed = true;
      controller.abort();
    }

    return {
      target: capturedContext.target,
      identity: capturedContext.identity,
      signal: controller.signal,
      isCurrent,
      assertCurrent() {
        if (!isCurrent()) throw new MpcCalibrationOperationCancelledError();
      },
      guard<T>(callback: () => T): T | undefined {
        return isCurrent() ? callback() : undefined;
      },
      dispose,
      onCancel(listener: () => void): () => void {
        if (controller.signal.aborted) {
          listener();
          return () => {};
        }
        const ownedListener = () => listener();
        listeners.add(ownedListener);
        controller.signal.addEventListener("abort", ownedListener, { once: true });
        let removed = false;
        return () => {
          if (removed) return;
          removed = true;
          listeners.delete(ownedListener);
          controller.signal.removeEventListener("abort", ownedListener);
        };
      },
    };
  };

  const replace = (next: Partial<Context>) => {
    if (!appAlive) return;
    context = { ...context, ...next };
    invalidateAppLifetime();
  };

  return {
    captureAppOperation: capture,
    captureUiOperation: capture,
    replaceTarget(target) {
      replace({ target: captureTarget(target) });
    },
    replaceController(controller) {
      replace({ controller });
    },
    replaceConnection(connection) {
      replace({ connection });
    },
    replaceAuthentication(authentication) {
      replace({ authentication });
    },
    replaceIdentity(identity) {
      replace({ identity: captureIdentity(identity) });
    },
    dispose() {
      if (!appAlive) return;
      appAlive = false;
      invalidateAppLifetime();
    },
  };
}
