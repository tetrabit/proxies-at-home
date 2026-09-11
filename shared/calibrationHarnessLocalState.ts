import {
  canonicalHarnessJson,
  type CalibrationHarnessRevision,
  type CalibrationHarnessSnapshot,
  validateCalibrationHarnessSnapshot,
} from "./calibrationHarness";

export const CALIBRATION_HARNESS_LOCAL_STATE_VERSION = 1 as const;

export interface CalibrationHarnessPersistenceIdentity {
  ownerId: string;
  harnessId: string;
  connectionId: string;
}

export interface CalibrationHarnessQueuedEdit {
  generation: number;
  snapshot: CalibrationHarnessSnapshot;
}

/** The one exact publication that may be awaiting an acknowledgement. */
export interface CalibrationHarnessInFlightPublication extends CalibrationHarnessQueuedEdit {
  expectedBaseRevision: number | null;
}

/**
 * One bounded, exact acknowledgement receipt. It permits only the most recent
 * settled acknowledgement to be replayed idempotently; older receipts fail
 * closed rather than accumulating an acknowledgement history.
 */
export interface CalibrationHarnessAcknowledgementReceipt extends CalibrationHarnessQueuedEdit {
  expectedBaseRevision: number | null;
  base: CalibrationHarnessRevision;
}

export interface CalibrationHarnessLocalState extends CalibrationHarnessPersistenceIdentity {
  formatVersion: typeof CALIBRATION_HARNESS_LOCAL_STATE_VERSION;
  base: CalibrationHarnessRevision | null;
  queued: CalibrationHarnessQueuedEdit | null;
  inFlight: CalibrationHarnessInFlightPublication | null;
  /** Optional only for compatibility with pre-release v1 rows. */
  lastAcknowledgement?: CalibrationHarnessAcknowledgementReceipt | null;
  dirtyGeneration: number;
  sentGeneration: number;
  acknowledgedGeneration: number;
  updatedAt: number;
}

export class CalibrationHarnessLocalStateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalibrationHarnessLocalStateValidationError";
  }
}

type UnknownRecord = Record<string, unknown>;

const STATE_REQUIRED_KEYS = [
  "formatVersion",
  "ownerId",
  "harnessId",
  "connectionId",
  "base",
  "queued",
  "inFlight",
  "dirtyGeneration",
  "sentGeneration",
  "acknowledgedGeneration",
  "updatedAt",
] as const;
const STATE_OPTIONAL_KEYS = ["lastAcknowledgement"] as const;
const IDENTITY_KEYS = ["ownerId", "harnessId", "connectionId"] as const;
const REVISION_KEYS = ["revision", "snapshot"] as const;
const QUEUED_KEYS = ["generation", "snapshot"] as const;
const IN_FLIGHT_KEYS = ["generation", "snapshot", "expectedBaseRevision"] as const;
const RECEIPT_KEYS = ["generation", "snapshot", "expectedBaseRevision", "base"] as const;

function invalid(message: string): never {
  throw new CalibrationHarnessLocalStateValidationError(message);
}

/**
 * Reads only own enumerable data descriptors. The returned record is a local
 * value capture, so subsequent validation never invokes a wrapper getter.
 * Proxies are not sandboxed; descriptor traps remain outside this boundary.
 */
function requireInertRecord(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${path} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    invalid(`${path} must not contain symbol fields`);
  }

  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length < requiredKeys.length ||
    names.length > allowed.size ||
    !requiredKeys.every((key) => names.includes(key)) ||
    !names.every((key) => allowed.has(key))
  ) {
    invalid(`${path} contains unknown or missing fields`);
  }

  const captured: UnknownRecord = Object.create(null) as UnknownRecord;
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      invalid(`${path}.${key} must be an own enumerable data field`);
    }
    captured[key] = descriptor.value;
  }
  return captured;
}

function requireBoundedIdentity(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    // eslint-disable-next-line no-control-regex -- validates durable identity code points.
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    invalid(`${path} must be a bounded non-control string`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function requirePositiveSafeInteger(value: unknown, path: string): number {
  const number = requireNonNegativeSafeInteger(value, path);
  if (number === 0) invalid(`${path} must be a positive safe integer`);
  return number;
}

function validateSnapshot(value: unknown, path: string): CalibrationHarnessSnapshot {
  try {
    validateCalibrationHarnessSnapshot(value);
  } catch (error) {
    invalid(`${path} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return value as CalibrationHarnessSnapshot;
}

export function validateCalibrationHarnessRevision(
  value: unknown,
  path = "base"
): CalibrationHarnessRevision {
  const revision = requireInertRecord(value, path, REVISION_KEYS);
  requirePositiveSafeInteger(revision.revision, `${path}.revision`);
  validateSnapshot(revision.snapshot, `${path}.snapshot`);
  return value as CalibrationHarnessRevision;
}

export function captureCalibrationHarnessRevision(
  value: unknown,
  path = "base"
): CalibrationHarnessRevision {
  const revision = requireInertRecord(value, path, REVISION_KEYS);
  const revisionNumber = requirePositiveSafeInteger(revision.revision, `${path}.revision`);
  const snapshot = validateSnapshot(revision.snapshot, `${path}.snapshot`);
  return { revision: revisionNumber, snapshot: structuredClone(snapshot) };
}

function validateQueuedEdit(value: unknown, path: string): CalibrationHarnessQueuedEdit {
  const queued = requireInertRecord(value, path, QUEUED_KEYS);
  requirePositiveSafeInteger(queued.generation, `${path}.generation`);
  validateSnapshot(queued.snapshot, `${path}.snapshot`);
  return value as CalibrationHarnessQueuedEdit;
}

function validateInFlight(value: unknown): CalibrationHarnessInFlightPublication {
  const inFlight = requireInertRecord(value, "inFlight", IN_FLIGHT_KEYS);
  requirePositiveSafeInteger(inFlight.generation, "inFlight.generation");
  validateSnapshot(inFlight.snapshot, "inFlight.snapshot");
  if (inFlight.expectedBaseRevision !== null) {
    requirePositiveSafeInteger(inFlight.expectedBaseRevision, "inFlight.expectedBaseRevision");
  }
  return value as CalibrationHarnessInFlightPublication;
}

export function validateCalibrationHarnessAcknowledgementReceipt(
  value: unknown,
  path = "lastAcknowledgement"
): CalibrationHarnessAcknowledgementReceipt {
  const receipt = requireInertRecord(value, path, RECEIPT_KEYS);
  requirePositiveSafeInteger(receipt.generation, `${path}.generation`);
  const snapshot = validateSnapshot(receipt.snapshot, `${path}.snapshot`);
  const expectedBaseRevision = receipt.expectedBaseRevision === null
    ? null
    : requirePositiveSafeInteger(receipt.expectedBaseRevision, `${path}.expectedBaseRevision`);
  const base = validateCalibrationHarnessRevision(receipt.base, `${path}.base`);
  if (canonicalHarnessJson(snapshot) !== canonicalHarnessJson(base.snapshot)) {
    invalid(`${path}.snapshot must exactly match ${path}.base.snapshot`);
  }
  if (base.revision <= (expectedBaseRevision ?? 0)) {
    invalid(`${path}.base.revision must advance ${path}.expectedBaseRevision`);
  }
  return value as CalibrationHarnessAcknowledgementReceipt;
}

export function validateCalibrationHarnessPersistenceIdentity(
  value: unknown
): CalibrationHarnessPersistenceIdentity {
  const identity = requireInertRecord(value, "identity", IDENTITY_KEYS);
  requireBoundedIdentity(identity.ownerId, "identity.ownerId");
  requireBoundedIdentity(identity.harnessId, "identity.harnessId");
  requireBoundedIdentity(identity.connectionId, "identity.connectionId");
  return value as CalibrationHarnessPersistenceIdentity;
}

/**
 * Strictly validates durable local sync state without cloning, normalizing, or
 * recovering malformed values. The returned reference is the supplied value.
 */
export function validateCalibrationHarnessLocalState(
  value: unknown
): CalibrationHarnessLocalState {
  const state = requireInertRecord(value, "state", STATE_REQUIRED_KEYS, STATE_OPTIONAL_KEYS);
  if (state.formatVersion !== CALIBRATION_HARNESS_LOCAL_STATE_VERSION) {
    invalid(`formatVersion must equal ${CALIBRATION_HARNESS_LOCAL_STATE_VERSION}`);
  }

  requireBoundedIdentity(state.ownerId, "ownerId");
  requireBoundedIdentity(state.harnessId, "harnessId");
  requireBoundedIdentity(state.connectionId, "connectionId");
  const dirtyGeneration = requireNonNegativeSafeInteger(state.dirtyGeneration, "dirtyGeneration");
  const sentGeneration = requireNonNegativeSafeInteger(state.sentGeneration, "sentGeneration");
  const acknowledgedGeneration = requireNonNegativeSafeInteger(state.acknowledgedGeneration, "acknowledgedGeneration");
  requireNonNegativeSafeInteger(state.updatedAt, "updatedAt");
  if (acknowledgedGeneration > sentGeneration || sentGeneration > dirtyGeneration) {
    invalid("generation ordering must be acknowledged <= sent <= dirty");
  }

  const base = state.base === null ? null : validateCalibrationHarnessRevision(state.base, "base");
  const queued = state.queued === null ? null : validateQueuedEdit(state.queued, "queued");
  const inFlight = state.inFlight === null ? null : validateInFlight(state.inFlight);
  const lastAcknowledgement = state.lastAcknowledgement === undefined || state.lastAcknowledgement === null
    ? null
    : validateCalibrationHarnessAcknowledgementReceipt(state.lastAcknowledgement);

  if (queued !== null) {
    if (queued.generation !== dirtyGeneration || dirtyGeneration <= acknowledgedGeneration) {
      invalid("queued.generation must be the current unsettled dirty generation");
    }
  }
  if (inFlight === null && sentGeneration !== acknowledgedGeneration) {
    invalid("sentGeneration may exceed acknowledgedGeneration only with an inFlight publication");
  }
  if (inFlight !== null) {
    if (inFlight.generation !== sentGeneration || sentGeneration <= acknowledgedGeneration) {
      invalid("inFlight generation must be the unacknowledged sent generation");
    }
    if ((base?.revision ?? null) !== inFlight.expectedBaseRevision) {
      invalid("inFlight expectedBaseRevision must match the installed base revision");
    }
    if (queued === null || queued.generation < inFlight.generation) {
      invalid("inFlight publication requires its queued snapshot or a newer queued snapshot");
    }
    if (
      queued.generation === inFlight.generation &&
      canonicalHarnessJson(queued.snapshot) !== canonicalHarnessJson(inFlight.snapshot)
    ) {
      invalid("inFlight snapshot must exactly match its queued snapshot");
    }
  }
  if (queued === null && (dirtyGeneration !== acknowledgedGeneration || inFlight !== null)) {
    invalid("a clean state cannot retain an inFlight publication");
  }
  if (lastAcknowledgement !== null) {
    if (lastAcknowledgement.generation !== acknowledgedGeneration) {
      invalid("lastAcknowledgement must bind the latest acknowledged generation");
    }
    if (base === null) {
      invalid("lastAcknowledgement requires an installed base");
    }
    if (lastAcknowledgement.base.revision > base.revision) {
      invalid("lastAcknowledgement base revision must not exceed the installed base revision");
    }
    if (
      lastAcknowledgement.base.revision === base.revision &&
      canonicalHarnessJson(lastAcknowledgement.base.snapshot) !== canonicalHarnessJson(base.snapshot)
    ) {
      invalid("equal lastAcknowledgement and installed base revisions must have matching snapshots");
    }
  }

  return value as CalibrationHarnessLocalState;
}
