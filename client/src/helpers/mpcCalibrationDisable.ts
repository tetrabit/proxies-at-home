import type { MpcCalibrationLinkStateRecord, ProxxiedDexie } from "@/db";
import {
  validateCalibrationHarnessPersistenceIdentity,
  type CalibrationHarnessPersistenceIdentity,
} from "../../../shared/calibrationHarnessLocalState";
import {
  MpcCalibrationOperationCancelledError,
  type MpcCalibrationCapturedOperation,
  type MpcCalibrationOperationScope,
} from "./mpcCalibrationOperationScope";
import {
  MpcCalibrationTransportError,
  type MpcCalibrationSession,
  type MpcCalibrationTransport,
} from "./mpcCalibrationTransport";
import {
  selectMpcCalibrationTransport,
  type MpcCalibrationTransportTarget,
} from "./mpcCalibrationTransportSelection";

type DisableStatus = "offline" | "authentication" | "invalid-operation" | "unavailable";
type CapturedIdentity = Readonly<CalibrationHarnessPersistenceIdentity>;
type CapturedScope = Readonly<{
  captureAppOperation: () => MpcCalibrationCapturedOperation;
  replaceTarget: (target: MpcCalibrationTransportTarget) => void;
}>;
type CapturedOperation = Readonly<{
  target: MpcCalibrationTransportTarget;
  identity: CapturedIdentity | null;
  signal: AbortSignal;
  isCurrent: () => boolean;
  assertCurrent: () => void;
  guard: <T>(callback: () => T) => T | undefined;
  dispose: () => void;
}>;
type CapturedWeb = Readonly<{
  database?: ProxxiedDexie;
  createWebTransport?: () => MpcCalibrationTransport;
}>;

export type MpcCalibrationDisableInput = Readonly<{
  /** The controller-selected transport being disabled; this is never inferred. */
  target: MpcCalibrationTransportTarget;
  /** The existing controller owner that fences its pending app/UI work. */
  scope: MpcCalibrationOperationScope;
  /** Captured non-secret identity intent; null is an explicit pre-auth lifetime. */
  identity: CalibrationHarnessPersistenceIdentity | null;
  /** Required only for linked-web metadata cleanup. */
  database?: ProxxiedDexie;
  /** Narrow fixed-web test seam; no caller request authority is accepted. */
  createWebTransport?: () => MpcCalibrationTransport;
}>;

/** Deliberately bounded: it neither exposes transport detail nor claims remote side effects on cancellation. */
export type MpcCalibrationDisableResult =
  | Readonly<{ kind: "disabled"; target: "local"; previousTarget: MpcCalibrationTransportTarget }>
  | Readonly<{ kind: "cancelled"; target: MpcCalibrationTransportTarget }>
  | Readonly<{ kind: "rejected"; target?: MpcCalibrationTransportTarget; status: DisableStatus }>;

const LINK_KEYS = ["formatVersion", "ownerId", "harnessId", "connectionId", "updatedAt"] as const;
const SESSION_KEYS = ["ownerId", "harnessId"] as const;
const abortSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

function targetFrom(value: unknown): MpcCalibrationTransportTarget | undefined {
  return value === "local" || value === "linked-web" || value === "linked-electron" ? value : undefined;
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    // eslint-disable-next-line no-control-regex -- durable identities exclude control characters.
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function sameIdentity(
  left: Pick<CalibrationHarnessPersistenceIdentity, "ownerId" | "harnessId" | "connectionId">,
  right: Pick<CalibrationHarnessPersistenceIdentity, "ownerId" | "harnessId" | "connectionId">,
): boolean {
  return left.ownerId === right.ownerId && left.harnessId === right.harnessId && left.connectionId === right.connectionId;
}

function sameSession(
  left: Pick<CalibrationHarnessPersistenceIdentity, "ownerId" | "harnessId">,
  right: Pick<CalibrationHarnessPersistenceIdentity, "ownerId" | "harnessId">,
): boolean {
  return left.ownerId === right.ownerId && left.harnessId === right.harnessId;
}

function captureIdentity(value: unknown): CapturedIdentity | undefined {
  if (value === null) return undefined;
  try {
    const identity = validateCalibrationHarnessPersistenceIdentity(value);
    return Object.freeze({
      ownerId: identity.ownerId,
      harnessId: identity.harnessId,
      connectionId: identity.connectionId,
    });
  } catch {
    return undefined;
  }
}

function sameCapturedIdentity(left: CapturedIdentity | null, right: CapturedIdentity | null): boolean {
  return left === null ? right === null : right !== null && sameIdentity(left, right);
}

function captureSession(value: unknown): MpcCalibrationSession | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length !== 0) return undefined;
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== SESSION_KEYS.length || !SESSION_KEYS.every(key => names.includes(key))) return undefined;
    const owner = Object.getOwnPropertyDescriptor(value, "ownerId");
    const harness = Object.getOwnPropertyDescriptor(value, "harnessId");
    if (owner === undefined || harness === undefined || !("value" in owner) || !("value" in harness)
      || !owner.enumerable || !harness.enumerable || !boundedIdentity(owner.value) || !boundedIdentity(harness.value)) return undefined;
    return Object.freeze({ ownerId: owner.value, harnessId: harness.value });
  } catch {
    return undefined;
  }
}

function captureMatchingLinkRow(value: unknown, intent: CapturedIdentity): MpcCalibrationLinkStateRecord | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length !== 0) return undefined;
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== LINK_KEYS.length || !LINK_KEYS.every(key => names.includes(key))) return undefined;
    const fields = Object.fromEntries(LINK_KEYS.map(key => [key, Object.getOwnPropertyDescriptor(value, key)])) as Record<string, PropertyDescriptor | undefined>;
    if (LINK_KEYS.some(key => fields[key] === undefined || !("value" in fields[key]!) || !fields[key]!.enumerable)) return undefined;
    const row = {
      formatVersion: fields.formatVersion!.value,
      ownerId: fields.ownerId!.value,
      harnessId: fields.harnessId!.value,
      connectionId: fields.connectionId!.value,
      updatedAt: fields.updatedAt!.value,
    };
    if (row.formatVersion !== 1 || !boundedIdentity(row.ownerId) || !boundedIdentity(row.harnessId) || !boundedIdentity(row.connectionId)
      || !Number.isSafeInteger(row.updatedAt) || (row.updatedAt as number) < 0) return undefined;
    const captured: MpcCalibrationLinkStateRecord = {
      formatVersion: 1,
      ownerId: row.ownerId,
      harnessId: row.harnessId,
      connectionId: row.connectionId,
      updatedAt: row.updatedAt as number,
    };
    return sameIdentity(captured, intent) ? Object.freeze(captured) : undefined;
  } catch {
    return undefined;
  }
}

function sameLinkRow(left: MpcCalibrationLinkStateRecord, right: MpcCalibrationLinkStateRecord): boolean {
  return left.formatVersion === right.formatVersion && left.ownerId === right.ownerId && left.harnessId === right.harnessId
    && left.connectionId === right.connectionId && left.updatedAt === right.updatedAt;
}

function captureScope(value: unknown): CapturedScope | undefined {
  try {
    if (value === null || typeof value !== "object") return undefined;
    const scope = value as MpcCalibrationOperationScope;
    const captureAppOperation = scope.captureAppOperation;
    const replaceTarget = scope.replaceTarget;
    if (typeof captureAppOperation !== "function" || typeof replaceTarget !== "function") return undefined;
    return Object.freeze({
      captureAppOperation: captureAppOperation.bind(scope),
      replaceTarget: replaceTarget.bind(scope),
    });
  } catch {
    return undefined;
  }
}

function signalAborted(signal: AbortSignal): boolean | undefined {
  try {
    const aborted = abortSignalAborted?.call(signal);
    return typeof aborted === "boolean" ? aborted : undefined;
  } catch {
    return undefined;
  }
}

function captureOperation(value: unknown): CapturedOperation | undefined {
  let dispose: (() => void) | undefined;
  let captured: CapturedOperation | undefined;
  try {
    if (value === null || typeof value !== "object") return undefined;
    const operation = value as MpcCalibrationCapturedOperation;
    const rawDispose = operation.dispose;
    if (typeof rawDispose !== "function") return undefined;
    dispose = rawDispose.bind(operation);

    const target = targetFrom(operation.target);
    const rawIdentity = operation.identity;
    const identity = rawIdentity === null ? null : captureIdentity(rawIdentity);
    const signal = operation.signal;
    const rawCurrent = operation.isCurrent;
    const rawAssertCurrent = operation.assertCurrent;
    const rawGuard = operation.guard;
    if (target === undefined || identity === undefined || signalAborted(signal) === undefined
      || typeof rawCurrent !== "function" || typeof rawAssertCurrent !== "function" || typeof rawGuard !== "function") return undefined;

    captured = Object.freeze({
      target,
      identity,
      signal,
      isCurrent: rawCurrent.bind(operation),
      assertCurrent: rawAssertCurrent.bind(operation),
      guard: rawGuard.bind(operation) as CapturedOperation["guard"],
      dispose,
    });
    return captured;
  } catch {
    return undefined;
  } finally {
    // A malformed helper-owned token must not survive capability rejection.
    if (captured === undefined && dispose !== undefined) {
      try { dispose(); } catch { /* malformed-operation cleanup is bounded */ }
    }
  }
}

function current(operation: Pick<CapturedOperation, "signal" | "isCurrent">): boolean {
  try {
    if (signalAborted(operation.signal) !== false) return false;
    // The predicate is captured and invoked once. It can synchronously replace
    // the owner, so observe the same branded signal again without rerunning it.
    if (operation.isCurrent() !== true) return false;
    return signalAborted(operation.signal) === false;
  } catch {
    return false;
  }
}

function cancellation(target: MpcCalibrationTransportTarget): MpcCalibrationDisableResult {
  return { kind: "cancelled", target };
}

function statusFor(error: unknown): DisableStatus {
  try {
    if (!(error instanceof MpcCalibrationTransportError)) return "unavailable";
    switch (error.code) {
      case "offline":
      case "timeout":
        return "offline";
      case "authentication":
      case "unpaired":
        return "authentication";
      case "invalid-operation":
        return "invalid-operation";
      default:
        return "unavailable";
    }
  } catch {
    return "unavailable";
  }
}

function captureWeb(input: MpcCalibrationDisableInput, requiresDatabase: boolean): CapturedWeb | undefined {
  try {
    const candidateFactory = input.createWebTransport;
    if (candidateFactory !== undefined && typeof candidateFactory !== "function") return undefined;
    if (!requiresDatabase) {
      return Object.freeze({
        createWebTransport: candidateFactory === undefined ? undefined : candidateFactory.bind(input),
      });
    }
    const database = input.database;
    if (database === undefined || database === null) return undefined;
    return Object.freeze({
      database,
      createWebTransport: candidateFactory === undefined ? undefined : candidateFactory.bind(input),
    });
  } catch {
    return undefined;
  }
}

/**
 * Disables the controller-selected calibration link as one finite action. It
 * fences pending app/UI operations with same-target replacement, then uses a
 * fresh action token for linked-web session, unpair, and metadata work. Local
 * cancellation never claims to undo a request that reached a transport/server.
 */
export async function disableMpcCalibrationLink(input: MpcCalibrationDisableInput): Promise<MpcCalibrationDisableResult> {
  let target: MpcCalibrationTransportTarget | undefined;
  let latest: CapturedOperation | undefined;
  const ownedDisposals: Array<() => void> = [];
  try {
    target = targetFrom(input.target);
    const scope = captureScope(input.scope);
    if (target === undefined || scope === undefined) return { kind: "rejected", status: "invalid-operation" };

    const captureOwnedOperation = (): CapturedOperation | undefined => {
      const raw = scope.captureAppOperation();
      const operation = captureOperation(raw);
      if (operation !== undefined) ownedDisposals.push(operation.dispose);
      return operation;
    };

    const prior = captureOwnedOperation();
    latest = prior;
    if (prior === undefined) return { kind: "rejected", target, status: "invalid-operation" };
    if (prior.target !== target || !current(prior)) return cancellation(target);

    const rawIntent = input.identity;
    let intent: CapturedIdentity | null;
    if (rawIntent === null) {
      intent = null;
    } else {
      const capturedIntent = captureIdentity(rawIntent);
      if (capturedIntent === undefined) return { kind: "rejected", target, status: "invalid-operation" };
      intent = capturedIntent;
    }
    if (!sameCapturedIdentity(prior.identity, intent)) return { kind: "rejected", target, status: "invalid-operation" };

    if (target !== "linked-web") {
      if (!current(prior)) return cancellation(target);
      scope.replaceTarget("local");
      return { kind: "disabled", target: "local", previousTarget: target };
    }

    const web = captureWeb(input, intent !== null);
    if (web === undefined || (intent !== null && web.database === undefined)) return { kind: "rejected", target, status: "invalid-operation" };
    // Capability capture can be fallible or reentrant; do not invalidate the old
    // owner until its original operation still authorizes this exact intent.
    if (!current(prior)) return cancellation(target);

    scope.replaceTarget(target);
    const action = captureOwnedOperation();
    latest = action;
    if (action === undefined) return { kind: "rejected", target, status: "invalid-operation" };
    if (action.target !== target || !sameCapturedIdentity(action.identity, intent) || !current(action)) return cancellation(target);

    let getSession: MpcCalibrationTransport["getSession"];
    let unpair: MpcCalibrationTransport["unpair"];
    try {
      const selected = selectMpcCalibrationTransport({ target: "linked-web", createWebTransport: web.createWebTransport });
      getSession = selected.getSession.bind(selected);
      unpair = selected.unpair.bind(selected);
    } catch (error) {
      return current(action) ? { kind: "rejected", target, status: statusFor(error) } : cancellation(target);
    }
    if (!current(action)) return cancellation(target);

    const linkTable = web.database?.mpcCalibrationLinkStates;
    const getLink = linkTable?.get.bind(linkTable);
    const deleteLink = linkTable?.delete.bind(linkTable);
    const transaction = web.database?.transaction.bind(web.database);
    let before: MpcCalibrationLinkStateRecord | undefined;
    if (intent !== null) {
      if (linkTable === undefined || getLink === undefined || deleteLink === undefined || transaction === undefined) {
        return { kind: "rejected", target, status: "invalid-operation" };
      }
      try {
        before = captureMatchingLinkRow(await getLink([intent.ownerId, intent.harnessId]), intent);
      } catch {
        return current(action) ? { kind: "rejected", target, status: "unavailable" } : cancellation(target);
      }
      if (!current(action)) return cancellation(target);
    }

    let session: MpcCalibrationSession;
    try {
      const response = await getSession({ signal: action.signal });
      if (!current(action)) return cancellation(target);
      const captured = captureSession(response);
      if (captured === undefined) return { kind: "rejected", target, status: "unavailable" };
      if (intent !== null && !sameSession(captured, intent)) return { kind: "rejected", target, status: "authentication" };
      session = captured;
    } catch (error) {
      return current(action) ? { kind: "rejected", target, status: statusFor(error) } : cancellation(target);
    }

    try {
      await unpair({ signal: action.signal });
      if (!current(action)) return cancellation(target);
    } catch (error) {
      return current(action) ? { kind: "rejected", target, status: statusFor(error) } : cancellation(target);
    }

    if (intent !== null && before !== undefined) {
      try {
        await transaction!("rw", [linkTable!], async () => {
          action.assertCurrent();
          const now = captureMatchingLinkRow(await getLink!([intent!.ownerId, intent!.harnessId]), intent!);
          action.assertCurrent();
          if (now !== undefined && sameLinkRow(before!, now)) {
            await deleteLink!([intent!.ownerId, intent!.harnessId]);
            // This intentionally throws inside the transaction so an epoch change rolls back the actual delete.
            action.assertCurrent();
          }
        });
      } catch (error) {
        if (!current(action) || error instanceof MpcCalibrationOperationCancelledError) return cancellation(target);
        return { kind: "rejected", target, status: "unavailable" };
      }
      // Settlement itself is an asynchronous boundary: a later owner wins even
      // though the checked transaction has committed its exact deletion.
      if (!current(action)) return cancellation(target);
    }

    // `session` is deliberately retained only through authentication/unpair ordering; never persisted or returned.
    void session;
    if (!current(action)) return cancellation(target);
    // Only a current, genuinely successful disable selects local authority.
    scope.replaceTarget("local");
    return { kind: "disabled", target: "local", previousTarget: target };
  } catch {
    return latest !== undefined && target !== undefined && !current(latest)
      ? cancellation(target)
      : { kind: "rejected", ...(target === undefined ? {} : { target }), status: "invalid-operation" };
  } finally {
    for (const dispose of ownedDisposals) {
      try { dispose(); } catch { /* bounded action cleanup cannot escape the result */ }
    }
  }
}
