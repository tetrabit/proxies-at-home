import type {
  MpcCalibrationCacheBindingRecord,
  MpcCalibrationLinkStateRecord,
  ProxxiedDexie,
} from "@/db";
import {
  type CalibrationHarnessLocalState,
  validateCalibrationHarnessLocalState,
} from "../../../shared/calibrationHarnessLocalState";
import {
  type CalibrationHarnessRecoveryState,
  validateCalibrationHarnessRecoveryState,
} from "../../../shared/calibrationHarnessRecoveryState";
import type { MpcCalibrationSession } from "./mpcCalibrationTransport";

const LINK_STATE_KEYS = [
  "formatVersion",
  "ownerId",
  "harnessId",
  "connectionId",
  "updatedAt",
] as const;
const SESSION_KEYS = ["ownerId", "harnessId"] as const;
const CACHE_BINDING_ID = "mpc-calibration-cache-binding";

export type MpcCalibrationLinkIdentity = Readonly<{
  ownerId: string;
  harnessId: string;
  connectionId: string;
}>;

export type MpcCalibrationLinkStateStore = Readonly<{
  /**
   * Resolves only controller-supplied server-session identity. A returned ID is
   * durable local metadata, never proof that a later controller action remains
   * authenticated; that action must authenticate through its real transport.
   */
  resolve(session: MpcCalibrationSession): Promise<MpcCalibrationLinkIdentity>;
}>;

export class MpcCalibrationLinkStateError extends Error {
  constructor(message = "invalid calibration link identity") {
    super(message);
    this.name = "MpcCalibrationLinkStateError";
  }
}

type Options = Readonly<{
  now?: () => number;
  /** Injection is for an owning controller/test; resolve never accepts an ID. */
  createConnectionId?: () => string;
}>;
type UnknownRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new MpcCalibrationLinkStateError(message);
}

/** Captures only inert own enumerable data fields. This does not sandbox Proxy traps. */
function captureExactRecord(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail(`${label} must not contain symbol fields`);
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length || !keys.every((key) => names.includes(key))) {
    fail(`${label} contains unknown or missing fields`);
  }
  const captured: UnknownRecord = Object.create(null) as UnknownRecord;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      fail(`${label} fields must be own enumerable data`);
    }
    captured[key] = descriptor.value;
  }
  return captured;
}

function boundedIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    // eslint-disable-next-line no-control-regex -- rejects control characters in durable IDs.
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    fail(`${label} must be a bounded non-control string`);
  }
  return value;
}

function capturedSession(value: unknown): Pick<MpcCalibrationSession, "ownerId" | "harnessId"> {
  const session = captureExactRecord(value, SESSION_KEYS, "session");
  return {
    ownerId: boundedIdentity(session.ownerId, "session.ownerId"),
    harnessId: boundedIdentity(session.harnessId, "session.harnessId"),
  };
}

function capturedLinkRecord(value: unknown): MpcCalibrationLinkStateRecord {
  const row = captureExactRecord(value, LINK_STATE_KEYS, "stored link identity");
  if (row.formatVersion !== 1) fail("stored link identity format is invalid");
  if (!Number.isSafeInteger(row.updatedAt) || (row.updatedAt as number) < 0) {
    fail("stored link identity timestamp is invalid");
  }
  return {
    formatVersion: 1,
    ownerId: boundedIdentity(row.ownerId, "stored link identity owner"),
    harnessId: boundedIdentity(row.harnessId, "stored link identity harness"),
    connectionId: boundedIdentity(row.connectionId, "stored link identity connection"),
    updatedAt: row.updatedAt as number,
  };
}

function capturedBinding(value: unknown): MpcCalibrationCacheBindingRecord {
  const row = captureExactRecord(
    value,
    ["id", "ownerId", "harnessId", "connectionId", "revision", "updatedAt"],
    "physical cache binding"
  );
  if (row.id !== CACHE_BINDING_ID || !Number.isSafeInteger(row.revision) || (row.revision as number) <= 0 ||
    !Number.isSafeInteger(row.updatedAt) || (row.updatedAt as number) < 0) {
    fail("physical cache binding is invalid");
  }
  return {
    id: CACHE_BINDING_ID,
    ownerId: boundedIdentity(row.ownerId, "physical cache binding owner"),
    harnessId: boundedIdentity(row.harnessId, "physical cache binding harness"),
    connectionId: boundedIdentity(row.connectionId, "physical cache binding connection"),
    revision: row.revision as number,
    updatedAt: row.updatedAt as number,
  };
}

function capturedProtocolIdentity(value: unknown): MpcCalibrationLinkIdentity {
  let state: CalibrationHarnessLocalState | CalibrationHarnessRecoveryState;
  try {
    state = validateCalibrationHarnessLocalState(value);
  } catch {
    try {
      state = validateCalibrationHarnessRecoveryState(value);
    } catch {
      fail("protocol state is invalid");
    }
  }
  return {
    ownerId: state.ownerId,
    harnessId: state.harnessId,
    connectionId: state.connectionId,
  };
}

function sameSession(
  left: Pick<MpcCalibrationLinkIdentity, "ownerId" | "harnessId">,
  right: Pick<MpcCalibrationLinkIdentity, "ownerId" | "harnessId">
): boolean {
  return left.ownerId === right.ownerId && left.harnessId === right.harnessId;
}

function timestamp(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) fail("clock is invalid");
  return value;
}

function resolved(identity: MpcCalibrationLinkIdentity): MpcCalibrationLinkIdentity {
  return {
    ownerId: identity.ownerId,
    harnessId: identity.harnessId,
    connectionId: identity.connectionId,
  };
}

export function createMpcCalibrationLinkStateStore(
  database: ProxxiedDexie,
  options: Options = {}
): MpcCalibrationLinkStateStore {
  const now = options.now ?? Date.now;
  const createConnectionId = options.createConnectionId ?? crypto.randomUUID.bind(crypto);

  return {
    async resolve(session) {
      const captured = capturedSession(session);
      try {
        return await database.transaction(
          "rw",
          [
            database.mpcCalibrationLinkStates,
            database.mpcCalibrationCacheBindings,
            database.mpcCalibrationSyncStates,
          ],
          async () => {
            const current = await database.mpcCalibrationLinkStates.get([
              captured.ownerId,
              captured.harnessId,
            ]);
            const stored = current === undefined ? undefined : capturedLinkRecord(current);
            if (stored !== undefined && !sameSession(stored, captured)) {
              fail("stored link identity does not match its key");
            }

            let selected = stored?.connectionId;
            const bindingValue = await database.mpcCalibrationCacheBindings.get(CACHE_BINDING_ID);
            if (bindingValue !== undefined) {
              const binding = capturedBinding(bindingValue);
              if (!sameSession(binding, captured)) {
                fail("physical cache binding belongs to another identity");
              }
              if (selected !== undefined && selected !== binding.connectionId) {
                fail("stored link identity conflicts with physical cache binding");
              }
              selected = binding.connectionId;
            }

            const protocolRows = await database.mpcCalibrationSyncStates
              .where("[ownerId+harnessId]")
              .equals([captured.ownerId, captured.harnessId])
              .toArray();
            const protocolConnectionIds = new Set<string>();
            for (const row of protocolRows) {
              const identity = capturedProtocolIdentity(row);
              if (!sameSession(identity, captured)) {
                fail("protocol state identity does not match its key");
              }
              protocolConnectionIds.add(identity.connectionId);
            }
            if (protocolConnectionIds.size > 1) {
              fail("protocol state makes link identity ambiguous");
            }
            const protocolConnectionId = protocolConnectionIds.values().next().value as string | undefined;
            if (selected !== undefined && protocolConnectionId !== undefined && selected !== protocolConnectionId) {
              fail("stored link identity conflicts with protocol state");
            }
            selected ??= protocolConnectionId;
            if (selected === undefined) {
              selected = boundedIdentity(createConnectionId(), "generated connection identity");
            }

            const result = { ...captured, connectionId: selected };
            if (stored === undefined) {
              await database.mpcCalibrationLinkStates.put({
                formatVersion: 1,
                ...result,
                updatedAt: timestamp(now),
              });
            }
            return resolved(result);
          }
        );
      } catch (error) {
        if (error instanceof MpcCalibrationLinkStateError) throw error;
        // Do not echo persistence/provider detail, which could contain authority.
        throw new MpcCalibrationLinkStateError("link identity persistence failed");
      }
    },
  };
}
