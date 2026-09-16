import type { ProxxiedDexie } from "@/db";
import {
  CALIBRATION_HARNESS_LIMITS,
  canonicalHarnessJson,
  type CalibrationHarnessRevision,
  type CalibrationHarnessSnapshot,
} from "../../../shared/calibrationHarness";
import {
  captureCalibrationHarnessRevision,
  validateCalibrationHarnessPersistenceIdentity,
  type CalibrationHarnessPersistenceIdentity,
} from "../../../shared/calibrationHarnessLocalState";
import {
  createMpcCalibrationSyncStateStore,
  MpcCalibrationSyncStateError,
} from "./mpcCalibrationSyncState";
import {
  MpcCalibrationTransportError,
  type MpcCalibrationSession,
  type MpcCalibrationTransport,
} from "./mpcCalibrationTransport";
import { identityLogFields, mpcCalibrationLogError, mpcCalibrationLogInfo } from "./mpcCalibrationLog";

const CACHE_BINDING_ID = "mpc-calibration-cache-binding";
const MISSING_BLOB_CHUNK_SIZE = 512;

type OperationFence = Readonly<{ isCurrent?: () => boolean }>;

export type MpcCalibrationOutboxStatus =
  | "published"
  | "no-queued"
  | "blocked"
  | "cancelled"
  | "recovery-needed"
  | "conflict"
  | "failed";

export type MpcCalibrationOutboxInput = Readonly<{
  database: ProxxiedDexie;
  transport: Pick<MpcCalibrationTransport, "getSession" | "missingBlobs" | "putBlob" | "publishSnapshot">;
  identity: CalibrationHarnessPersistenceIdentity;
  signal?: AbortSignal;
  operation?: OperationFence;
}>;

export type MpcCalibrationOutboxResult = Readonly<{
  status: MpcCalibrationOutboxStatus;
  generation?: number;
  revision?: number;
  reason?: string;
  errorCode?: string;
}>;

type CapturedContext = Readonly<{
  database: ProxxiedDexie;
  identity: CalibrationHarnessPersistenceIdentity;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  getSession: (options?: { signal?: AbortSignal }) => Promise<MpcCalibrationSession>;
  missingBlobs: (hashes: string[], options?: { signal?: AbortSignal }) => Promise<{ missing: string[] }>;
  putBlob: (sha256: string, bytes: Uint8Array, options?: { signal?: AbortSignal }) => Promise<{ sha256: string; byteLength: number; inserted: boolean }>;
  publishSnapshot: (snapshot: CalibrationHarnessSnapshot, expectedRevision: number | null, options?: { signal?: AbortSignal }) => Promise<CalibrationHarnessRevision>;
}>;

type ContentSpec = Readonly<{
  sha256: string;
  byteLength: number;
  mimeType: string;
  assetId: string;
}>;

class OutboxBlockedError extends Error {}
class OutboxFenceError extends Error {}
class OutboxRecoveryError extends Error {}

function sameIdentity(
  left: CalibrationHarnessPersistenceIdentity,
  right: CalibrationHarnessPersistenceIdentity
): boolean {
  return left.ownerId === right.ownerId && left.harnessId === right.harnessId && left.connectionId === right.connectionId;
}

function operationIsCurrent(context: CapturedContext): boolean {
  return !context.signal?.aborted && context.isCurrent?.() !== false;
}

function assertOperationCurrent(context: CapturedContext): void {
  if (!operationIsCurrent(context)) throw new OutboxFenceError("operation is no longer current");
}

function captureIdentity(value: CalibrationHarnessPersistenceIdentity): CalibrationHarnessPersistenceIdentity {
  const checked = validateCalibrationHarnessPersistenceIdentity(value);
  return { ownerId: checked.ownerId, harnessId: checked.harnessId, connectionId: checked.connectionId };
}

function requireExactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OutboxBlockedError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new OutboxBlockedError(`${name} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new OutboxBlockedError(`${name} must not contain symbols`);
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length || !keys.every(key => names.includes(key))) {
    throw new OutboxBlockedError(`${name} contains unknown or missing fields`);
  }
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new OutboxBlockedError(`${name}.${key} must be an own enumerable data field`);
    }
    captured[key] = descriptor.value;
  }
  return captured;
}

function captureSession(value: unknown): MpcCalibrationSession {
  const record = requireExactRecord(value, ["ownerId", "harnessId"], "session");
  if (typeof record.ownerId !== "string" || typeof record.harnessId !== "string") {
    throw new OutboxBlockedError("session identity is invalid");
  }
  return { ownerId: record.ownerId, harnessId: record.harnessId };
}

function assertAuthenticatedSession(session: MpcCalibrationSession, identity: CalibrationHarnessPersistenceIdentity): void {
  if (session.ownerId !== identity.ownerId || session.harnessId !== identity.harnessId) {
    throw new OutboxFenceError("server session identity changed");
  }
}

function isDestructiveEmpty(snapshot: CalibrationHarnessSnapshot): boolean {
  return snapshot.datasets.length === 0 && snapshot.cases.length === 0 && snapshot.assets.length === 0 && snapshot.runs.length === 0;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function contentSpecs(snapshot: CalibrationHarnessSnapshot): ContentSpec[] {
  return snapshot.assets.map(asset => ({
    sha256: asset.sha256,
    byteLength: asset.byteLength,
    mimeType: asset.mimeType,
    assetId: asset.id,
  }));
}

function uniqueContentSpecs(specs: readonly ContentSpec[]): ContentSpec[] {
  const byHash = new Map<string, ContentSpec>();
  for (const spec of specs) {
    const existing = byHash.get(spec.sha256);
    if (existing !== undefined) {
      if (existing.byteLength !== spec.byteLength) {
        throw new OutboxBlockedError("assets sharing a content hash must have the same byte length");
      }
      continue;
    }
    byHash.set(spec.sha256, spec);
  }
  return [...byHash.values()];
}

function isBlobLike(value: unknown): value is Blob {
  if (value === null || typeof value !== "object") return false;
  const blob = value as { size?: unknown; type?: unknown; arrayBuffer?: unknown };
  return Number.isSafeInteger(blob.size) && (blob.size as number) >= 0 &&
    typeof blob.type === "string" && typeof blob.arrayBuffer === "function";
}

async function localBytesForAsset(context: CapturedContext, spec: ContentSpec): Promise<Uint8Array> {
  const record = await context.database.mpcCalibrationAssets.get(spec.assetId) as unknown;
  if (record === undefined || record === null || typeof record !== "object") {
    throw new OutboxBlockedError("referenced cached asset is missing");
  }
  const value = record as Record<string, unknown>;
  if (
    value.id !== spec.assetId || value.sha256 !== spec.sha256 || value.byteLength !== spec.byteLength ||
    value.mimeType !== spec.mimeType || !isBlobLike(value.blob)
  ) {
    throw new OutboxBlockedError("referenced cached asset metadata does not match the queued snapshot");
  }
  const blob = value.blob;
  if (blob.size > CALIBRATION_HARNESS_LIMITS.maxAssetBytes || blob.size !== spec.byteLength || blob.type !== spec.mimeType) {
    throw new OutboxBlockedError("referenced cached Blob does not satisfy bounded metadata");
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength !== spec.byteLength || await sha256(bytes) !== spec.sha256) {
    throw new OutboxBlockedError("referenced cached Blob content does not match the queued snapshot");
  }
  return bytes;
}

async function assertBoundCache(context: CapturedContext): Promise<void> {
  const binding = await context.database.mpcCalibrationCacheBindings.get(CACHE_BINDING_ID);
  if (binding === undefined || !sameIdentity(binding, context.identity)) {
    throw new OutboxBlockedError("physical cache is not bound to this owner, harness, and connection");
  }
}

/** Recheck caller authority and cache ownership immediately before a remote side effect. */
async function assertOutboundReady(context: CapturedContext): Promise<void> {
  assertOperationCurrent(context);
  await assertBoundCache(context);
  assertOperationCurrent(context);
}

function captureMissing(value: unknown, requested: ReadonlySet<string>): Set<string> {
  const record = requireExactRecord(value, ["missing"], "missing-blobs response");
  if (!Array.isArray(record.missing)) throw new OutboxBlockedError("missing-blobs response missing must be an array");
  const missing = new Set<string>();
  for (let index = 0; index < record.missing.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(record.missing, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value !== "string") {
      throw new OutboxBlockedError("missing-blobs response array must contain data strings");
    }
    if (!requested.has(descriptor.value) || missing.has(descriptor.value)) {
      throw new OutboxBlockedError("missing-blobs response contains an invalid or duplicate hash");
    }
    missing.add(descriptor.value);
  }
  return missing;
}

function validateBlobReceipt(value: unknown, spec: ContentSpec): void {
  const receipt = requireExactRecord(value, ["sha256", "byteLength", "inserted"], "put-blob response");
  if (receipt.sha256 !== spec.sha256 || receipt.byteLength !== spec.byteLength || typeof receipt.inserted !== "boolean") {
    throw new OutboxBlockedError("put-blob response does not match uploaded content");
  }
}

function captureRevision(value: unknown, sent: CalibrationHarnessSnapshot, expectedBaseRevision: number | null): CalibrationHarnessRevision {
  let revision: CalibrationHarnessRevision;
  try {
    revision = captureCalibrationHarnessRevision(value, "publish response");
  } catch (error) {
    throw new OutboxBlockedError(`publish response is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (revision.revision <= (expectedBaseRevision ?? 0)) {
    throw new OutboxBlockedError("publish response revision does not advance the recorded base");
  }
  if (canonicalHarnessJson(revision.snapshot) !== canonicalHarnessJson(sent)) {
    throw new OutboxBlockedError("publish response snapshot does not exactly match the sent generation");
  }
  return revision;
}

async function markExactGeneration(
  context: CapturedContext,
  generation: number,
  snapshot: CalibrationHarnessSnapshot,
  expectedBaseRevision: number | null
) {
  const stateStore = createMpcCalibrationSyncStateStore(context.database);
  return context.database.transaction(
    "rw",
    [context.database.mpcCalibrationSyncStates, context.database.mpcCalibrationCacheBindings],
    async () => {
      assertOperationCurrent(context);
      await assertBoundCache(context);
      const current = await stateStore.load(context.identity);
      if (current === undefined || current.inFlight !== null) throw new OutboxRecoveryError("an unresolved inFlight publication requires recovery");
      if (
        current.queued === null || current.queued.generation !== generation ||
        canonicalHarnessJson(current.queued.snapshot) !== canonicalHarnessJson(snapshot) ||
        (current.base?.revision ?? null) !== expectedBaseRevision
      ) {
        throw new OutboxRecoveryError("the recorded queued generation or base changed before send");
      }
      const marked = await stateStore.markSnapshotSent(context.identity, generation);
      assertOperationCurrent(context);
      if (
        marked.inFlight === null || marked.inFlight.generation !== generation ||
        marked.inFlight.expectedBaseRevision !== expectedBaseRevision ||
        canonicalHarnessJson(marked.inFlight.snapshot) !== canonicalHarnessJson(snapshot)
      ) {
        throw new OutboxRecoveryError("mark-sent did not retain the exact recorded generation");
      }
      return marked.inFlight;
    }
  );
}

async function acknowledgeExactGeneration(
  context: CapturedContext,
  generation: number,
  snapshot: CalibrationHarnessSnapshot,
  expectedBaseRevision: number | null,
  base: CalibrationHarnessRevision
): Promise<void> {
  const stateStore = createMpcCalibrationSyncStateStore(context.database);
  await context.database.transaction(
    "rw",
    [context.database.mpcCalibrationSyncStates, context.database.mpcCalibrationCacheBindings],
    async () => {
      assertOperationCurrent(context);
      await assertBoundCache(context);
      const current = await stateStore.load(context.identity);
      if (
        current === undefined || current.inFlight === null || current.inFlight.generation !== generation ||
        current.inFlight.expectedBaseRevision !== expectedBaseRevision ||
        canonicalHarnessJson(current.inFlight.snapshot) !== canonicalHarnessJson(snapshot)
      ) {
        throw new OutboxRecoveryError("the inFlight publication changed before acknowledgement");
      }
      await stateStore.acknowledge({ ...context.identity, generation, snapshot, expectedBaseRevision, base });
      assertOperationCurrent(context);
    }
  );
}

function resultForError(error: unknown, context: CapturedContext): MpcCalibrationOutboxResult {
  if (error instanceof OutboxRecoveryError || error instanceof MpcCalibrationSyncStateError) {
    return { status: "recovery-needed", reason: error.message };
  }
  if (error instanceof OutboxFenceError || !operationIsCurrent(context)) {
    return { status: "cancelled", reason: error instanceof Error ? error.message : "operation-not-current" };
  }
  if (error instanceof MpcCalibrationTransportError && error.status === 412) {
    return { status: "conflict", reason: "precondition-failed", errorCode: error.code };
  }
  if (error instanceof OutboxBlockedError) return { status: "blocked", reason: error.message };
  if (error instanceof MpcCalibrationTransportError) {
    return { status: "failed", reason: "transport-failure", errorCode: error.code };
  }
  return { status: "failed", reason: error instanceof Error ? error.message : "unknown-failure" };
}

/**
 * Flushes one already-queued C1 generation. This common transport helper never
 * selects a target, creates a base, rebases, retries an inFlight publication,
 * or mutates the canonical cache. Callers must supply the authenticated durable
 * identity and retain a recovery path for every non-published result.
 */
export async function flushMpcCalibrationOutbox(input: MpcCalibrationOutboxInput): Promise<MpcCalibrationOutboxResult> {
  const database = input.database;
  const transport = input.transport;
  const signal = input.signal;
  const operation = input.operation;
  const isCurrent = operation?.isCurrent?.bind(operation);
  let identity: CalibrationHarnessPersistenceIdentity;
  try {
    identity = captureIdentity(input.identity);
  } catch {
    return { status: "blocked", reason: "invalid-identity" };
  }
  const context: CapturedContext = {
    database,
    identity,
    signal,
    isCurrent,
    getSession: transport.getSession.bind(transport),
    missingBlobs: transport.missingBlobs.bind(transport),
    putBlob: transport.putBlob.bind(transport),
    publishSnapshot: transport.publishSnapshot.bind(transport),
  };
  if (!operationIsCurrent(context)) return { status: "cancelled", reason: "operation-not-current" };

  try {
    assertAuthenticatedSession(captureSession(await context.getSession({ signal: context.signal })), context.identity);
    assertOperationCurrent(context);
    const stateStore = createMpcCalibrationSyncStateStore(context.database);
    let state;
    try {
      state = await stateStore.load(context.identity);
    } catch {
      return { status: "blocked", reason: "corrupt-sync-state" };
    }
    if (state === undefined || state.queued === null) return { status: "no-queued" };
    if (state.base === null || state.base.revision <= 0) return { status: "blocked", reason: "missing-recorded-base" };
    if (state.inFlight !== null) return { status: "recovery-needed", reason: "unresolved-inflight" };

    const generation = state.queued.generation;
    const snapshot = structuredClone(state.queued.snapshot);
    const expectedBaseRevision = state.base.revision;
    if (isDestructiveEmpty(snapshot)) return { status: "blocked", reason: "empty-snapshot-requires-reconciliation" };
    await assertBoundCache(context);
    assertOperationCurrent(context);

    const assetSpecs = contentSpecs(snapshot);
    for (const spec of assetSpecs) {
      await localBytesForAsset(context, spec);
      assertOperationCurrent(context);
    }
    const specs = uniqueContentSpecs(assetSpecs);

    const missing = new Set<string>();
    for (let offset = 0; offset < specs.length; offset += MISSING_BLOB_CHUNK_SIZE) {
      const chunk = specs.slice(offset, offset + MISSING_BLOB_CHUNK_SIZE);
      const requested = new Set(chunk.map(spec => spec.sha256));
      await assertOutboundReady(context);
      const response = await context.missingBlobs(chunk.map(spec => spec.sha256), { signal: context.signal });
      for (const hash of captureMissing(response, requested)) missing.add(hash);
      await assertOutboundReady(context);
    }
    for (const spec of specs) {
      if (!missing.has(spec.sha256)) continue;
      const bytes = await localBytesForAsset(context, spec);
      await assertOutboundReady(context);
      validateBlobReceipt(await context.putBlob(spec.sha256, bytes, { signal: context.signal }), spec);
      await assertOutboundReady(context);
    }

    assertAuthenticatedSession(captureSession(await context.getSession({ signal: context.signal })), context.identity);
    assertOperationCurrent(context);
    const inFlight = await markExactGeneration(context, generation, snapshot, expectedBaseRevision);
    await assertOutboundReady(context);
    mpcCalibrationLogInfo("publish attempt", {
      generation,
      expectedRevision: inFlight.expectedBaseRevision,
      assets: specs.length,
      ...identityLogFields(context.identity),
    });
    const published = captureRevision(
      await context.publishSnapshot(structuredClone(inFlight.snapshot), inFlight.expectedBaseRevision, { signal: context.signal }),
      inFlight.snapshot,
      inFlight.expectedBaseRevision
    );
    assertOperationCurrent(context);
    assertAuthenticatedSession(captureSession(await context.getSession({ signal: context.signal })), context.identity);
    assertOperationCurrent(context);
    await acknowledgeExactGeneration(context, inFlight.generation, inFlight.snapshot, inFlight.expectedBaseRevision, published);
    mpcCalibrationLogInfo("acknowledge", {
      generation: inFlight.generation,
      revision: published.revision,
      ...identityLogFields(context.identity),
    });
    mpcCalibrationLogInfo("publish result", {
      status: "published",
      generation: inFlight.generation,
      revision: published.revision,
      expectedRevision: inFlight.expectedBaseRevision,
      ...identityLogFields(context.identity),
    });
    return { status: "published", generation: inFlight.generation, revision: published.revision };
  } catch (error) {
    const result = resultForError(error, context);
    if (result.status !== "no-queued") {
      mpcCalibrationLogError("publish failed", error, {
        status: result.status,
        reason: result.reason,
        errorCode: "errorCode" in result ? result.errorCode : undefined,
        ...identityLogFields(context.identity),
      });
    }
    return result;
  }
}

export const MPC_CALIBRATION_MISSING_BLOB_CHUNK_SIZE = MISSING_BLOB_CHUNK_SIZE;
