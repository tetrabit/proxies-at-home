import type { ProxxiedDexie } from "@/db";
import { canonicalHarnessJson, type CalibrationHarnessRevision, type CalibrationHarnessSnapshot } from "../../../shared/calibrationHarness";
import { captureCalibrationHarnessRevision, validateCalibrationHarnessPersistenceIdentity, type CalibrationHarnessPersistenceIdentity } from "../../../shared/calibrationHarnessLocalState";
import {
  convertCalibrationHarnessLocalStateToRecoveryState,
  validateCalibrationHarnessRecoveryState,
  type CalibrationHarnessRecoveryKind,
  type CalibrationHarnessRecoveryState,
} from "../../../shared/calibrationHarnessRecoveryState";
import { mergeCalibrationHarnessSnapshots } from "../../../shared/calibrationHarnessMerge";
import { applyMpcCalibrationRecoveryCache } from "./mpcCalibrationCache";
import { identityLogFields, mpcCalibrationLogInfo, mpcCalibrationLogWarn } from "./mpcCalibrationLog";
import { flushMpcCalibrationOutbox } from "./mpcCalibrationOutbox";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";
import type { MpcCalibrationTransport } from "./mpcCalibrationTransport";

export type MpcCalibrationRecoveryStatus = "published" | "no-queued" | "conflict" | "blocked" | "cancelled" | "pending" | "failed";
export type MpcCalibrationRecoveryResult = Readonly<{ status: MpcCalibrationRecoveryStatus; generation?: number; revision?: number; reason?: string }>;
export type MpcCalibrationRecoveryInput = Readonly<{
  database: ProxxiedDexie;
  transport: Pick<MpcCalibrationTransport, "getSession" | "getSnapshot" | "getBlob" | "missingBlobs" | "putBlob" | "publishSnapshot">;
  identity: CalibrationHarnessPersistenceIdentity;
  signal?: AbortSignal;
  operation?: Readonly<{ isCurrent?: () => boolean }>;
  /** Bounded per-call pull/publish cycles; 2 is sufficient for one recovery plus one publish. */
  maxCycles?: number;
  now?: () => number;
}>;

type CapturedInput = MpcCalibrationRecoveryInput;
class RecoveryBlockedError extends Error {}
class RecoveryFenceError extends Error {}

function same(left: CalibrationHarnessSnapshot, right: CalibrationHarnessSnapshot): boolean {
  return canonicalHarnessJson(left) === canonicalHarnessJson(right);
}
function current(input: CapturedInput): boolean {
  return !input.signal?.aborted && input.operation?.isCurrent?.call(input.operation) !== false;
}
function assertCurrent(input: CapturedInput): void {
  if (!current(input)) throw new RecoveryFenceError("operation-not-current");
}
function checkedIdentity(value: CalibrationHarnessPersistenceIdentity): CalibrationHarnessPersistenceIdentity {
  const valid = validateCalibrationHarnessPersistenceIdentity(value);
  return { ownerId: valid.ownerId, harnessId: valid.harnessId, connectionId: valid.connectionId };
}
function validRevision(value: unknown): CalibrationHarnessRevision {
  return captureCalibrationHarnessRevision(value, "recovery remote revision");
}
function validNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new RecoveryBlockedError("invalid-timestamp");
  return value;
}
async function assertSession(input: CapturedInput, identity: CalibrationHarnessPersistenceIdentity): Promise<void> {
  const session = await input.transport.getSession({ signal: input.signal });
  if (session.ownerId !== identity.ownerId || session.harnessId !== identity.harnessId) {
    throw new RecoveryFenceError("session-identity-mismatch");
  }
  assertCurrent(input);
}

function recoveryState(value: Awaited<ReturnType<ReturnType<typeof createMpcCalibrationSyncStateStore>["load"]>>): CalibrationHarnessRecoveryState {
  if (value === undefined) throw new RecoveryBlockedError("missing-sync-state");
  return value.formatVersion === 2
    ? validateCalibrationHarnessRecoveryState(value)
    : convertCalibrationHarnessLocalStateToRecoveryState(value);
}

function recoveryProof(
  kind: CalibrationHarnessRecoveryKind,
  state: CalibrationHarnessRecoveryState,
  observed: CalibrationHarnessRevision,
  resultingQueued: CalibrationHarnessRecoveryState["queued"],
) {
  if (state.base === null || state.queued === null || state.inFlight === null) {
    throw new RecoveryBlockedError("recovery-requires-base-queue-and-inflight");
  }
  return {
    kind,
    priorBase: structuredClone(state.base),
    priorQueued: structuredClone(state.queued),
    retiredInFlight: structuredClone(state.inFlight),
    observed: structuredClone(observed),
    resultingQueued: resultingQueued === null ? null : structuredClone(resultingQueued),
    settledGeneration: state.inFlight.generation,
  };
}

function settledRecoveryState(
  state: CalibrationHarnessRecoveryState,
  observed: CalibrationHarnessRevision,
  kind: CalibrationHarnessRecoveryKind,
  queued: CalibrationHarnessRecoveryState["queued"],
  dirtyGeneration: number,
  now: () => number,
): CalibrationHarnessRecoveryState {
  if (state.inFlight === null) throw new RecoveryBlockedError("missing-inflight");
  return validateCalibrationHarnessRecoveryState({
    ...structuredClone(state),
    base: structuredClone(observed),
    queued: queued === null ? null : structuredClone(queued),
    inFlight: null,
    dirtyGeneration,
    settledGeneration: state.inFlight.generation,
    lastRecovery: recoveryProof(kind, state, observed, queued),
    updatedAt: validNow(now),
  });
}

function rebasedUnsentState(
  state: CalibrationHarnessRecoveryState,
  observed: CalibrationHarnessRevision,
  snapshot: CalibrationHarnessSnapshot,
  now: () => number,
): CalibrationHarnessRecoveryState {
  if (state.queued === null || state.dirtyGeneration === Number.MAX_SAFE_INTEGER) {
    throw new RecoveryBlockedError("generation-overflow");
  }
  const queued = { generation: state.dirtyGeneration + 1, snapshot: structuredClone(snapshot) };
  // An unsent rebase has no retired publication: preserve ACK, settlement, and
  // lastRecovery evidence exactly while advancing only base/queue generation.
  return validateCalibrationHarnessRecoveryState({
    ...structuredClone(state),
    base: structuredClone(observed),
    queued,
    dirtyGeneration: queued.generation,
    updatedAt: validNow(now),
  });
}

function mapProducer(result: Awaited<ReturnType<typeof applyMpcCalibrationRecoveryCache>>): MpcCalibrationRecoveryResult | undefined {
  // The producer has already committed its transaction in this case. Returning
  // a resumable result prevents a second C4 publication while making the
  // committed revision visible to callers instead of misreporting a rollback.
  if (result.status === "applied") {
    if (result.reason === "committed-staging-cleanup-failed") {
      return { status: "pending", revision: result.revision, reason: result.reason };
    }
    return undefined;
  }
  if (result.status === "cancelled") return { status: "cancelled", reason: result.reason };
  if (result.status === "blocked") return { status: "blocked", reason: result.reason };
  return { status: "failed", reason: result.reason };
}

/**
 * Applies both the V2 durable state transition and the four physical cache
 * tables through the sole recovery-cache producer. It is deliberately the only
 * coordinator write seam; observations never fabricate a C4 acknowledgement.
 */
async function applyRecovery(
  input: CapturedInput,
  identity: CalibrationHarnessPersistenceIdentity,
  expectedState: Parameters<typeof applyMpcCalibrationRecoveryCache>[0]["expectedState"],
  nextState: CalibrationHarnessRecoveryState,
  snapshot: CalibrationHarnessSnapshot,
): Promise<MpcCalibrationRecoveryResult | undefined> {
  assertCurrent(input);
  const result = await applyMpcCalibrationRecoveryCache({
    database: input.database,
    transport: { getSession: input.transport.getSession, getBlob: input.transport.getBlob },
    identity,
    expectedState,
    nextState,
    snapshot,
    signal: input.signal,
    operation: input.operation,
    now: input.now,
  });
  const mapped = mapProducer(result);
  if (mapped !== undefined) return mapped;
  // A cancellation observed after an applied response cannot roll the producer
  // transaction back. Surface its committed revision and do not continue to C4.
  if (!current(input) && result.status === "applied") {
    return { status: "cancelled", revision: result.revision, reason: "committed-operation-cancelled" };
  }
  assertCurrent(input);
  return undefined;
}

/**
 * Pulls before each conditional C4 publication. GET is only an authoritative
 * observation: only C4's exact publish response can create an acknowledgement.
 */
export async function recoverAndFlushMpcCalibration(suppliedInput: MpcCalibrationRecoveryInput): Promise<MpcCalibrationRecoveryResult> {
  const result = await recoverAndFlushMpcCalibrationImpl(suppliedInput);
  if (result.status === "conflict") {
    mpcCalibrationLogWarn("recovery conflict", {
      status: result.status,
      reason: result.reason,
      generation: result.generation,
      revision: result.revision,
      ...identityLogFields(suppliedInput.identity),
    });
  } else {
    mpcCalibrationLogInfo("recovery outcome", {
      status: result.status,
      reason: result.reason,
      generation: result.generation,
      revision: result.revision,
      ...identityLogFields(suppliedInput.identity),
    });
  }
  return result;
}

async function recoverAndFlushMpcCalibrationImpl(suppliedInput: MpcCalibrationRecoveryInput): Promise<MpcCalibrationRecoveryResult> {
  let identity: CalibrationHarnessPersistenceIdentity;
  let input: CapturedInput;
  try {
    identity = checkedIdentity(suppliedInput.identity);
    const transport = suppliedInput.transport;
    const operation = suppliedInput.operation;
    input = {
      database: suppliedInput.database,
      identity,
      signal: suppliedInput.signal,
      operation: operation === undefined ? undefined : { isCurrent: operation.isCurrent?.bind(operation) },
      maxCycles: suppliedInput.maxCycles,
      now: suppliedInput.now,
      transport: {
        getSession: transport.getSession.bind(transport),
        getSnapshot: transport.getSnapshot.bind(transport),
        getBlob: transport.getBlob.bind(transport),
        missingBlobs: transport.missingBlobs.bind(transport),
        putBlob: transport.putBlob.bind(transport),
        publishSnapshot: transport.publishSnapshot.bind(transport),
      },
    };
  } catch {
    return { status: "blocked", reason: "invalid-input" };
  }
  const cycles = input.maxCycles ?? 2;
  if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 8) return { status: "blocked", reason: "invalid-cycle-budget" };

  try {
    assertCurrent(input);
    const store = createMpcCalibrationSyncStateStore(input.database, { now: input.now });
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      await assertSession(input, identity);
      const loaded = await store.load(identity);
      if (loaded === undefined || loaded.queued === null) return { status: "no-queued" };
      const state = recoveryState(loaded);
      if (state.base === null || state.queued === null) return { status: "blocked", reason: "missing-recorded-base-or-queue" };

      const currentRemote = await input.transport.getSnapshot({ signal: input.signal });
      assertCurrent(input);
      if (currentRemote === null) return { status: "blocked", reason: "remote-missing-after-base" };
      const observed = validRevision(currentRemote);
      if (observed.revision < state.base.revision || (observed.revision === state.base.revision && !same(observed.snapshot, state.base.snapshot))) {
        return { status: "conflict", reason: "remote-base-regressed-or-diverged" };
      }

      if (state.inFlight !== null) {
        if (observed.revision === state.base.revision && same(observed.snapshot, state.base.snapshot)) {
          if (state.dirtyGeneration === Number.MAX_SAFE_INTEGER) return { status: "blocked", reason: "generation-overflow" };
          const retry = { generation: state.dirtyGeneration + 1, snapshot: structuredClone(state.queued.snapshot) };
          const next = settledRecoveryState(state, observed, "observed-current-base", retry, retry.generation, input.now ?? Date.now);
          const result = await applyRecovery(input, identity, loaded, next, retry.snapshot);
          if (result !== undefined) return result;
          continue;
        }
        if (observed.revision > state.base.revision && same(observed.snapshot, state.inFlight.snapshot)) {
          const retained = state.queued.generation === state.inFlight.generation ? null : state.queued;
          const next = settledRecoveryState(state, observed, "observed-current-inflight", retained, state.dirtyGeneration, input.now ?? Date.now);
          const target = retained?.snapshot ?? observed.snapshot;
          const result = await applyRecovery(input, identity, loaded, next, target);
          if (result !== undefined) return result;
          continue;
        }
        const merged = mergeCalibrationHarnessSnapshots(state.base.snapshot, state.queued.snapshot, observed.snapshot);
        if (!merged.ok) return { status: "conflict", reason: merged.conflicts.map(item => `${item.collection}:${item.id}:${item.kind}`).join(",") };
        if (state.dirtyGeneration === Number.MAX_SAFE_INTEGER) return { status: "blocked", reason: "generation-overflow" };
        const queued = { generation: state.dirtyGeneration + 1, snapshot: merged.snapshot };
        const next = settledRecoveryState(state, observed, "merged", queued, queued.generation, input.now ?? Date.now);
        const result = await applyRecovery(input, identity, loaded, next, merged.snapshot);
        if (result !== undefined) return result;
        continue;
      }

      if (observed.revision > state.base.revision) {
        const merged = mergeCalibrationHarnessSnapshots(state.base.snapshot, state.queued.snapshot, observed.snapshot);
        if (!merged.ok) return { status: "conflict", reason: merged.conflicts.map(item => `${item.collection}:${item.id}:${item.kind}`).join(",") };
        const next = rebasedUnsentState(state, observed, merged.snapshot, input.now ?? Date.now);
        const result = await applyRecovery(input, identity, loaded, next, merged.snapshot);
        if (result !== undefined) return result;
        continue;
      }

      const flushed = await flushMpcCalibrationOutbox({
        database: input.database,
        transport: input.transport,
        identity,
        signal: input.signal,
        operation: input.operation,
      });
      if (flushed.status === "published") return { status: "published", generation: flushed.generation, revision: flushed.revision };
      if (flushed.status === "conflict" || flushed.status === "recovery-needed") continue;
      return {
        status: flushed.status === "cancelled" ? "cancelled" : flushed.status === "blocked" ? "blocked" : flushed.status === "no-queued" ? "no-queued" : "failed",
        reason: flushed.reason,
      };
    }
    return { status: "pending", reason: "recovery-cycle-budget-exhausted" };
  } catch (error) {
    if (error instanceof RecoveryFenceError || !current(input)) return { status: "cancelled", reason: error instanceof Error ? error.message : "operation-not-current" };
    if (error instanceof RecoveryBlockedError) return { status: "blocked", reason: error.message };
    return { status: "failed", reason: error instanceof Error ? error.message : "recovery-failed" };
  }
}
