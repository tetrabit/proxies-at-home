import { validateCalibrationHarnessPersistenceIdentity } from "../../../shared/calibrationHarnessLocalState";
import type { MpcCalibrationCapturedOperation } from "./mpcCalibrationOperationScope";

export type MpcCalibrationQueueTriggerOptions = Readonly<{
  operation: MpcCalibrationCapturedOperation;
  drain: (observedGeneration: number) => Promise<void>;
  /** Bounded failure notification; errors are intentionally not forwarded. */
  onFailure?: () => void;
}>;

export type MpcCalibrationQueueTrigger = Readonly<{
  /** Records a valid observed queue generation for one coalesced drain attempt. */
  notify: (generation: number) => boolean;
  /** Fences future callback starts without claiming a running callback has stopped. */
  dispose: () => void;
  /** True only while a supplied drain promise has not physically settled. */
  isRunning: () => boolean;
}>;

type CapturedTriggerDependencies = Readonly<{
  signal: AbortSignal;
  isCurrent: () => boolean;
  drain: (observedGeneration: number) => Promise<void>;
  onFailure: (() => void) | undefined;
}>;

function signalAborted(signal: AbortSignal): boolean {
  const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
  if (typeof getter !== "function") throw new TypeError("AbortSignal unavailable");
  const aborted = getter.call(signal);
  if (typeof aborted !== "boolean") throw new TypeError("Invalid AbortSignal");
  return aborted;
}

function captureDependencies(
  options: MpcCalibrationQueueTriggerOptions
): CapturedTriggerDependencies | undefined {
  try {
    const operation = options.operation;
    const target = operation.target;
    const identity = operation.identity;
    const signal = operation.signal;
    const isCurrent = operation.isCurrent;
    const drain = options.drain;
    const onFailure = options.onFailure;

    if ((target !== "linked-web" && target !== "linked-electron") || identity === null) return undefined;
    validateCalibrationHarnessPersistenceIdentity(identity);
    if (!(signal instanceof AbortSignal) || typeof isCurrent !== "function" || typeof drain !== "function") return undefined;
    signalAborted(signal);
    if (onFailure !== undefined && typeof onFailure !== "function") return undefined;

    return {
      signal,
      isCurrent: isCurrent.bind(operation),
      drain: drain.bind(options),
      onFailure: onFailure?.bind(options),
    };
  } catch {
    return undefined;
  }
}

function isPositiveSafeGeneration(generation: number): boolean {
  return Number.isSafeInteger(generation) && generation > 0;
}

/**
 * Coalesces observed durable-queue generations into dependency-injected drain
 * callbacks. It deliberately neither observes nor changes queue persistence,
 * acknowledgements, or settlement state.
 */
export function createMpcCalibrationQueueTrigger(
  options: MpcCalibrationQueueTriggerOptions
): MpcCalibrationQueueTrigger {
  const dependencies = captureDependencies(options);
  let disposed = false;
  let scheduled = false;
  let physicallyRunning = false;
  let runningGeneration: number | undefined;
  let pendingGeneration: number | undefined;

  const current = (): boolean => {
    if (disposed || dependencies === undefined) return false;
    try {
      if (signalAborted(dependencies.signal) || dependencies.isCurrent() !== true) return false;
      const stillActive = !disposed;
      const stillUnaborted = !signalAborted(dependencies.signal);
      return stillActive && stillUnaborted;
    } catch {
      return false;
    }
  };

  const notifyFailure = () => {
    if (!current() || dependencies?.onFailure === undefined) return;
    try {
      dependencies.onFailure();
    } catch {
      // A bounded notification must not strand the physical-settlement state.
    }
  };

  const schedule = () => {
    if (scheduled || physicallyRunning || pendingGeneration === undefined) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!current() || physicallyRunning || pendingGeneration === undefined) {
        if (!current()) pendingGeneration = undefined;
        return;
      }

      const generation = pendingGeneration;
      pendingGeneration = undefined;
      physicallyRunning = true;
      runningGeneration = generation;
      let settlement: Promise<void>;
      try {
        settlement = Promise.resolve(dependencies!.drain(generation));
      } catch {
        settlement = Promise.reject();
      }
      void settlement.then(
        () => settle(),
        () => settle(true)
      );
    });
  };

  const settle = (failed = false) => {
    physicallyRunning = false;
    runningGeneration = undefined;
    if (failed) notifyFailure();
    if (!current()) {
      pendingGeneration = undefined;
      return;
    }
    schedule();
  };

  return {
    notify(generation) {
      if (!isPositiveSafeGeneration(generation) || !current()) return false;
      if (physicallyRunning) {
        if (runningGeneration === undefined || generation > runningGeneration) {
          pendingGeneration = Math.max(pendingGeneration ?? generation, generation);
        }
        return true;
      }
      pendingGeneration = Math.max(pendingGeneration ?? generation, generation);
      schedule();
      return true;
    },
    dispose() {
      disposed = true;
      pendingGeneration = undefined;
    },
    isRunning() {
      return physicallyRunning;
    },
  };
}
