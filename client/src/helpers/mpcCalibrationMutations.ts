import Dexie from "dexie";
import type {
  MpcCalibrationAssetRecord,
  MpcCalibrationCacheBindingRecord,
  ProxxiedDexie,
} from "@/db";
import {
  canonicalHarnessJson,
  CALIBRATION_HARNESS_LIMITS,
  validateCalibrationHarnessSnapshot,
  type CalibrationHarnessAsset,
  type CalibrationHarnessSnapshot,
} from "../../../shared/calibrationHarness";
import {
  validateCalibrationHarnessPersistenceIdentity,
  type CalibrationHarnessPersistenceIdentity,
} from "../../../shared/calibrationHarnessLocalState";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";

export const MPC_CALIBRATION_CACHE_BINDING_ID = "mpc-calibration-cache-binding" as const;

export class MpcCalibrationMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MpcCalibrationMutationError";
  }
}

/**
 * Non-secret identity fence captured before caller-owned asynchronous work.
 * A prepared payload may never follow a replaced physical cache binding,
 * even when the authenticated identity is unchanged.
 */
export type MpcCalibrationMutationScope =
  | Readonly<{ kind: "local" }>
  | Readonly<{
      kind: "bound";
      identity: CalibrationHarnessPersistenceIdentity;
      bindingRevision: number;
    }>;

export type MpcCalibrationMutationWrite<T> = () => Promise<Readonly<{
  value: T;
  changed: boolean;
}>>;

export type MpcCalibrationMutationCoordinator = Readonly<{
  captureScope(): Promise<MpcCalibrationMutationScope>;
  mutate<T>(write: MpcCalibrationMutationWrite<T>, scope?: MpcCalibrationMutationScope): Promise<T>;
}>;

function sameIdentity(
  left: Pick<CalibrationHarnessPersistenceIdentity, "ownerId" | "harnessId" | "connectionId">,
  right: Pick<CalibrationHarnessPersistenceIdentity, "ownerId" | "harnessId" | "connectionId">
): boolean {
  return left.ownerId === right.ownerId && left.harnessId === right.harnessId && left.connectionId === right.connectionId;
}

function validBinding(binding: MpcCalibrationCacheBindingRecord): MpcCalibrationCacheBindingRecord {
  try {
    validateCalibrationHarnessPersistenceIdentity({
      ownerId: binding.ownerId,
      harnessId: binding.harnessId,
      connectionId: binding.connectionId,
    });
  } catch (error) {
    throw new MpcCalibrationMutationError(`cache binding is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Number.isSafeInteger(binding.revision) || binding.revision <= 0) {
    throw new MpcCalibrationMutationError("cache binding revision is invalid");
  }
  return binding;
}

function capturedScope(scope: MpcCalibrationMutationScope): MpcCalibrationMutationScope {
  if (scope.kind === "local") return { kind: "local" };
  try {
    const identity = validateCalibrationHarnessPersistenceIdentity(scope.identity);
    if (!Number.isSafeInteger(scope.bindingRevision) || scope.bindingRevision <= 0) {
      throw new MpcCalibrationMutationError("scope binding revision is invalid");
    }
    return {
      kind: "bound",
      identity: {
        ownerId: identity.ownerId,
        harnessId: identity.harnessId,
        connectionId: identity.connectionId,
      },
      bindingRevision: scope.bindingRevision,
    };
  } catch (error) {
    if (error instanceof MpcCalibrationMutationError) throw error;
    throw new MpcCalibrationMutationError(`mutation scope is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function sha256(blob: Blob): Promise<string> {
  if (blob.size > CALIBRATION_HARNESS_LIMITS.maxAssetBytes) {
    throw new MpcCalibrationMutationError("local blob exceeds the per-asset limit");
  }
  const buffer = await Dexie.waitFor(blob.arrayBuffer());
  const digest = await Dexie.waitFor(crypto.subtle.digest("SHA-256", buffer));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function finalSnapshot(
  database: ProxxiedDexie,
  root: CalibrationHarnessSnapshot
): Promise<CalibrationHarnessSnapshot> {
  const [datasets, cases, assets, runs] = await Promise.all([
    database.mpcCalibrationDatasets.toArray(),
    database.mpcCalibrationCases.toArray(),
    database.mpcCalibrationAssets.toArray(),
    database.mpcCalibrationRuns.toArray(),
  ]);
  const serializedAssets: CalibrationHarnessAsset[] = [];
  for (const asset of assets) {
    const serialized = await serializeAsset(asset);
    await database.mpcCalibrationAssets.update(asset.id, {
      mimeType: serialized.mimeType,
      sha256: serialized.sha256,
      byteLength: serialized.byteLength,
    } as never);
    serializedAssets.push(serialized);
  }
  const snapshot = {
    ...structuredClone(root),
    version: 1 as const,
    datasets: structuredClone(datasets),
    cases: structuredClone(cases),
    assets: serializedAssets,
    runs: structuredClone(runs),
  } as CalibrationHarnessSnapshot;
  validateCalibrationHarnessSnapshot(snapshot);
  return snapshot;
}

async function serializeAsset(asset: MpcCalibrationAssetRecord): Promise<CalibrationHarnessAsset> {
  const { blob, sha256: _ignoredSha256, byteLength: _ignoredByteLength, ...metadata } = asset as MpcCalibrationAssetRecord & {
    sha256?: unknown;
    byteLength?: unknown;
  };
  return {
    ...structuredClone(metadata),
    mimeType: blob.type,
    sha256: await sha256(blob),
    byteLength: blob.size,
  } as CalibrationHarnessAsset;
}

function bindingScope(binding: MpcCalibrationCacheBindingRecord): Extract<MpcCalibrationMutationScope, { kind: "bound" }> {
  return {
    kind: "bound",
    identity: {
      ownerId: binding.ownerId,
      harnessId: binding.harnessId,
      connectionId: binding.connectionId,
    },
    bindingRevision: binding.revision,
  };
}

/**
 * Coordinates one local mutation across the four global harness tables and
 * the C1 state. Unbound rows remain local-only; a present binding requires a
 * valid identity/state and atomically advances the durable queue.
 */
export function createMpcCalibrationMutationCoordinator(
  database: ProxxiedDexie,
  options: Readonly<{ now?: () => number }> = {}
): MpcCalibrationMutationCoordinator {
  const stateStore = createMpcCalibrationSyncStateStore(database, { now: options.now });

  return {
    async captureScope() {
      return database.transaction("r", database.mpcCalibrationCacheBindings, async () => {
        const binding = await database.mpcCalibrationCacheBindings.get(MPC_CALIBRATION_CACHE_BINDING_ID);
        return binding === undefined ? { kind: "local" } : bindingScope(validBinding(binding));
      });
    },

    async mutate<T>(write: MpcCalibrationMutationWrite<T>, scope?: MpcCalibrationMutationScope): Promise<T> {
      const expectedScope = scope === undefined ? undefined : capturedScope(scope);
      return database.transaction(
        "rw",
        [
          database.mpcCalibrationDatasets,
          database.mpcCalibrationCases,
          database.mpcCalibrationAssets,
          database.mpcCalibrationRuns,
          database.mpcCalibrationSyncStates,
          database.mpcCalibrationCacheBindings,
        ],
        async () => {
          const binding = await database.mpcCalibrationCacheBindings.get(MPC_CALIBRATION_CACHE_BINDING_ID);
          if (binding === undefined) {
            if (expectedScope?.kind === "bound") {
              throw new MpcCalibrationMutationError("captured cache binding no longer exists");
            }
            return (await write()).value;
          }

          const valid = validBinding(binding);
          const activeScope = bindingScope(valid);
          if (expectedScope?.kind === "local") {
            throw new MpcCalibrationMutationError("captured local-only cache was bound before commit");
          }
          if (expectedScope !== undefined &&
            (!sameIdentity(expectedScope.identity, activeScope.identity) || activeScope.bindingRevision !== expectedScope.bindingRevision)) {
            throw new MpcCalibrationMutationError("captured cache binding was replaced");
          }

          const state = await stateStore.load(activeScope.identity);
          if (state === undefined) throw new MpcCalibrationMutationError("bound cache is missing its sync state");
          const result = await write();
          if (!result.changed) return result.value;

          const root = state.queued?.snapshot ?? state.base?.snapshot;
          if (root === undefined) throw new MpcCalibrationMutationError("bound cache state has no snapshot root");
          const snapshot = await finalSnapshot(database, root);
          if (canonicalHarnessJson(snapshot) === canonicalHarnessJson(root)) return result.value;
          await stateStore.queueSnapshot(activeScope.identity, snapshot);
          return result.value;
        }
      );
    },
  };
}
