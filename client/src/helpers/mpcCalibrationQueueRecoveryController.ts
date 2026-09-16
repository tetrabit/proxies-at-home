import { liveQuery } from "dexie";
import type { ProxxiedDexie } from "@/db";
import {
  validateCalibrationHarnessPersistenceIdentity,
  type CalibrationHarnessPersistenceIdentity,
} from "../../../shared/calibrationHarnessLocalState";
import type { MpcCalibrationCapturedOperation } from "./mpcCalibrationOperationScope";
import {
  dispatchMpcCalibrationQueuedRecovery,
  type MpcCalibrationQueuedRecoveryResult,
} from "./mpcCalibrationQueuedRecovery";
import { identityLogFields, mpcCalibrationLogInfo } from "./mpcCalibrationLog";
import { createMpcCalibrationQueueTrigger, type MpcCalibrationQueueTrigger } from "./mpcCalibrationQueueTrigger";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";
import type { MpcCalibrationTransport } from "./mpcCalibrationTransport";
import type { MpcCalibrationTransportTarget } from "./mpcCalibrationTransportSelection";

type MpcCalibrationLinkedTransportTarget = Exclude<MpcCalibrationTransportTarget, "local">;

export type MpcCalibrationQueueRecoveryControllerOptions = Readonly<{
  database: ProxxiedDexie;
  /** One app-owned linked operation; its target, identity, signal and fence are retained for C5. */
  operation: MpcCalibrationCapturedOperation;
  /** Already selected transport; this controller never authenticates or selects a target. */
  transport: MpcCalibrationTransport;
  /** Bounded notification for an unexpected drain rejection. */
  onFailure?: () => void;
  /** Closed C5 outcome only; stale/cancelled/disposed owners receive nothing. */
  onResult?: (result: MpcCalibrationQueuedRecoveryResult) => void;
}>;

export type MpcCalibrationQueueRecoveryController = Readonly<{
  /** Fences future durable notifications; a started C5 still physically settles. */
  dispose: () => void;
  /** True until a dispatched C5 promise physically settles. */
  isRunning: () => boolean;
}>;

type CapturedControllerOptions = Readonly<{
  database: ProxxiedDexie;
  operation: MpcCalibrationCapturedOperation;
  target: MpcCalibrationLinkedTransportTarget;
  identity: CalibrationHarnessPersistenceIdentity;
  transport: MpcCalibrationTransport;
  onFailure: (() => void) | undefined;
  onResult: ((result: MpcCalibrationQueuedRecoveryResult) => void) | undefined;
  signal: AbortSignal;
  isCurrent: () => boolean;
}>;

function captureOptions(
  supplied: MpcCalibrationQueueRecoveryControllerOptions
): CapturedControllerOptions | undefined {
  try {
    const database = supplied.database;
    const operation = supplied.operation;
    const target = operation.target;
    const rawIdentity = operation.identity;
    const transport = supplied.transport;
    const onFailure = supplied.onFailure;
    const onResult = supplied.onResult;
    const signal = operation.signal;
    const isCurrent = operation.isCurrent;
    if (
      (target !== "linked-web" && target !== "linked-electron") || rawIdentity === null || transport === null ||
      !(signal instanceof AbortSignal) || typeof isCurrent !== "function"
    ) return undefined;
    if (
      (onFailure !== undefined && typeof onFailure !== "function") ||
      (onResult !== undefined && typeof onResult !== "function")
    ) return undefined;
    const validIdentity = validateCalibrationHarnessPersistenceIdentity(rawIdentity);
    return {
      database,
      operation,
      target,
      identity: {
        ownerId: validIdentity.ownerId,
        harnessId: validIdentity.harnessId,
        connectionId: validIdentity.connectionId,
      },
      transport,
      onFailure: onFailure?.bind(supplied),
      onResult: onResult?.bind(supplied),
      signal,
      isCurrent: isCurrent.bind(operation),
    };
  } catch {
    return undefined;
  }
}

function inertController(): MpcCalibrationQueueRecoveryController {
  return { dispose() {}, isRunning: () => false };
}

function operationCurrent(captured: Pick<CapturedControllerOptions, "signal" | "isCurrent">): boolean {
  try {
    const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get?.call(captured.signal);
    if (aborted !== false || captured.isCurrent() !== true) return false;
    return Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get?.call(captured.signal) === false;
  } catch {
    return false;
  }
}

/**
 * App-lifetime owner for identity-scoped durable C1 queue notifications. Each
 * real IndexedDB update is observed through Dexie liveQuery, coalesced by the
 * existing fenced trigger, then dispatched to the actual C5 recovery producer.
 * It never polls, authenticates, clears queue evidence, or treats a G1 result
 * as settlement for a newer G2. Disposal only prevents future callback starts.
 */
export function createMpcCalibrationQueueRecoveryController(
  supplied: MpcCalibrationQueueRecoveryControllerOptions
): MpcCalibrationQueueRecoveryController {
  const captured = captureOptions(supplied);
  if (captured === undefined) return inertController();

  const state = createMpcCalibrationSyncStateStore(captured.database);
  let disposed = false;
  const notifyResult = (result: MpcCalibrationQueuedRecoveryResult) => {
    if (disposed || !operationCurrent(captured) || captured.onResult === undefined) return;
    try {
      captured.onResult(result);
    } catch {
      // Consumer failures cannot alter durable C5 settlement or trigger state.
    }
  };
  let trigger: MpcCalibrationQueueTrigger;
  try {
    trigger = createMpcCalibrationQueueTrigger({
      operation: captured.operation,
      onFailure: captured.onFailure,
      async drain() {
        mpcCalibrationLogInfo("queue recovery trigger fired", { target: captured.target, ...identityLogFields(captured.identity) });
        const result = await dispatchMpcCalibrationQueuedRecovery({
          database: captured.database,
          target: captured.target,
          identity: captured.identity,
          transport: captured.transport,
          operation: captured.operation,
        });
        notifyResult(result);
      },
    });
  } catch {
    return inertController();
  }

  let subscription: { unsubscribe: () => void } | undefined;
  try {
    subscription = liveQuery(async () => {
      const loaded = await state.load(captured.identity);
      return loaded?.queued?.generation;
    }).subscribe({
      next(generation) {
        if (disposed || generation === undefined) return;
        // liveQuery may deliver a valid prior observation after C5 has ACKed it.
        // Re-read the exact identity-scoped row before admission so an old G1
        // callback cannot manufacture a no-queue drain after G1/G2 settlement.
        void state.load(captured.identity).then(
          latest => {
            if (!disposed && latest?.queued?.generation === generation) trigger.notify(generation);
          },
          () => {
            // A corrupt or inaccessible C1 row remains untouched; no recovery runs.
          }
        );
      },
      error() {
        // A corrupt or inaccessible C1 row remains untouched; no recovery runs.
      },
    });
  } catch {
    trigger.dispose();
    return inertController();
  }

  // Dexie can have no change notification for a queue that existed before this
  // app owner subscribed, so recover one validated persisted generation now.
  void state.load(captured.identity).then(
    latest => {
      const generation = latest?.queued?.generation;
      if (!disposed && operationCurrent(captured) && generation !== undefined) trigger.notify(generation);
    },
    () => {
      // A corrupt or inaccessible C1 row remains untouched; no recovery runs.
    }
  );

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      subscription?.unsubscribe();
      trigger.dispose();
    },
    isRunning() {
      return trigger.isRunning();
    },
  };
}
