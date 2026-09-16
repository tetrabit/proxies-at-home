import type { ProxxiedDexie } from "@/db";
import {
  validateCalibrationHarnessPersistenceIdentity,
  type CalibrationHarnessPersistenceIdentity,
} from "../../../shared/calibrationHarnessLocalState";
import {
  hydrateMpcCalibrationCache,
  type MpcCalibrationHydrationStatus,
} from "./mpcCalibrationCache";
import type { MpcCalibrationElectronBridge } from "./mpcCalibrationElectronTransport";
import type { MpcCalibrationCapturedOperation } from "./mpcCalibrationOperationScope";
import { createMpcCalibrationLinkStateStore } from "./mpcCalibrationLinkState";
import {
  restoreMpcCalibrationSession,
  type MpcCalibrationSessionRestorationStatus,
} from "./mpcCalibrationSessionRestoration";
import type { MpcCalibrationSession, MpcCalibrationTransport } from "./mpcCalibrationTransport";
import {
  selectMpcCalibrationTransport,
  type MpcCalibrationTransportTarget,
} from "./mpcCalibrationTransportSelection";
import { identityLogFields, mpcCalibrationLogError, mpcCalibrationLogInfo } from "./mpcCalibrationLog";

type LinkedTarget = Exclude<MpcCalibrationTransportTarget, "local">;
type CapturedTransport = Pick<MpcCalibrationTransport, "getSession" | "getSnapshot" | "getBlob">;

export type MpcCalibrationInitialAdmissionInput = Readonly<{
  database: ProxxiedDexie;
  /** The finite app/connection operation that owns this admission attempt. */
  operation: Pick<MpcCalibrationCapturedOperation, "target" | "identity" | "signal" | "isCurrent">;
  /** Undefined intentionally selects request-free local mode; null is invalid. */
  target?: MpcCalibrationTransportTarget;
  local?: MpcCalibrationTransport;
  createWebTransport?: () => MpcCalibrationTransport;
  electronBridge?: MpcCalibrationElectronBridge;
  now?: () => number;
  onAuthenticated?: (identity: Readonly<CalibrationHarnessPersistenceIdentity>) => void;
}>;

/**
 * App lifecycle variant. The callback receives only the validated durable
 * identity after exactly one restoration; it never receives an origin,
 * credential, session cookie, or transport error.
 */
export type MpcCalibrationInitialAdmissionWithIdentityInput =
  MpcCalibrationInitialAdmissionInput & Readonly<{
    onAuthenticated?: (identity: Readonly<CalibrationHarnessPersistenceIdentity>) => void;
  }>;

/**
 * Why admission refused the cache. The hydration layer already produces these
 * codes; admission adds the two identity-level codes it detects itself. They
 * surface verbatim in the UI so a blocked/conflict state is diagnosable
 * without database forensics.
 */
export type MpcCalibrationAdmissionBlockedReason =
  | "unspecified"
  | "foreign-physical-binding"
  | "identity-changed"
  | "invalid-identity"
  | "session-identity-mismatch"
  | "corrupt-sync-state"
  | "physical-cache-bound-to-different-identity"
  | "remote-revision-not-newer"
  | "session-identity-replaced";

export type MpcCalibrationAdmissionNeedsReconciliationReason =
  | "unspecified"
  | "unbased-local-sync-state-is-not-clean"
  | "unbased-or-dirty-local-harness"
  | "unbound-physical-cache";

export type MpcCalibrationAdmissionReason =
  | MpcCalibrationAdmissionBlockedReason
  | MpcCalibrationAdmissionNeedsReconciliationReason;

const KNOWN_BLOCKED_REASONS: ReadonlySet<string> = new Set<MpcCalibrationAdmissionBlockedReason>([
  "unspecified",
  "foreign-physical-binding",
  "identity-changed",
  "invalid-identity",
  "session-identity-mismatch",
  "corrupt-sync-state",
  "physical-cache-bound-to-different-identity",
  "remote-revision-not-newer",
  "session-identity-replaced",
]);

const KNOWN_NEEDS_RECONCILIATION_REASONS: ReadonlySet<string> = new Set<MpcCalibrationAdmissionNeedsReconciliationReason>([
  "unspecified",
  "unbased-local-sync-state-is-not-clean",
  "unbased-or-dirty-local-harness",
  "unbound-physical-cache",
]);

function blockedReasonFromHydration(reason: unknown): MpcCalibrationAdmissionBlockedReason {
  return typeof reason === "string" && KNOWN_BLOCKED_REASONS.has(reason)
    ? reason as MpcCalibrationAdmissionBlockedReason
    : "unspecified";
}

function needsReconciliationReasonFromHydration(reason: unknown): MpcCalibrationAdmissionNeedsReconciliationReason {
  return typeof reason === "string" && KNOWN_NEEDS_RECONCILIATION_REASONS.has(reason)
    ? reason as MpcCalibrationAdmissionNeedsReconciliationReason
    : "unspecified";
}

export type MpcCalibrationInitialAdmissionResult =
  | Readonly<{ kind: "local"; target: "local" }>
  | Readonly<{ kind: "hydrated"; target: LinkedTarget; revision?: number }>
  | Readonly<{ kind: "no-remote"; target: LinkedTarget }>
  | Readonly<{ kind: "blocked"; target: LinkedTarget; reason: MpcCalibrationAdmissionBlockedReason }>
  | Readonly<{ kind: "needs-reconciliation"; target: LinkedTarget; reason: MpcCalibrationAdmissionNeedsReconciliationReason }>
  | Readonly<{ kind: "cancelled"; target: LinkedTarget }>
  | Readonly<{ kind: "failed"; target?: LinkedTarget; code: "invalid-operation" | "unavailable" }>;

type CapturedInput = Readonly<{
  database?: ProxxiedDexie;
  target: MpcCalibrationTransportTarget;
  operationTarget: MpcCalibrationTransportTarget;
  priorIdentity?: CalibrationHarnessPersistenceIdentity | null;
  signal: AbortSignal;
  isCurrent: () => boolean;
  cancelled?: true;
  createWebTransport?: () => MpcCalibrationTransport;
  electronBridge?: MpcCalibrationElectronBridge;
  now?: () => number;
  onAuthenticated?: (identity: Readonly<CalibrationHarnessPersistenceIdentity>) => void;
}>;

function targetFrom(value: unknown): MpcCalibrationTransportTarget | undefined {
  return value === "local" || value === "linked-web" || value === "linked-electron" ? value : undefined;
}

function captureIdentity(value: CalibrationHarnessPersistenceIdentity | null): CalibrationHarnessPersistenceIdentity | null {
  if (value === null) return null;
  const identity = validateCalibrationHarnessPersistenceIdentity(value);
  return Object.freeze({
    ownerId: identity.ownerId,
    harnessId: identity.harnessId,
    connectionId: identity.connectionId,
  });
}

function sameIdentity(left: CalibrationHarnessPersistenceIdentity, right: CalibrationHarnessPersistenceIdentity): boolean {
  return left.ownerId === right.ownerId && left.harnessId === right.harnessId && left.connectionId === right.connectionId;
}

const unavailableElectronBridge: MpcCalibrationElectronBridge = Object.freeze({
  async calibrationHarnessExecute(): Promise<never> {
    throw new TypeError("Calibration Electron bridge is unavailable");
  },
});

function captureBridge(bridge: unknown): MpcCalibrationElectronBridge {
  const execute = (bridge as MpcCalibrationElectronBridge).calibrationHarnessExecute;
  if (typeof execute !== "function") throw new TypeError("Invalid calibration Electron bridge");
  return Object.freeze({ calibrationHarnessExecute: execute.bind(bridge) });
}

/** Capture the fixed preload bridge once so restoration and C3 cannot re-pick it. */
function captureDefaultElectronBridge(): MpcCalibrationElectronBridge {
  if (typeof window === "undefined") return unavailableElectronBridge;
  const candidate = window.electronAPI;
  return candidate !== undefined
    ? captureBridge(candidate)
    : unavailableElectronBridge;
}

function captureTransport(transport: MpcCalibrationTransport): CapturedTransport {
  return Object.freeze({
    getSession: transport.getSession.bind(transport),
    getSnapshot: transport.getSnapshot.bind(transport),
    getBlob: transport.getBlob.bind(transport),
  });
}

function captureInput(input: MpcCalibrationInitialAdmissionInput): CapturedInput | undefined {
  try {
    const rawTarget: unknown = input.target;
    const target = rawTarget === undefined ? "local" : targetFrom(rawTarget);
    const operation = input.operation;
    const operationTarget = targetFrom(operation.target);
    if (target === undefined || operationTarget === undefined || target !== operationTarget) return undefined;
    const signal = operation.signal;
    const isCurrent = operation.isCurrent;
    if (typeof isCurrent !== "function" || !(signal instanceof AbortSignal)) return undefined;
    const captured: CapturedInput = {
      target,
      operationTarget,
      signal,
      isCurrent: isCurrent.bind(operation),
    };
    if (target === "local") return captured;
    if (!current(captured)) return { ...captured, cancelled: true };

    const database = input.database;
    const priorIdentity = captureIdentity(operation.identity);
    const now = input.now;
    const onAuthenticated = input.onAuthenticated;
    if (onAuthenticated !== undefined && typeof onAuthenticated !== "function") return undefined;
    const capturedOnAuthenticated = onAuthenticated === undefined
      ? undefined
      : Function.prototype.bind.call(onAuthenticated, input) as (identity: Readonly<CalibrationHarnessPersistenceIdentity>) => void;
    if (target === "linked-web") {
      const createWebTransport = input.createWebTransport;
      if (createWebTransport !== undefined && typeof createWebTransport !== "function") return undefined;
      return { ...captured, database, priorIdentity, now, onAuthenticated: capturedOnAuthenticated, createWebTransport };
    }

    const rawBridge = input.electronBridge;
    const electronBridge = rawBridge === undefined ? captureDefaultElectronBridge() : captureBridge(rawBridge);
    return { ...captured, database, priorIdentity, now, onAuthenticated: capturedOnAuthenticated, electronBridge };
  } catch {
    return undefined;
  }
}

function current(captured: Pick<CapturedInput, "signal" | "isCurrent">): boolean {
  try {
    return !captured.signal.aborted && captured.isCurrent() === true;
  } catch {
    return false;
  }
}

function foreignPhysicalBinding(
  value: unknown,
  session: MpcCalibrationSession | undefined,
): boolean {
  if (session === undefined || value === null || typeof value !== "object") return false;
  try {
    const binding = value as Record<string, unknown>;
    return binding.id === "mpc-calibration-cache-binding"
      && typeof binding.ownerId === "string"
      && typeof binding.harnessId === "string"
      && typeof binding.connectionId === "string"
      && Number.isSafeInteger(binding.revision)
      && (binding.revision as number) > 0
      && Number.isSafeInteger(binding.updatedAt)
      && (binding.updatedAt as number) >= 0
      && (binding.ownerId !== session.ownerId || binding.harnessId !== session.harnessId);
  } catch {
    return false;
  }
}

function resultFromHydration(
  target: LinkedTarget,
  status: MpcCalibrationHydrationStatus,
  revision: unknown,
  reason: unknown,
): MpcCalibrationInitialAdmissionResult {
  switch (status) {
    case "hydrated":
      return Number.isSafeInteger(revision) && (revision as number) > 0
        ? { kind: "hydrated", target, revision: revision as number }
        : { kind: "hydrated", target };
    case "no-remote-snapshot":
      return { kind: "no-remote", target };
    case "blocked":
      return { kind: "blocked", target, reason: blockedReasonFromHydration(reason) };
    case "needs-reconciliation":
      return { kind: "needs-reconciliation", target, reason: needsReconciliationReasonFromHydration(reason) };
    case "cancelled":
      return { kind: "cancelled", target };
    case "failed":
      return { kind: "failed", target, code: "unavailable" };
  }
}

type MpcCalibrationInitialAdmissionRestorationStatus = Extract<
  MpcCalibrationSessionRestorationStatus,
  "offline" | "unpaired" | "authentication"
>;
type MpcCalibrationInitialAdmissionFailure = Extract<MpcCalibrationInitialAdmissionResult, Readonly<{ kind: "failed" }>>;
type CapturedAdmissionOutcome = Readonly<{
  result: MpcCalibrationInitialAdmissionResult;
  restoredIdentity?: Readonly<CalibrationHarnessPersistenceIdentity>;
  restorationStatus?: MpcCalibrationInitialAdmissionRestorationStatus;
}>;

function allowlistedRestorationStatus(
  status: MpcCalibrationSessionRestorationStatus,
): MpcCalibrationInitialAdmissionRestorationStatus | undefined {
  switch (status) {
    case "offline":
    case "unpaired":
    case "authentication":
      return status;
    default:
      return undefined;
  }
}

function completed(result: MpcCalibrationInitialAdmissionResult): CapturedAdmissionOutcome {
  return { result };
}

/** Performs one finite, owner-fenced admission from a previously captured public input. */
async function runCapturedMpcCalibrationInitialAdmission(captured: CapturedInput): Promise<CapturedAdmissionOutcome> {
  if (captured.target === "local") return completed({ kind: "local", target: "local" });
  const target = captured.target;
  if (captured.cancelled || !current(captured)) return completed({ kind: "cancelled", target });

  let transport: CapturedTransport;
  let resolveIdentity: ReturnType<typeof createMpcCalibrationLinkStateStore>["resolve"];
  try {
    const selected = selectMpcCalibrationTransport({
      target,
      createWebTransport: captured.createWebTransport,
      electronBridge: captured.electronBridge,
    });
    transport = captureTransport(selected);
    const acceptedLinkStore = createMpcCalibrationLinkStateStore(captured.database!);
    resolveIdentity = acceptedLinkStore.resolve.bind(acceptedLinkStore);
  } catch {
    return completed({ kind: "failed", target, code: "unavailable" });
  }

  const restorationFactory = target === "linked-web" ? () => transport as MpcCalibrationTransport : undefined;
  let authenticatedSession: MpcCalibrationSession | undefined;
  const capturedLinkStore = {
    async resolve(session: MpcCalibrationSession) {
      authenticatedSession = { ownerId: session.ownerId, harnessId: session.harnessId };
      return resolveIdentity(session);
    },
  };
  let restored;
  try {
    restored = await restoreMpcCalibrationSession({
      database: captured.database!,
      target,
      createWebTransport: restorationFactory,
      electronBridge: captured.electronBridge,
      linkStateStore: capturedLinkStore,
      signal: captured.signal,
      operation: { isCurrent: captured.isCurrent },
    });
  } catch (error) {
    mpcCalibrationLogError("session restoration threw", error, { target });
    return completed({ kind: "failed", target, code: "unavailable" });
  }

  if (!current(captured) || restored.kind === "cancelled") return completed({ kind: "cancelled", target });
  if (restored.kind === "rejected") {
    const restorationStatus = allowlistedRestorationStatus(restored.status);
    let binding: unknown;
    try {
      binding = await captured.database!.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding");
    } catch {
      // The restoration status remains the bounded failure when its state cannot be read.
    }
    if (!current(captured)) return completed({ kind: "cancelled", target });
    if (foreignPhysicalBinding(binding, authenticatedSession)) return completed({ kind: "blocked", target, reason: "foreign-physical-binding" });
    return { result: { kind: "failed", target, code: "unavailable" }, restorationStatus };
  }
  if (restored.kind !== "restored") return completed({ kind: "failed", target, code: "unavailable" });
  const restoredIdentity = Object.freeze({
    ownerId: restored.identity.ownerId,
    harnessId: restored.identity.harnessId,
    connectionId: restored.identity.connectionId,
  });
  if (captured.priorIdentity !== undefined && captured.priorIdentity !== null && !sameIdentity(captured.priorIdentity, restoredIdentity)) {
    return { result: { kind: "blocked", target, reason: "identity-changed" }, restoredIdentity };
  }
  if (captured.onAuthenticated !== undefined) {
    try {
      captured.onAuthenticated(restoredIdentity);
    } catch {
      return { result: { kind: "failed", target, code: "unavailable" }, restoredIdentity };
    }
    if (!current(captured)) return completed({ kind: "cancelled", target });
  }

  try {
    const hydrated = await hydrateMpcCalibrationCache({
      database: captured.database!,
      transport,
      identity: restored.identity,
      signal: captured.signal,
      operation: { isCurrent: captured.isCurrent },
      now: captured.now,
    });
    if (!current(captured) && hydrated.status !== "cancelled") return completed({ kind: "cancelled", target });
    return { result: resultFromHydration(target, hydrated.status, hydrated.revision, hydrated.reason), restoredIdentity };
  } catch (error) {
    mpcCalibrationLogError("hydration threw", error, { target, ...identityLogFields(restoredIdentity) });
    return { result: { kind: "failed", target, code: "unavailable" }, restoredIdentity };
  }
}

/**
 * Performs one finite, owner-fenced initial C3 admission. It restores a real
 * authenticated session and durable non-secret identity first, then lets C3
 * independently recheck that server identity before any cache admission.
 */
function admissionLogFields(result: MpcCalibrationInitialAdmissionResult): Readonly<Record<string, string | number | undefined>> {
  return {
    target: "target" in result ? result.target : undefined,
    kind: result.kind,
    code: "code" in result ? result.code : undefined,
    reason: "reason" in result ? result.reason : undefined,
    revision: "revision" in result ? result.revision : undefined,
  };
}

export async function runMpcCalibrationInitialAdmission(
  input: MpcCalibrationInitialAdmissionInput,
): Promise<MpcCalibrationInitialAdmissionResult> {
  const captured = captureInput(input);
  const result: MpcCalibrationInitialAdmissionResult = captured === undefined
    ? { kind: "failed", code: "invalid-operation" }
    : (await runCapturedMpcCalibrationInitialAdmission(captured)).result;
  mpcCalibrationLogInfo("admission outcome", admissionLogFields(result));
  return result;
}

export type MpcCalibrationInitialAdmissionWithIdentityResult =
  | Exclude<MpcCalibrationInitialAdmissionResult, MpcCalibrationInitialAdmissionFailure>
  | (MpcCalibrationInitialAdmissionFailure & Readonly<{
    restorationStatus?: MpcCalibrationInitialAdmissionRestorationStatus;
  }>)
  | Readonly<{
    kind: "hydrated" | "no-remote" | "blocked" | "needs-reconciliation";
    target: LinkedTarget;
    revision?: number;
    reason?: MpcCalibrationAdmissionReason;
    identity: Readonly<CalibrationHarnessPersistenceIdentity>;
  }>;

function isIdentityHandoffResult(
  result: MpcCalibrationInitialAdmissionResult,
): result is Extract<MpcCalibrationInitialAdmissionResult, Readonly<{
  kind: "hydrated" | "no-remote" | "blocked" | "needs-reconciliation";
}>> {
  return result.kind === "hydrated"
    || result.kind === "no-remote"
    || result.kind === "blocked"
    || result.kind === "needs-reconciliation";
}

/**
 * Reuses the one restoration performed by initial admission while exposing its
 * validated non-secret identity to the app lifecycle. It must not call session
 * restoration a second time merely to reconstruct ownership.
 */
export async function runMpcCalibrationInitialAdmissionWithIdentity(
  input: MpcCalibrationInitialAdmissionWithIdentityInput,
): Promise<MpcCalibrationInitialAdmissionWithIdentityResult> {
  const captured = captureInput(input);
  if (captured === undefined) {
    mpcCalibrationLogInfo("admission outcome", { kind: "failed", code: "invalid-operation" });
    return { kind: "failed", code: "invalid-operation" };
  }
  const outcome = await runCapturedMpcCalibrationInitialAdmission(captured);
  mpcCalibrationLogInfo("admission outcome", { ...admissionLogFields(outcome.result), ...identityLogFields(outcome.restoredIdentity) });
  if (outcome.result.kind === "failed") {
    return outcome.restorationStatus === undefined
      ? outcome.result
      : { ...outcome.result, restorationStatus: outcome.restorationStatus };
  }
  return outcome.restoredIdentity !== undefined && isIdentityHandoffResult(outcome.result)
    ? { ...outcome.result, identity: outcome.restoredIdentity }
    : outcome.result;
}
