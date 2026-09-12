import type { ProxxiedDexie } from "@/db";
import {
  validateCalibrationHarnessPersistenceIdentity,
  type CalibrationHarnessPersistenceIdentity,
} from "../../../shared/calibrationHarnessLocalState";
import {
  recoverAndFlushMpcCalibration,
  type MpcCalibrationRecoveryInput,
  type MpcCalibrationRecoveryResult,
  type MpcCalibrationRecoveryStatus,
} from "./mpcCalibrationRecovery";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";
import type { MpcCalibrationCapturedOperation } from "./mpcCalibrationOperationScope";
import type { MpcCalibrationTransport } from "./mpcCalibrationTransport";
import type { MpcCalibrationTransportTarget } from "./mpcCalibrationTransportSelection";

type MpcCalibrationLinkedTransportTarget = Exclude<MpcCalibrationTransportTarget, "local">;
type MpcCalibrationRecoveryTransport = MpcCalibrationRecoveryInput["transport"];
type MpcCalibrationDispatchStatus = Exclude<MpcCalibrationRecoveryStatus, "no-queued">;

export type MpcCalibrationQueuedRecoveryResult =
  | Readonly<{ kind: "local"; target: "local" }>
  | Readonly<{ kind: "no-queued-work"; target: MpcCalibrationLinkedTransportTarget }>
  | Readonly<{ kind: "cancelled"; target: MpcCalibrationLinkedTransportTarget; generation?: number; revision?: number }>
  | Readonly<{ kind: "rejected"; target?: MpcCalibrationLinkedTransportTarget; status: "invalid-operation" | "invalid-identity" | "unavailable" }>
  | Readonly<{
    kind: "recovery";
    target: MpcCalibrationLinkedTransportTarget;
    status: MpcCalibrationDispatchStatus;
    generation?: number;
    revision?: number;
  }>;

export type MpcCalibrationQueuedRecoveryInput = Readonly<{
  database: ProxxiedDexie;
  /** Undefined is the sole local default; null and unknown values are rejected. */
  target?: MpcCalibrationTransportTarget;
  /** A controller-provided, previously authenticated non-secret persistence identity. */
  identity?: CalibrationHarnessPersistenceIdentity;
  /** The already selected common transport. No request authority is accepted here. */
  transport?: MpcCalibrationTransport;
  signal?: AbortSignal;
  /**
   * Controller calls supply the full operation captured by the owner. A bare
   * isCurrent callback remains a standalone lifetime fence only; it carries no
   * target, identity, or cancellation provenance and cannot substitute for a
   * malformed captured controller operation.
   */
  operation?: MpcCalibrationCapturedOperation | Readonly<{ isCurrent?: () => boolean }>;
  /** Narrow deterministic test seam; production dispatches the accepted C5 producer. */
  recover?: (input: MpcCalibrationRecoveryInput) => Promise<MpcCalibrationRecoveryResult>;
}>;

function abortSignalAborted(signal: AbortSignal): boolean {
  const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
  if (typeof getter !== "function") throw new TypeError("AbortSignal aborted getter unavailable");
  const aborted = getter.call(signal);
  if (typeof aborted !== "boolean") throw new TypeError("invalid AbortSignal");
  return aborted;
}

function capturedAbortSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") throw new TypeError("invalid captured signal");
  abortSignalAborted(value as AbortSignal);
  return value as AbortSignal;
}

function current(signal: AbortSignal | undefined, isCurrent: (() => boolean) | undefined): boolean {
  try {
    return (signal === undefined || !abortSignalAborted(signal)) && (isCurrent === undefined || isCurrent() === true);
  } catch {
    return false;
  }
}

function c5CurrentOperation(
  signal: AbortSignal | undefined,
  isCurrent: (() => boolean) | undefined,
): Readonly<{ isCurrent: () => boolean }> | undefined {
  if (signal === undefined && isCurrent === undefined) return undefined;
  return { isCurrent: () => current(signal, isCurrent) };
}

function targetFrom(input: MpcCalibrationQueuedRecoveryInput): MpcCalibrationTransportTarget {
  const rawTarget: unknown = input.target;
  const target = rawTarget === undefined ? "local" : rawTarget;
  if (target === "local" || target === "linked-web" || target === "linked-electron") return target;
  throw new TypeError("invalid calibration queued-recovery target");
}

function capturedIdentity(value: CalibrationHarnessPersistenceIdentity | undefined): CalibrationHarnessPersistenceIdentity {
  if (value === undefined) throw new TypeError("linked queued recovery requires identity");
  const identity = validateCalibrationHarnessPersistenceIdentity(value);
  return { ownerId: identity.ownerId, harnessId: identity.harnessId, connectionId: identity.connectionId };
}

function capturedTransport(value: MpcCalibrationTransport | undefined): MpcCalibrationRecoveryTransport {
  if (value === undefined || value === null) throw new TypeError("linked queued recovery requires transport");
  return {
    getSession: value.getSession.bind(value),
    getSnapshot: value.getSnapshot.bind(value),
    getBlob: value.getBlob.bind(value),
    missingBlobs: value.missingBlobs.bind(value),
    putBlob: value.putBlob.bind(value),
    publishSnapshot: value.publishSnapshot.bind(value),
  };
}

function boundedPositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function mapResult(target: MpcCalibrationLinkedTransportTarget, result: MpcCalibrationRecoveryResult): MpcCalibrationQueuedRecoveryResult {
  try {
    if (result === null || typeof result !== "object") return { kind: "recovery", target, status: "failed" };
    const candidate = result as Readonly<{ status?: unknown; generation?: unknown; revision?: unknown }>;
    const status = candidate.status;
    if (status === "no-queued") return { kind: "no-queued-work", target };
    if (status !== "published" && status !== "conflict" && status !== "blocked" && status !== "cancelled" && status !== "pending" && status !== "failed") {
      return { kind: "recovery", target, status: "failed" };
    }
    const generation = boundedPositiveInteger(candidate.generation);
    const revision = boundedPositiveInteger(candidate.revision);
    return {
      kind: "recovery",
      target,
      status,
      ...(generation === undefined ? {} : { generation }),
      ...(revision === undefined ? {} : { revision }),
    };
  } catch {
    return { kind: "recovery", target, status: "failed" };
  }
}

function cancelledResult(
  target: MpcCalibrationLinkedTransportTarget,
  mapped?: MpcCalibrationQueuedRecoveryResult,
): MpcCalibrationQueuedRecoveryResult {
  if (mapped?.kind !== "recovery") return { kind: "cancelled", target };
  return {
    kind: "cancelled",
    target,
    ...(mapped.generation === undefined ? {} : { generation: mapped.generation }),
    ...(mapped.revision === undefined ? {} : { revision: mapped.revision }),
  };
}

function capturedOperation(
  value: MpcCalibrationQueuedRecoveryInput["operation"],
  target: MpcCalibrationLinkedTransportTarget,
  identity: CalibrationHarnessPersistenceIdentity,
  signalOverride: AbortSignal | undefined,
): Readonly<{ signal: AbortSignal | undefined; isCurrent: (() => boolean) | undefined }> {
  const validatedOverride = capturedAbortSignal(signalOverride);
  if (value === undefined) return { signal: validatedOverride, isCurrent: undefined };
  const operation = value as Record<string, unknown>;
  const hasCapturedMetadata = "target" in operation || "identity" in operation || "signal" in operation;
  if (!hasCapturedMetadata) {
    const isCurrent = operation.isCurrent;
    if (isCurrent !== undefined && typeof isCurrent !== "function") throw new TypeError("invalid standalone operation");
    return { signal: validatedOverride, isCurrent: isCurrent === undefined ? undefined : isCurrent.bind(value) };
  }

  const capturedTarget = operation.target;
  const capturedIdentity = operation.identity;
  const capturedSignal = capturedAbortSignal(operation.signal);
  const capturedCurrent = operation.isCurrent;
  if (capturedTarget !== target || capturedIdentity === null || typeof capturedIdentity !== "object" || capturedSignal === undefined || typeof capturedCurrent !== "function") {
    throw new TypeError("invalid captured operation");
  }
  const validatedIdentity = validateCalibrationHarnessPersistenceIdentity(capturedIdentity);
  if (validatedIdentity.ownerId !== identity.ownerId || validatedIdentity.harnessId !== identity.harnessId || validatedIdentity.connectionId !== identity.connectionId) {
    throw new TypeError("captured operation identity mismatch");
  }
  if (validatedOverride !== undefined && validatedOverride !== capturedSignal) throw new TypeError("captured operation signal mismatch");
  return { signal: capturedSignal, isCurrent: capturedCurrent.bind(value) };
}

/**
 * One controller-owned recovery action. It observes only the captured durable
 * C1 queue before invoking C5 once; it neither authenticates, drains, nor
 * interprets a C5 result as a clean remote synchronization claim.
 */
export async function dispatchMpcCalibrationQueuedRecovery(
  suppliedInput: MpcCalibrationQueuedRecoveryInput
): Promise<MpcCalibrationQueuedRecoveryResult> {
  let target: MpcCalibrationTransportTarget;
  try {
    target = targetFrom(suppliedInput);
  } catch {
    return { kind: "rejected", status: "invalid-operation" };
  }
  if (target === "local") return { kind: "local", target };

  let database: ProxxiedDexie;
  let identity: CalibrationHarnessPersistenceIdentity;
  let transport: MpcCalibrationRecoveryTransport;
  let signal: AbortSignal | undefined;
  let isCurrent: (() => boolean) | undefined;
  let recover: (input: MpcCalibrationRecoveryInput) => Promise<MpcCalibrationRecoveryResult>;
  let load: ReturnType<typeof createMpcCalibrationSyncStateStore>["load"];
  try {
    database = suppliedInput.database;
    identity = capturedIdentity(suppliedInput.identity);
    transport = capturedTransport(suppliedInput.transport);
  } catch {
    return { kind: "rejected", target, status: "invalid-identity" };
  }
  try {
    const operation = capturedOperation(suppliedInput.operation, target, identity, suppliedInput.signal);
    signal = operation.signal;
    isCurrent = operation.isCurrent;
    recover = suppliedInput.recover ?? recoverAndFlushMpcCalibration;
    const store = createMpcCalibrationSyncStateStore(database);
    load = store.load.bind(store);
  } catch {
    return { kind: "rejected", target, status: "invalid-operation" };
  }

  if (!current(signal, isCurrent)) return { kind: "cancelled", target };
  const c5Operation = c5CurrentOperation(signal, isCurrent);
  let loaded: Awaited<ReturnType<typeof load>>;
  try {
    loaded = await load(identity);
  } catch {
    // C1 rejects corrupt rows and owner/key mismatches without normalizing them.
    if (!current(signal, isCurrent)) return cancelledResult(target);
    return { kind: "recovery", target, status: "blocked" };
  }
  if (!current(signal, isCurrent)) return cancelledResult(target);
  if (loaded === undefined || loaded.queued === null) return { kind: "no-queued-work", target };

  let result: MpcCalibrationRecoveryResult;
  try {
    result = await recover({
      database,
      transport,
      identity,
      signal,
      operation: c5Operation,
    });
  } catch {
    if (!current(signal, isCurrent)) return cancelledResult(target);
    return { kind: "recovery", target, status: "failed" };
  }
  const mapped = mapResult(target, result);
  if (!current(signal, isCurrent)) return cancelledResult(target, mapped);
  return mapped;
}
