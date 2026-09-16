import type { ProxxiedDexie } from "@/db";
import { canonicalHarnessJson } from "../../../shared/calibrationHarness";
import type { CalibrationHarnessPersistenceIdentity } from "../../../shared/calibrationHarnessLocalState";
import { hydrateMpcCalibrationCache } from "./mpcCalibrationCache";
import type { MpcCalibrationCapturedOperation, MpcCalibrationOperationScope } from "./mpcCalibrationOperationScope";
import { getMpcCalibrationRetryDecision } from "./mpcCalibrationRetryPolicy";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";
import { MpcCalibrationTransportError, type MpcCalibrationTransport } from "./mpcCalibrationTransport";
import type { MpcCalibrationElectronBridge } from "./mpcCalibrationElectronTransport";
import { selectMpcCalibrationTransport, type MpcCalibrationTransportTarget } from "./mpcCalibrationTransportSelection";
import { identityLogFields, mpcCalibrationLogError, mpcCalibrationLogInfo, mpcCalibrationLogWarn } from "./mpcCalibrationLog";

type TimerHandle = ReturnType<typeof setTimeout>;
type TimerHost = Readonly<{
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
  setInterval: (callback: () => void, delayMs: number) => TimerHandle;
  clearInterval: (handle: TimerHandle) => void;
}>;
type EventSource = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export type MpcCalibrationRefreshSchedulerStatus =
  | Readonly<{ kind: "local" }>
  | Readonly<{ kind: "refreshing" }>
  | Readonly<{ kind: "hydrated"; revision: number }>
  | Readonly<{ kind: "no-newer" }>
  | Readonly<{ kind: "retrying"; attempt: number; delayMs: number }>
  | Readonly<{ kind: "blocked"; reason?: string }>
  | Readonly<{ kind: "needs-reconciliation"; reason?: string }>
  | Readonly<{ kind: "unavailable"; reason?: string }>
  | Readonly<{ kind: "cancelled" }>;

/** Why a terminal scheduler outcome refused to continue. Surfaces verbatim in the UI. */
export type MpcCalibrationRefreshSchedulerTerminalReason =
  | "missing-identity-or-database"
  | "transport-unavailable"
  | "service-unavailable"
  | "retries-exhausted"
  | "session-identity-mismatch"
  | "stale-local-base"
  | "remote-diverged"
  | (string & {});
type C3Classification =
  | Readonly<{ kind: "no-newer" }>
  | Readonly<{ kind: "blocked"; reason: "stale-local-base" | "session-identity-mismatch" | "remote-diverged" }>
  | Readonly<{ kind: "retry" }>;

export type MpcCalibrationRefreshSchedulerOptions = Readonly<{
  database?: ProxxiedDexie;
  operationScope: Pick<MpcCalibrationOperationScope, "captureAppOperation">;
  target: MpcCalibrationTransportTarget;
  createWebTransport?: () => MpcCalibrationTransport;
  electronBridge?: MpcCalibrationElectronBridge;
  intervalMs?: number;
  events?: EventSource;
  timers?: TimerHost;
  now?: () => number;
  onStatus?: (status: MpcCalibrationRefreshSchedulerStatus) => void;
}>;

export type MpcCalibrationRefreshScheduler = Readonly<{
  /** Starts one immediate refresh plus owned periodic and online triggers. */
  start: () => Promise<void>;
  /** Stops future starts and local notifications; it does not claim transport cancellation. */
  dispose: () => void;
}>;

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 3_600_000;

function isTarget(value: unknown): value is MpcCalibrationTransportTarget {
  return value === "local" || value === "linked-web" || value === "linked-electron";
}

function isCurrent(operation: Pick<MpcCalibrationCapturedOperation, "signal" | "isCurrent">): boolean {
  try {
    const signal = operation.signal;
    // Preserve the operation receiver while making one currentness decision.
    // The predicate is reentrant: it may abort this signal before returning.
    const operationIsCurrent = operation.isCurrent.bind(operation);
    if (operationIsCurrent() !== true) return false;
    // Read the platform brand getter, never a possibly shadowed instance field.
    // C3 only needs a real AbortSignal; a forged `aborted: false` must not admit I/O.
    const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get?.call(signal);
    return aborted === false;
  } catch {
    return false;
  }
}

function sameIdentity(
  left: Pick<CalibrationHarnessPersistenceIdentity, "ownerId" | "harnessId" | "connectionId">,
  right: Pick<CalibrationHarnessPersistenceIdentity, "ownerId" | "harnessId" | "connectionId">,
): boolean {
  return left.ownerId === right.ownerId && left.harnessId === right.harnessId && left.connectionId === right.connectionId;
}

function cleanBase(state: Awaited<ReturnType<ReturnType<typeof createMpcCalibrationSyncStateStore>["load"]>>) {
  if (state === undefined || state.base === null || state.queued !== null || state.inFlight !== null) return undefined;
  const settled = state.formatVersion === 2 ? state.settledGeneration : state.acknowledgedGeneration;
  return state.dirtyGeneration === settled ? state.base : undefined;
}

function transientOutcome(error: unknown): "offline" | "timeout" | undefined {
  return error instanceof MpcCalibrationTransportError && (error.code === "offline" || error.code === "timeout")
    ? error.code
    : undefined;
}

/**
 * App-owned clean-cache refresh controller. It reaches C3 for admissible linked
 * refreshes and never uses C5/no-queued as a refresh result. Retry ownership is
 * held by the captured app operation until its retry fires or that operation is
 * invalidated, so an idle replacement cannot retarget a queued callback.
 */
export function createMpcCalibrationRefreshScheduler(
  options: MpcCalibrationRefreshSchedulerOptions,
): MpcCalibrationRefreshScheduler {
  const scope = options.operationScope;
  const target = options.target;
  const now = options.now;
  const statusCallback = options.onStatus === undefined ? undefined : options.onStatus.bind(options);
  const events = options.events ?? (typeof window !== "undefined" ? window : new EventTarget());
  const timersSource = options.timers ?? globalThis;
  const timers: TimerHost = {
    setTimeout: timersSource.setTimeout.bind(timersSource),
    clearTimeout: timersSource.clearTimeout.bind(timersSource),
    setInterval: timersSource.setInterval.bind(timersSource),
    clearInterval: timersSource.clearInterval.bind(timersSource),
  };
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  let disposed = false;
  let started = false;
  let running = false;
  let queued = false;
  let retryAttempts = 0;
  let retryExhausted = false;
  let retryTimer: TimerHandle | undefined;
  let intervalTimer: TimerHandle | undefined;
  let active: MpcCalibrationCapturedOperation | undefined;
  // This remains captured after an individual refresh settles. It fences the
  // scheduler's app/connection lifetime so idle triggers cannot retarget it.
  let lifetime: MpcCalibrationCapturedOperation | undefined;
  let removeLifetimeCancellation: (() => void) | undefined;
  let retryOperation: MpcCalibrationCapturedOperation | undefined;
  let activeRun: Promise<void> | undefined;

  const hasCurrentLifetime = (): boolean => lifetime !== undefined && isCurrent(lifetime);
  const isRunCurrent = (operation: MpcCalibrationCapturedOperation | undefined): boolean => !disposed
    && hasCurrentLifetime()
    && !disposed
    && (operation === undefined || isCurrent(operation))
    && !disposed;
  const releaseLifetime = () => {
    const operation = lifetime;
    lifetime = undefined;
    const removeCancellation = removeLifetimeCancellation;
    removeLifetimeCancellation = undefined;
    removeCancellation?.();
    operation?.dispose();
  };
  const emit = (operation: MpcCalibrationCapturedOperation | undefined, status: MpcCalibrationRefreshSchedulerStatus): boolean => {
    if (!isRunCurrent(operation)) return false;
    try { statusCallback?.(status); } catch { /* status consumers are not authority */ }
    return isRunCurrent(operation);
  };

  const clearRetryTimer = () => {
    if (retryTimer !== undefined) timers.clearTimeout(retryTimer);
    retryTimer = undefined;
    retryOperation = undefined;
  };

  const stopOwnedTriggers = () => {
    disposed = true;
    queued = false;
    clearRetryTimer();
    releaseLifetime();
    if (intervalTimer !== undefined) timers.clearInterval(intervalTimer);
    intervalTimer = undefined;
    events.removeEventListener("online", onOnline);
  };

  const classifyC3Block = async (
    operation: MpcCalibrationCapturedOperation,
    transport: Pick<MpcCalibrationTransport, "getSession" | "getSnapshot">,
    database: ProxxiedDexie,
    identity: CalibrationHarnessPersistenceIdentity,
    isRunCurrent: () => boolean,
    ): Promise<C3Classification> => {
    try {
      const base = cleanBase(await createMpcCalibrationSyncStateStore(database, { now }).load(identity));
      const binding = await database.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding");
      if (!isRunCurrent() || base === undefined || binding === undefined || !sameIdentity(binding, identity)) {
        return { kind: "blocked", reason: "stale-local-base" };
      }
      const session = await transport.getSession({ signal: operation.signal });
      if (!isRunCurrent() || session.ownerId !== identity.ownerId || session.harnessId !== identity.harnessId) {
        return { kind: "blocked", reason: "session-identity-mismatch" };
      }
      const remote = await transport.getSnapshot({ signal: operation.signal });
      if (!isRunCurrent() || remote === null || remote.revision !== base.revision) {
        return { kind: "blocked", reason: "remote-diverged" };
      }
      return canonicalHarnessJson(remote.snapshot) === canonicalHarnessJson(base.snapshot)
        ? { kind: "no-newer" }
        : { kind: "blocked", reason: "remote-diverged" };
    } catch (error) {
      return transientOutcome(error) === undefined
        ? { kind: "blocked", reason: "stale-local-base" }
        : { kind: "retry" };
    }
  };

  const run = async () => {
    if (disposed || running || retryExhausted || !isRunCurrent(undefined)) {
      if (!disposed) stopOwnedTriggers();
      return;
    }
    running = true;
    const operation = scope.captureAppOperation();
    active = operation;
    let releasingOperation = false;
    const removeCancellation = operation.onCancel(() => {
      // A replacement/abort revokes this scheduler's right to start a later run.
      // Deliberate release after a settled run is distinguished below.
      if (!releasingOperation && active === operation && !disposed) stopOwnedTriggers();
    });
    const releaseOperation = () => {
      releasingOperation = true;
      if (active === operation) active = undefined;
      operation.dispose();
      removeCancellation();
    };
    const scheduleRetry = (outcome: "offline" | "timeout"): boolean => {
      const decision = getMpcCalibrationRetryDecision(outcome, retryAttempts);
      if (decision.kind !== "retry") {
        retryExhausted = true;
        terminal({ kind: "unavailable", reason: "retries-exhausted" });
        return false;
      }
      retryAttempts = decision.nextAttempt;
      if (!emit(operation, { kind: "retrying", attempt: decision.nextAttempt, delayMs: decision.delayMs })) return false;
      if (!isRunCurrent(operation)) return false;
      retryOperation = operation;
      retryTimer = timers.setTimeout(() => {
        retryTimer = undefined;
        if (retryOperation !== operation) return;
        retryOperation = undefined;
        if (!isRunCurrent(operation)) {
          stopOwnedTriggers();
          return;
        }
        releaseOperation();
        void request();
      }, decision.delayMs);
      return true;
    };
    const terminal = (status: Extract<MpcCalibrationRefreshSchedulerStatus, { kind: "blocked" | "needs-reconciliation" | "unavailable" | "cancelled" }>) => {
      const reason = "reason" in status ? status.reason : undefined;
      if (status.kind === "cancelled") mpcCalibrationLogInfo("refresh terminal outcome", { kind: status.kind, ...identityLogFields(operation.identity ?? undefined) });
      else mpcCalibrationLogWarn("refresh terminal outcome", { kind: status.kind, reason, ...identityLogFields(operation.identity ?? undefined) });
      emit(operation, status);
      stopOwnedTriggers();
    };

    try {
      if (!isTarget(target) || target !== operation.target || !isRunCurrent(operation)) return;
      if (target === "local") {
        emit(operation, { kind: "local" });
        return;
      }

      // Do not discover persistence or a transport capability before the app
      // operation has proved current; these option fields can be dormant getters.
      const database = options.database;
      const createWebTransport = target === "linked-web" ? options.createWebTransport : undefined;
      const electronBridge = target === "linked-electron" ? options.electronBridge : undefined;
      const identity = operation.identity;
      if (!isRunCurrent(operation)) return;
      if (identity === null || database === undefined) {
        terminal({ kind: "blocked", reason: "missing-identity-or-database" });
        return;
      }
      let selected: MpcCalibrationTransport;
      try {
        selected = selectMpcCalibrationTransport({ target, createWebTransport, electronBridge });
      } catch (error) {
        mpcCalibrationLogError("transport selection threw", error, { reason: "transport-unavailable" });
        terminal({ kind: "unavailable", reason: "transport-unavailable" });
        return;
      }
      let c3Transient: "offline" | "timeout" | undefined;
      const recordC3Error = (error: unknown) => {
        const outcome = transientOutcome(error);
        if (outcome !== undefined) c3Transient = outcome;
      };
      const transport = {
        getSession: async (...args: Parameters<MpcCalibrationTransport["getSession"]>) => {
          try { return await selected.getSession(...args); } catch (error) { recordC3Error(error); throw error; }
        },
        getSnapshot: async (...args: Parameters<MpcCalibrationTransport["getSnapshot"]>) => {
          try { return await selected.getSnapshot(...args); } catch (error) { recordC3Error(error); throw error; }
        },
        getBlob: async (...args: Parameters<MpcCalibrationTransport["getBlob"]>) => {
          try { return await selected.getBlob(...args); } catch (error) { recordC3Error(error); throw error; }
        },
      };
      if (!emit(operation, { kind: "refreshing" })) return;

      try {
        const session = await transport.getSession({ signal: operation.signal });
        if (!isRunCurrent(operation)) return;
        if (session.ownerId !== identity.ownerId || session.harnessId !== identity.harnessId) {
          terminal({ kind: "blocked", reason: "session-identity-mismatch" });
          return;
        }
      } catch (error) {
        if (!isRunCurrent(operation)) return;
        const outcome = transientOutcome(error);
        if (outcome !== undefined) {
          scheduleRetry(outcome);
        } else {
          terminal({ kind: "unavailable", reason: "service-unavailable" });
        }
        return;
      }

      const result = await hydrateMpcCalibrationCache({
        database,
        transport,
        identity,
        signal: operation.signal,
        operation: { isCurrent: () => isRunCurrent(operation) },
        now,
      });
      if (!isRunCurrent(operation)) return;
      if (result.status === "hydrated" && result.revision !== undefined) {
        retryAttempts = 0;
        emit(operation, { kind: "hydrated", revision: result.revision });
      } else if (result.status === "blocked") {
        const classification = await classifyC3Block(operation, transport, database, identity, () => isRunCurrent(operation));
        if (!isRunCurrent(operation)) return;
        if (classification.kind === "no-newer") {
          retryAttempts = 0;
          emit(operation, { kind: "no-newer" });
        } else if (classification.kind === "retry") {
          scheduleRetry(c3Transient ?? "offline");
        } else {
          terminal({ kind: "blocked", reason: classification.reason });
        }
      } else if (result.status === "failed" && c3Transient !== undefined) {
        scheduleRetry(c3Transient);
      } else if (result.status === "needs-reconciliation") {
        terminal({ kind: "needs-reconciliation", reason: result.reason });
      } else if (result.status === "cancelled") {
        terminal({ kind: "cancelled" });
      } else if (result.status === "failed") {
        terminal({ kind: "unavailable", reason: result.reason ?? "refresh-failed" });
      } else {
        terminal({ kind: "unavailable", reason: "unspecified" });
      }
    } finally {
      running = false;
      if (retryOperation !== operation) {
        releaseOperation();
        if (queued && !disposed && !retryExhausted && retryTimer === undefined) {
          queued = false;
          void request();
        } else {
          queued = false;
        }
      }
    }
  };

  const request = (): Promise<void> | undefined => {
    if (disposed || retryExhausted || retryTimer !== undefined) return undefined;
    if (!isRunCurrent(undefined)) {
      stopOwnedTriggers();
      return undefined;
    }
    if (running) {
      queued = true;
      return activeRun;
    }
    const pending = run();
    activeRun = pending;
    void pending.finally(() => {
      if (activeRun === pending) activeRun = undefined;
    });
    return pending;
  };

  const onOnline = () => request();

  return {
    start() {
      if (started || disposed || !Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) return Promise.resolve();
      const operation = scope.captureAppOperation();
      lifetime = operation;
      const removeCancellation = operation.onCancel(() => {
        if (lifetime === operation && !disposed) stopOwnedTriggers();
      });
      if (lifetime === operation) removeLifetimeCancellation = removeCancellation;
      else removeCancellation();
      if (!isRunCurrent(undefined)) {
        stopOwnedTriggers();
        return Promise.resolve();
      }
      started = true;
      events.addEventListener("online", onOnline);
      intervalTimer = timers.setInterval(request, intervalMs);
      return request() ?? Promise.resolve();
    },
    dispose() {
      if (disposed) return;
      stopOwnedTriggers();
      active?.dispose();
      active = undefined;
    },
  };
}
