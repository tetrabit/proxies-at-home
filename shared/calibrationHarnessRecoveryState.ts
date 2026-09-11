import {
  canonicalHarnessJson,
  type CalibrationHarnessRevision,
  type CalibrationHarnessSnapshot,
} from "./calibrationHarness";
import {
  validateCalibrationHarnessAcknowledgementReceipt,
  validateCalibrationHarnessLocalState,
  validateCalibrationHarnessPersistenceIdentity,
  validateCalibrationHarnessRevision,
  type CalibrationHarnessAcknowledgementReceipt,
  type CalibrationHarnessInFlightPublication,
  type CalibrationHarnessLocalState,
  type CalibrationHarnessPersistenceIdentity,
  type CalibrationHarnessQueuedEdit,
} from "./calibrationHarnessLocalState";
import { mergeCalibrationHarnessSnapshots } from "./calibrationHarnessMerge";

/** A separate format preserves C1's format-1 validator and ACK semantics. */
export const CALIBRATION_HARNESS_RECOVERY_STATE_VERSION = 2 as const;

export type CalibrationHarnessRecoveryKind =
  | "observed-current-base"
  | "observed-current-inflight"
  | "merged";

export interface CalibrationHarnessRecoveryProof {
  kind: CalibrationHarnessRecoveryKind;
  priorBase: CalibrationHarnessRevision;
  priorQueued: CalibrationHarnessQueuedEdit;
  retiredInFlight: CalibrationHarnessInFlightPublication | null;
  observed: CalibrationHarnessRevision;
  resultingQueued: CalibrationHarnessQueuedEdit | null;
  settledGeneration: number;
}

export interface CalibrationHarnessRecoveryState extends CalibrationHarnessPersistenceIdentity {
  formatVersion: typeof CALIBRATION_HARNESS_RECOVERY_STATE_VERSION;
  base: CalibrationHarnessRevision | null;
  queued: CalibrationHarnessQueuedEdit | null;
  inFlight: CalibrationHarnessInFlightPublication | null;
  lastAcknowledgement: CalibrationHarnessAcknowledgementReceipt | null;
  /** ACK-only remains acknowledgedGeneration; this includes observed settlement. */
  settledGeneration: number;
  lastRecovery: CalibrationHarnessRecoveryProof | null;
  dirtyGeneration: number;
  sentGeneration: number;
  acknowledgedGeneration: number;
  updatedAt: number;
}

export type CalibrationHarnessAnyLocalState = CalibrationHarnessLocalState | CalibrationHarnessRecoveryState;

export class CalibrationHarnessRecoveryStateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalibrationHarnessRecoveryStateValidationError";
  }
}

type RecordValue = Record<string, unknown>;
const STATE_KEYS = [
  "formatVersion", "ownerId", "harnessId", "connectionId", "base", "queued", "inFlight",
  "lastAcknowledgement", "settledGeneration", "lastRecovery", "dirtyGeneration", "sentGeneration",
  "acknowledgedGeneration", "updatedAt",
] as const;
const PROOF_KEYS = ["kind", "priorBase", "priorQueued", "retiredInFlight", "observed", "resultingQueued", "settledGeneration"] as const;
const QUEUED_KEYS = ["generation", "snapshot"] as const;
const IN_FLIGHT_KEYS = ["generation", "snapshot", "expectedBaseRevision"] as const;

function fail(message: string): never {
  throw new CalibrationHarnessRecoveryStateValidationError(message);
}

/** Capture only inert own enumerable data properties. Proxies are not sandboxed. */
function inert(value: unknown, path: string, keys: readonly string[]): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${path} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${path} must not contain symbol fields`);
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length || !keys.every(key => names.includes(key))) fail(`${path} contains unknown or missing fields`);
  const result = Object.create(null) as RecordValue;
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      fail(`${path}.${key} must be an own enumerable data field`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function safe(value: unknown, path: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (positive && value === 0)) {
    fail(`${path} must be a ${positive ? "positive" : "non-negative"} safe integer`);
  }
  return value as number;
}

function snapshot(value: unknown, path: string): CalibrationHarnessSnapshot {
  // Revision validation is the accepted snapshot boundary; use a synthetic revision.
  return validateCalibrationHarnessRevision({ revision: 1, snapshot: value }, path).snapshot;
}

function queued(value: unknown, path: string): CalibrationHarnessQueuedEdit {
  const row = inert(value, path, QUEUED_KEYS);
  safe(row.generation, `${path}.generation`, true);
  snapshot(row.snapshot, `${path}.snapshot`);
  return value as CalibrationHarnessQueuedEdit;
}

function inFlight(value: unknown, path: string): CalibrationHarnessInFlightPublication {
  const row = inert(value, path, IN_FLIGHT_KEYS);
  safe(row.generation, `${path}.generation`, true);
  snapshot(row.snapshot, `${path}.snapshot`);
  if (row.expectedBaseRevision !== null) safe(row.expectedBaseRevision, `${path}.expectedBaseRevision`, true);
  return value as CalibrationHarnessInFlightPublication;
}

function proof(value: unknown): CalibrationHarnessRecoveryProof {
  const row = inert(value, "lastRecovery", PROOF_KEYS);
  if (row.kind !== "observed-current-base" && row.kind !== "observed-current-inflight" && row.kind !== "merged") {
    fail("lastRecovery.kind is invalid");
  }
  validateCalibrationHarnessRevision(row.priorBase, "lastRecovery.priorBase");
  queued(row.priorQueued, "lastRecovery.priorQueued");
  if (row.retiredInFlight === null) fail("lastRecovery must retain the retired inFlight publication");
  const retired = inFlight(row.retiredInFlight, "lastRecovery.retiredInFlight");
  validateCalibrationHarnessRevision(row.observed, "lastRecovery.observed");
  if (row.resultingQueued !== null) queued(row.resultingQueued, "lastRecovery.resultingQueued");
  safe(row.settledGeneration, "lastRecovery.settledGeneration", true);
  if (retired.generation !== row.settledGeneration) {
    fail("lastRecovery retired inFlight must bind the settled generation");
  }
  const priorBase = validateCalibrationHarnessRevision(row.priorBase, "lastRecovery.priorBase");
  const priorQueued = queued(row.priorQueued, "lastRecovery.priorQueued");
  if (retired.expectedBaseRevision !== priorBase.revision) {
    fail("lastRecovery retired inFlight expected base must bind priorBase");
  }
  if (priorQueued.generation < retired.generation) {
    fail("lastRecovery priorQueued generation cannot precede the retired publication");
  }
  if (priorQueued.generation === retired.generation && !sameSnapshot(priorQueued.snapshot, retired.snapshot)) {
    fail("lastRecovery priorQueued snapshot must bind the retired publication");
  }
  return value as CalibrationHarnessRecoveryProof;
}

function sameSnapshot(left: CalibrationHarnessSnapshot, right: CalibrationHarnessSnapshot): boolean {
  return canonicalHarnessJson(left) === canonicalHarnessJson(right);
}

function validateProofSemantics(
  recovery: CalibrationHarnessRecoveryProof,
  base: CalibrationHarnessRevision | null,
  dirty: number,
  settled: number
): void {
  if (base === null) fail("lastRecovery requires an installed base");
  if (recovery.settledGeneration > settled || recovery.settledGeneration > dirty) {
    fail("lastRecovery does not bind a valid settlement");
  }
  if (
    recovery.priorQueued.generation > dirty ||
    (recovery.resultingQueued !== null && recovery.resultingQueued.generation > dirty)
  ) {
    fail("lastRecovery cannot claim a future generation beyond dirtyGeneration");
  }
  if (recovery.observed.revision > base.revision) {
    fail("lastRecovery observation cannot exceed the installed base revision");
  }
  if (recovery.observed.revision === base.revision && !sameSnapshot(recovery.observed.snapshot, base.snapshot)) {
    fail("equal lastRecovery observation and installed base revisions must match");
  }
  if (recovery.observed.revision < recovery.priorBase.revision) {
    fail("recovery observation revision regressed");
  }

  const retired = recovery.retiredInFlight!;
  if (recovery.kind === "observed-current-base") {
    if (recovery.observed.revision !== recovery.priorBase.revision || !sameSnapshot(recovery.observed.snapshot, recovery.priorBase.snapshot)) {
      fail("observed-current-base must exactly preserve the prior base revision and snapshot");
    }
    if (
      recovery.resultingQueued === null ||
      recovery.resultingQueued.generation !== recovery.priorQueued.generation + 1 ||
      !sameSnapshot(recovery.resultingQueued.snapshot, recovery.priorQueued.snapshot)
    ) {
      fail("observed-current-base must queue exactly the next generation with the prior queued snapshot");
    }
    return;
  }

  if (recovery.observed.revision <= recovery.priorBase.revision) {
    fail(`${recovery.kind} must observe an advancing remote revision`);
  }
  if (recovery.kind === "observed-current-inflight") {
    if (!sameSnapshot(recovery.observed.snapshot, retired.snapshot)) {
      fail("observed-current-inflight must exactly match the retired sent snapshot");
    }
    if (recovery.priorQueued.generation === retired.generation) {
      if (recovery.resultingQueued !== null) fail("observed-current-inflight must clear its settled queued generation");
    } else if (recovery.resultingQueued === null || recovery.resultingQueued.generation !== recovery.priorQueued.generation || !sameSnapshot(recovery.resultingQueued.snapshot, recovery.priorQueued.snapshot)) {
      fail("observed-current-inflight must preserve the actual newer queued generation");
    }
    return;
  }

  if (
    recovery.resultingQueued === null ||
    recovery.resultingQueued.generation !== recovery.priorQueued.generation + 1
  ) {
    fail("merged recovery must queue exactly the next generation");
  }
  const merged = mergeCalibrationHarnessSnapshots(recovery.priorBase.snapshot, recovery.priorQueued.snapshot, recovery.observed.snapshot);
  if (!merged.ok || !sameSnapshot(recovery.resultingQueued.snapshot, merged.snapshot)) {
    fail("merged recovery resulting queue must equal the accepted merge");
  }
}

/** Strictly validates V2 without converting, mutating, or normalizing a row. */
export function validateCalibrationHarnessRecoveryState(value: unknown): CalibrationHarnessRecoveryState {
  const state = inert(value, "state", STATE_KEYS);
  if (state.formatVersion !== CALIBRATION_HARNESS_RECOVERY_STATE_VERSION) fail("formatVersion must equal 2");
  try {
    validateCalibrationHarnessPersistenceIdentity({
      ownerId: state.ownerId,
      harnessId: state.harnessId,
      connectionId: state.connectionId,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : "state identity is invalid");
  }
  const dirty = safe(state.dirtyGeneration, "dirtyGeneration");
  const sent = safe(state.sentGeneration, "sentGeneration");
  const acknowledged = safe(state.acknowledgedGeneration, "acknowledgedGeneration");
  const settled = safe(state.settledGeneration, "settledGeneration");
  safe(state.updatedAt, "updatedAt");
  if (acknowledged > settled || settled > sent || sent > dirty) fail("generation ordering must be acknowledged <= settled <= sent <= dirty");
  const base = state.base === null ? null : validateCalibrationHarnessRevision(state.base, "base");
  const currentQueued = state.queued === null ? null : queued(state.queued, "queued");
  const currentInFlight = state.inFlight === null ? null : inFlight(state.inFlight, "inFlight");
  const acknowledgement = state.lastAcknowledgement === null ? null : validateCalibrationHarnessAcknowledgementReceipt(state.lastAcknowledgement);
  const recovery = state.lastRecovery === null ? null : proof(state.lastRecovery);
  if (currentQueued !== null && (currentQueued.generation !== dirty || dirty <= settled)) fail("queued must bind the latest unsettled dirty generation");
  if (currentQueued === null && dirty !== settled) fail("a clean state requires dirtyGeneration equal settledGeneration");
  if (currentInFlight === null && sent !== settled) fail("sentGeneration may exceed settledGeneration only with an inFlight publication");
  if (currentInFlight !== null) {
    if (currentInFlight.generation !== sent || sent <= settled) fail("inFlight must bind the exact unsettled sent generation");
    if ((base?.revision ?? null) !== currentInFlight.expectedBaseRevision) fail("inFlight expected base must match installed base");
    if (currentQueued === null || currentQueued.generation < currentInFlight.generation) fail("inFlight requires its queued snapshot or newer queued snapshot");
    if (currentQueued.generation === currentInFlight.generation && canonicalHarnessJson(currentQueued.snapshot) !== canonicalHarnessJson(currentInFlight.snapshot)) fail("inFlight snapshot must exactly match queued snapshot");
  }
  if (acknowledgement !== null) {
    if (acknowledgement.generation !== acknowledged || base === null || acknowledgement.base.revision > base.revision) fail("lastAcknowledgement is not coherent with ACK-only state");
    if (acknowledgement.base.revision === base.revision && canonicalHarnessJson(acknowledgement.base.snapshot) !== canonicalHarnessJson(base.snapshot)) fail("equal acknowledgement and base revisions must match");
  }
  if (settled > acknowledged && (recovery === null || recovery.settledGeneration !== settled)) fail("non-ACK settlement requires current lastRecovery proof");
  if (recovery !== null) {
    validateProofSemantics(recovery, base, dirty, settled);
    if (
      currentQueued !== null &&
      recovery.resultingQueued !== null &&
      currentQueued.generation === recovery.resultingQueued.generation &&
      !sameSnapshot(currentQueued.snapshot, recovery.resultingQueued.snapshot)
    ) {
      fail("current queued snapshot must match the retained resulting queue at the same generation");
    }
  }
  return value as CalibrationHarnessRecoveryState;
}

/** Explicit V1 -> V2 conversion. It validates V1 first and never writes storage. */
export function convertCalibrationHarnessLocalStateToRecoveryState(value: unknown): CalibrationHarnessRecoveryState {
  const legacy = validateCalibrationHarnessLocalState(value);
  const converted = structuredClone(legacy) as Omit<CalibrationHarnessRecoveryState, "formatVersion" | "settledGeneration" | "lastRecovery">;
  return {
    ...converted,
    formatVersion: CALIBRATION_HARNESS_RECOVERY_STATE_VERSION,
    lastAcknowledgement: converted.lastAcknowledgement ?? null,
    settledGeneration: legacy.acknowledgedGeneration,
    lastRecovery: null,
  };
}

export function isCalibrationHarnessRecoveryState(value: unknown): value is CalibrationHarnessRecoveryState {
  try { validateCalibrationHarnessRecoveryState(value); return true; } catch { return false; }
}
