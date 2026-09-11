import type { ProxxiedDexie } from "@/db";
import {
  CALIBRATION_HARNESS_LOCAL_STATE_VERSION,
  captureCalibrationHarnessRevision,
  validateCalibrationHarnessPersistenceIdentity,
  validateCalibrationHarnessLocalState,
  type CalibrationHarnessAcknowledgementReceipt,
  type CalibrationHarnessLocalState,
  type CalibrationHarnessPersistenceIdentity,
} from "../../../shared/calibrationHarnessLocalState";
import {
  canonicalHarnessJson,
  type CalibrationHarnessRevision,
  type CalibrationHarnessSnapshot,
  validateCalibrationHarnessSnapshot,
} from "../../../shared/calibrationHarness";

export class MpcCalibrationSyncStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MpcCalibrationSyncStateError";
  }
}

export interface MpcCalibrationAcknowledgement extends CalibrationHarnessPersistenceIdentity {
  generation: number;
  snapshot: CalibrationHarnessSnapshot;
  expectedBaseRevision: number | null;
  base: CalibrationHarnessRevision;
}

export interface MpcCalibrationSyncStateStore {
  load(identity: CalibrationHarnessPersistenceIdentity): Promise<CalibrationHarnessLocalState | undefined>;
  storeBaseWhenClean(identity: CalibrationHarnessPersistenceIdentity, base: CalibrationHarnessRevision | null): Promise<CalibrationHarnessLocalState>;
  queueSnapshot(identity: CalibrationHarnessPersistenceIdentity, snapshot: CalibrationHarnessSnapshot): Promise<CalibrationHarnessLocalState>;
  markSnapshotSent(identity: CalibrationHarnessPersistenceIdentity, generation: number): Promise<CalibrationHarnessLocalState>;
  /**
   * A duplicate succeeds only when it exactly equals the one retained latest
   * acknowledgement receipt. Older or malformed receipts always fail closed.
   */
  acknowledge(acknowledgement: MpcCalibrationAcknowledgement): Promise<CalibrationHarnessLocalState>;
}

type StoreOptions = { now?: () => number };
type UnknownRecord = Record<string, unknown>;
type CapturedAcknowledgement = MpcCalibrationAcknowledgement;

const ACKNOWLEDGEMENT_KEYS = [
  "ownerId",
  "harnessId",
  "connectionId",
  "generation",
  "snapshot",
  "expectedBaseRevision",
  "base",
] as const;

function asSyncError(error: unknown): MpcCalibrationSyncStateError {
  if (error instanceof MpcCalibrationSyncStateError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new MpcCalibrationSyncStateError(message);
}

function key(identity: CalibrationHarnessPersistenceIdentity): [string, string, string] {
  return [identity.ownerId, identity.harnessId, identity.connectionId];
}

function requireAckRecord(value: unknown): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MpcCalibrationSyncStateError("acknowledgement must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MpcCalibrationSyncStateError("acknowledgement must be a plain object");
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new MpcCalibrationSyncStateError("acknowledgement must not contain symbol fields");
  }
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== ACKNOWLEDGEMENT_KEYS.length ||
    !ACKNOWLEDGEMENT_KEYS.every((expected) => names.includes(expected))
  ) {
    throw new MpcCalibrationSyncStateError("acknowledgement contains unknown or missing fields");
  }
  const captured: UnknownRecord = Object.create(null) as UnknownRecord;
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new MpcCalibrationSyncStateError(`acknowledgement.${name} must be an own enumerable data field`);
    }
    captured[name] = descriptor.value;
  }
  return captured;
}

function captureSnapshot(value: unknown, path: string): CalibrationHarnessSnapshot {
  try {
    validateCalibrationHarnessSnapshot(value);
  } catch (error) {
    throw asSyncError(new MpcCalibrationSyncStateError(
      `${path} is invalid: ${error instanceof Error ? error.message : String(error)}`
    ));
  }
  return structuredClone(value as CalibrationHarnessSnapshot);
}

function captureAcknowledgement(value: unknown): CapturedAcknowledgement {
  const acknowledgement = requireAckRecord(value);
  const checkedIdentity = validateCalibrationHarnessPersistenceIdentity({
    ownerId: acknowledgement.ownerId,
    harnessId: acknowledgement.harnessId,
    connectionId: acknowledgement.connectionId,
  });
  const identity = {
    ownerId: checkedIdentity.ownerId,
    harnessId: checkedIdentity.harnessId,
    connectionId: checkedIdentity.connectionId,
  };
  if (!Number.isSafeInteger(acknowledgement.generation) || (acknowledgement.generation as number) <= 0) {
    throw new MpcCalibrationSyncStateError("generation must be a positive safe integer");
  }
  if (
    acknowledgement.expectedBaseRevision !== null &&
    (!Number.isSafeInteger(acknowledgement.expectedBaseRevision) ||
      (acknowledgement.expectedBaseRevision as number) <= 0)
  ) {
    throw new MpcCalibrationSyncStateError("expectedBaseRevision must be null or a positive safe integer");
  }
  return {
    ...identity,
    generation: acknowledgement.generation as number,
    snapshot: captureSnapshot(acknowledgement.snapshot, "acknowledgement.snapshot"),
    expectedBaseRevision: acknowledgement.expectedBaseRevision as number | null,
    base: captureCalibrationHarnessRevision(acknowledgement.base, "acknowledgement.base"),
  };
}

function sameSnapshot(left: CalibrationHarnessSnapshot, right: CalibrationHarnessSnapshot): boolean {
  return canonicalHarnessJson(left) === canonicalHarnessJson(right);
}

function matchesReceipt(
  receipt: CalibrationHarnessAcknowledgementReceipt,
  acknowledgement: CapturedAcknowledgement
): boolean {
  return receipt.generation === acknowledgement.generation &&
    receipt.expectedBaseRevision === acknowledgement.expectedBaseRevision &&
    receipt.base.revision === acknowledgement.base.revision &&
    sameSnapshot(receipt.snapshot, acknowledgement.snapshot) &&
    sameSnapshot(receipt.base.snapshot, acknowledgement.base.snapshot);
}

function initialState(identity: CalibrationHarnessPersistenceIdentity, updatedAt: number): CalibrationHarnessLocalState {
  return {
    formatVersion: CALIBRATION_HARNESS_LOCAL_STATE_VERSION,
    ...identity,
    base: null,
    queued: null,
    inFlight: null,
    lastAcknowledgement: null,
    dirtyGeneration: 0,
    sentGeneration: 0,
    acknowledgedGeneration: 0,
    updatedAt,
  };
}

export function createMpcCalibrationSyncStateStore(
  database: ProxxiedDexie,
  options: StoreOptions = {}
): MpcCalibrationSyncStateStore {
  const now = options.now ?? Date.now;

  const validIdentity = (identity: CalibrationHarnessPersistenceIdentity) => {
    try {
      const checked = validateCalibrationHarnessPersistenceIdentity(identity);
      return {
        ownerId: checked.ownerId,
        harnessId: checked.harnessId,
        connectionId: checked.connectionId,
      };
    } catch (error) {
      throw asSyncError(error);
    }
  };
  const timestamp = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new MpcCalibrationSyncStateError("now must return a non-negative safe integer");
    }
    return value;
  };
  const validState = (state: CalibrationHarnessLocalState) => {
    try {
      return validateCalibrationHarnessLocalState(state);
    } catch (error) {
      throw asSyncError(error);
    }
  };

  return {
    async load(identity) {
      const valid = validIdentity(identity);
      let state: CalibrationHarnessLocalState | undefined;
      try {
        state = await database.mpcCalibrationSyncStates.get(key(valid));
      } catch (error) {
        throw asSyncError(error);
      }
      if (state === undefined) return undefined;
      const checked = validState(state);
      if (
        checked.ownerId !== valid.ownerId ||
        checked.harnessId !== valid.harnessId ||
        checked.connectionId !== valid.connectionId
      ) {
        throw new MpcCalibrationSyncStateError("stored state identity does not match its lookup key");
      }
      return checked;
    },

    async storeBaseWhenClean(identity, base) {
      const valid = validIdentity(identity);
      let capturedBase: CalibrationHarnessRevision | null;
      try {
        capturedBase = base === null ? null : captureCalibrationHarnessRevision(base);
      } catch (error) {
        throw asSyncError(error);
      }
      try {
        return await database.transaction("rw", database.mpcCalibrationSyncStates, async () => {
          const current = await database.mpcCalibrationSyncStates.get(key(valid));
          const state = current === undefined ? initialState(valid, timestamp()) : validState(current);
          if (state.queued !== null) {
            throw new MpcCalibrationSyncStateError("cannot replace the base while a snapshot is queued");
          }
          if (state.base !== null) {
            if (capturedBase === null) {
              throw new MpcCalibrationSyncStateError("cannot remove an installed base");
            }
            if (capturedBase.revision < state.base.revision) {
              throw new MpcCalibrationSyncStateError("base revision must not regress");
            }
            if (capturedBase.revision === state.base.revision) {
              if (!sameSnapshot(capturedBase.snapshot, state.base.snapshot)) {
                throw new MpcCalibrationSyncStateError("same-revision base snapshot must match the installed base");
              }
              return state;
            }
          }
          if (capturedBase === null) return state;
          const next = validState({ ...state, base: capturedBase, updatedAt: timestamp() });
          await database.mpcCalibrationSyncStates.put(next);
          return next;
        });
      } catch (error) {
        throw asSyncError(error);
      }
    },

    async queueSnapshot(identity, snapshot) {
      const valid = validIdentity(identity);
      let capturedSnapshot: CalibrationHarnessSnapshot;
      try {
        capturedSnapshot = captureSnapshot(snapshot, "snapshot");
      } catch (error) {
        throw asSyncError(error);
      }
      try {
        return await database.transaction("rw", database.mpcCalibrationSyncStates, async () => {
          const current = await database.mpcCalibrationSyncStates.get(key(valid));
          const state = current === undefined ? initialState(valid, timestamp()) : validState(current);
          if (state.dirtyGeneration === Number.MAX_SAFE_INTEGER) {
            throw new MpcCalibrationSyncStateError("dirty generation overflow");
          }
          const generation = state.dirtyGeneration + 1;
          const next = validState({
            ...state,
            queued: { generation, snapshot: capturedSnapshot },
            dirtyGeneration: generation,
            updatedAt: timestamp(),
          });
          await database.mpcCalibrationSyncStates.put(next);
          return next;
        });
      } catch (error) {
        throw asSyncError(error);
      }
    },

    async markSnapshotSent(identity, generation) {
      const valid = validIdentity(identity);
      if (!Number.isSafeInteger(generation) || generation <= 0) {
        throw new MpcCalibrationSyncStateError("generation must be a positive safe integer");
      }
      try {
        return await database.transaction("rw", database.mpcCalibrationSyncStates, async () => {
          const current = await database.mpcCalibrationSyncStates.get(key(valid));
          if (current === undefined) throw new MpcCalibrationSyncStateError("sync state does not exist");
          const state = validState(current);
          if (
            state.inFlight !== null ||
            state.queued === null ||
            state.queued.generation !== generation ||
            generation <= state.acknowledgedGeneration
          ) {
            throw new MpcCalibrationSyncStateError("generation is not the exact queued publication");
          }
          const next = validState({
            ...state,
            sentGeneration: generation,
            inFlight: {
              generation,
              snapshot: state.queued.snapshot,
              expectedBaseRevision: state.base?.revision ?? null,
            },
            updatedAt: timestamp(),
          });
          await database.mpcCalibrationSyncStates.put(next);
          return next;
        });
      } catch (error) {
        throw asSyncError(error);
      }
    },

    async acknowledge(acknowledgement) {
      let captured: CapturedAcknowledgement;
      try {
        captured = captureAcknowledgement(acknowledgement);
      } catch (error) {
        throw asSyncError(error);
      }
      const valid = validIdentity({
        ownerId: captured.ownerId,
        harnessId: captured.harnessId,
        connectionId: captured.connectionId,
      });
      try {
        return await database.transaction("rw", database.mpcCalibrationSyncStates, async () => {
          const current = await database.mpcCalibrationSyncStates.get(key(valid));
          if (current === undefined) throw new MpcCalibrationSyncStateError("sync state does not exist");
          const state = validState(current);
          if (captured.generation <= state.acknowledgedGeneration) {
            if (state.lastAcknowledgement !== null && state.lastAcknowledgement !== undefined &&
              matchesReceipt(state.lastAcknowledgement, captured)) {
              return state;
            }
            throw new MpcCalibrationSyncStateError("acknowledgement is not the exact latest settled receipt");
          }
          const inFlight = state.inFlight;
          if (inFlight === null || captured.generation !== inFlight.generation) {
            throw new MpcCalibrationSyncStateError("acknowledgement does not match the exact inFlight generation");
          }
          if (
            captured.expectedBaseRevision !== inFlight.expectedBaseRevision ||
            !sameSnapshot(captured.snapshot, inFlight.snapshot) ||
            !sameSnapshot(captured.base.snapshot, inFlight.snapshot)
          ) {
            throw new MpcCalibrationSyncStateError("acknowledgement does not match the exact sent snapshot");
          }
          if (captured.base.revision <= (state.base?.revision ?? 0)) {
            throw new MpcCalibrationSyncStateError("acknowledged base revision must strictly advance");
          }
          const receipt: CalibrationHarnessAcknowledgementReceipt = {
            generation: captured.generation,
            snapshot: captured.snapshot,
            expectedBaseRevision: captured.expectedBaseRevision,
            base: captured.base,
          };
          const next = validState({
            ...state,
            base: captured.base,
            acknowledgedGeneration: captured.generation,
            queued: state.queued?.generation === captured.generation ? null : state.queued,
            inFlight: null,
            lastAcknowledgement: receipt,
            updatedAt: timestamp(),
          });
          await database.mpcCalibrationSyncStates.put(next);
          return next;
        });
      } catch (error) {
        throw asSyncError(error);
      }
    },
  };
}
