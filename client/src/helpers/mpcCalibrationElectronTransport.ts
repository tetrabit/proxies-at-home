import {
  CALIBRATION_HARNESS_LIMITS,
  canonicalHarnessJson,
  validateCalibrationHarnessSnapshot,
  type CalibrationHarnessRevision,
  type CalibrationHarnessSnapshot,
} from "../../../shared/calibrationHarness";
import { isCalibrationHarnessBlobSha256 } from "../../../shared/calibrationHarnessHttp";
import type {
  CalibrationHarnessIpcOperation,
  CalibrationHarnessIpcResult,
} from "../../../shared/calibrationHarnessIpc";
import {
  MpcCalibrationTransportError,
  type MpcCalibrationBlobReceipt,
  type MpcCalibrationMissingBlobs,
  type MpcCalibrationSession,
  type MpcCalibrationTransport,
  type MpcCalibrationTransportErrorCode,
} from "./mpcCalibrationTransport";

const MAX_MISSING_HASHES = 512;
const MAX_MISSING_BYTES = 64 * 1024;

type ExactRecord = Record<string, unknown>;

export type MpcCalibrationElectronBridge = Readonly<{
  calibrationHarnessExecute(operation: CalibrationHarnessIpcOperation): Promise<CalibrationHarnessIpcResult>;
}>;

export type MpcCalibrationElectronTransportOptions = Readonly<{
  /** Narrow test seam; production reads only the sandboxed preload bridge. */
  bridge?: MpcCalibrationElectronBridge;
}>;

function fail(code: MpcCalibrationTransportErrorCode, status?: number): never {
  throw new MpcCalibrationTransportError(code, status);
}

function requireActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail("aborted");
}

const SNAPSHOT_NOT_FOUND = Symbol("calibration-harness-snapshot-not-found");

function exactDataRecord(value: unknown, keys: readonly string[]): value is ExactRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  return names.length === expected.length && names.every((name, index) => name === expected[index]) && names.every(name => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}

function boundedIdentity(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

function parseSession(value: unknown): MpcCalibrationSession {
  if (!exactDataRecord(value, ["ownerId", "harnessId"]) || !boundedIdentity(value.ownerId) || !boundedIdentity(value.harnessId)) {
    return fail("invalid-response");
  }
  return Object.freeze({ ownerId: value.ownerId, harnessId: value.harnessId });
}

function parseRevision(value: unknown): CalibrationHarnessRevision {
  if (!exactDataRecord(value, ["revision", "snapshot"]) || typeof value.revision !== "number"
    || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    return fail("invalid-response");
  }
  const revision = value.revision;
  try {
    return Object.freeze({ revision, snapshot: validateCalibrationHarnessSnapshot(value.snapshot) });
  } catch {
    return fail("invalid-response");
  }
}

function parseReceipt(value: unknown, sha256: string, byteLength: number): MpcCalibrationBlobReceipt {
  if (!exactDataRecord(value, ["sha256", "byteLength", "inserted"])
    || value.sha256 !== sha256 || value.byteLength !== byteLength || typeof value.inserted !== "boolean") {
    return fail("invalid-response");
  }
  return Object.freeze({ sha256, byteLength, inserted: value.inserted });
}

function captureMissingHashes(value: unknown): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    return fail("invalid-operation");
  }
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MISSING_HASHES || Object.getOwnPropertyNames(value).length !== length + 1) {
    return fail("invalid-operation");
  }
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable
      || !isCalibrationHarnessBlobSha256(descriptor.value) || seen.has(descriptor.value)) return fail("invalid-operation");
    seen.add(descriptor.value);
    hashes.push(descriptor.value);
  }
  if (new TextEncoder().encode(JSON.stringify({ hashes })).byteLength > MAX_MISSING_BYTES) return fail("invalid-operation");
  return hashes;
}

function parseMissing(value: unknown, requested: readonly string[]): MpcCalibrationMissingBlobs {
  if (!exactDataRecord(value, ["missing"])) return fail("invalid-response");
  const missingDescriptor = Object.getOwnPropertyDescriptor(value, "missing");
  if (missingDescriptor === undefined || !("value" in missingDescriptor)) return fail("invalid-response");
  const valueMissing = missingDescriptor.value;
  if (!Array.isArray(valueMissing) || Object.getPrototypeOf(valueMissing) !== Array.prototype
    || Object.getOwnPropertySymbols(valueMissing).length !== 0) return fail("invalid-response");
  const lengthDescriptor = Object.getOwnPropertyDescriptor(valueMissing, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
    || lengthDescriptor.value > requested.length
    || Object.getOwnPropertyNames(valueMissing).length !== lengthDescriptor.value + 1) return fail("invalid-response");
  const missing: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(valueMissing, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return fail("invalid-response");
    const hash = descriptor.value;
    if (!isCalibrationHarnessBlobSha256(hash) || seen.has(hash) || !requested.includes(hash)) return fail("invalid-response");
    seen.add(hash);
    missing.push(hash);
  }
  return Object.freeze({ missing });
}

function captureBytes(value: Uint8Array | ArrayBuffer, maximum: number): Uint8Array {
  const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
  const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
  const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
  if (arrayBufferByteLength === undefined || typedArrayByteLength === undefined || typedArrayBuffer === undefined || typedArrayByteOffset === undefined) {
    return fail("invalid-operation");
  }
  try {
    if (value instanceof ArrayBuffer) {
      const byteLength = arrayBufferByteLength.call(value) as number;
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maximum) return fail("invalid-operation");
      const copy = new Uint8Array(byteLength);
      copy.set(new Uint8Array(value));
      return copy;
    }
    if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype
      || ["buffer", "byteOffset", "byteLength"].some(key => Object.getOwnPropertyDescriptor(value, key) !== undefined)) return fail("invalid-operation");
    const byteLength = typedArrayByteLength.call(value) as number;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maximum) return fail("invalid-operation");
    const buffer = typedArrayBuffer.call(value) as ArrayBuffer;
    const byteOffset = typedArrayByteOffset.call(value) as number;
    const copy = new Uint8Array(byteLength);
    copy.set(new Uint8Array(buffer, byteOffset, byteLength));
    return copy;
  } catch {
    return fail("invalid-operation");
  }
}

function captureReceivedBytes(value: unknown): Uint8Array {
  try {
    return captureBytes(value as Uint8Array, CALIBRATION_HARNESS_LIMITS.maxAssetBytes);
  } catch {
    return fail("invalid-response");
  }
}

async function digestSha256(bytes: Uint8Array): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return fail("invalid-operation");
  }
}

function bridgeFromWindow(): MpcCalibrationElectronBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const candidate = window.electronAPI;
  return candidate !== undefined && typeof candidate.calibrationHarnessExecute === "function"
    ? candidate as MpcCalibrationElectronBridge
    : undefined;
}

function parseResult(result: unknown, operation: CalibrationHarnessIpcOperation): unknown {
  if (exactDataRecord(result, ["ok", "value"]) && result.ok === true) return result.value;
  if (!exactDataRecord(result, ["ok", "error"]) || result.ok !== false || result.error === null || typeof result.error !== "object") {
    return fail("invalid-response");
  }
  const error = result.error as ExactRecord;
  const status = Object.getOwnPropertyDescriptor(error, "status")?.value;
  const expectedKeys = status === undefined ? ["code"] : ["code", "status"];
  if (!exactDataRecord(error, expectedKeys) || typeof error.code !== "string") return fail("invalid-response");
  if (error.code === "not-configured") {
    if (status !== undefined) return fail("invalid-response");
    return fail("unpaired");
  }
  if (error.code === "http") {
    if (!Number.isSafeInteger(status) || status < 100 || status > 599) return fail("invalid-response");
    if (status === 401 || status === 403) return fail("authentication", status);
    if (status === 404 && operation.kind === "getSnapshot") return SNAPSHOT_NOT_FOUND;
    return fail("http", status);
  }
  const supported: readonly MpcCalibrationTransportErrorCode[] = [
    "offline", "timeout", "aborted", "redirect", "response-too-large", "invalid-response", "invalid-operation",
  ];
  if (status !== undefined || !supported.includes(error.code as MpcCalibrationTransportErrorCode)) return fail("invalid-response");
  return fail(error.code as MpcCalibrationTransportErrorCode);
}

/**
 * Renderer-side adapter for the fixed preload bridge. Cancellation is local: the
 * accepted IPC protocol has no per-request cancellation operation; main handles
 * navigation/destruction cancellation independently.
 */
export function createMpcCalibrationElectronTransport(options: MpcCalibrationElectronTransportOptions = {}): MpcCalibrationTransport {
  const receiver = options.bridge ?? bridgeFromWindow();
  const execute = receiver?.calibrationHarnessExecute;
  const invoke = typeof execute === "function" ? execute.bind(receiver) : undefined;

  const request = async (operation: CalibrationHarnessIpcOperation, signal: AbortSignal | undefined): Promise<unknown> => {
    requireActive(signal);
    if (invoke === undefined) return fail("invalid-operation");
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(invoke(operation)).then(value => parseResult(value, operation), () => fail("invalid-response"));
    } catch {
      return fail("invalid-response");
    }
    if (signal === undefined) return pending;
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => { abort = () => reject(new MpcCalibrationTransportError("aborted")); });
    signal.addEventListener("abort", abort, { once: true });
    try {
      requireActive(signal);
      const result = await Promise.race([pending, aborted]);
      requireActive(signal);
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };

  const unsupported = async (): Promise<never> => fail("invalid-operation");
  return Object.freeze({
    pair: async (_credential, _options) => unsupported(),
    unpair: async (_options) => unsupported(),
    async getSession(requestOptions) {
      const signal = requestOptions?.signal;
      requireActive(signal);
      const result = await request({ kind: "getSession" }, signal);
      requireActive(signal);
      return parseSession(result);
    },
    async getSnapshot(requestOptions) {
      const signal = requestOptions?.signal;
      requireActive(signal);
      const result = await request({ kind: "getSnapshot" }, signal);
      requireActive(signal);
      return result === SNAPSHOT_NOT_FOUND ? null : parseRevision(result);
    },
    async publishSnapshot(snapshot, expectedRevision, requestOptions) {
      const signal = requestOptions?.signal;
      requireActive(signal);
      if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) return fail("invalid-operation");
      let sent: string;
      let capturedSnapshot: CalibrationHarnessSnapshot;
      try {
        validateCalibrationHarnessSnapshot(snapshot);
        sent = canonicalHarnessJson(snapshot);
        capturedSnapshot = JSON.parse(sent);
      } catch {
        return fail("invalid-operation");
      }
      if (new TextEncoder().encode(sent).byteLength > CALIBRATION_HARNESS_LIMITS.maxMetadataBytes) return fail("invalid-operation");
      requireActive(signal);
      const published = parseRevision(await request({ kind: "publishSnapshot", snapshot: capturedSnapshot, expectedRevision }, signal));
      requireActive(signal);
      if (canonicalHarnessJson(published.snapshot) !== sent || (expectedRevision !== null && published.revision <= expectedRevision)) {
        return fail("invalid-response");
      }
      return published;
    },
    async getBlob(sha256, requestOptions) {
      const signal = requestOptions?.signal;
      requireActive(signal);
      if (!isCalibrationHarnessBlobSha256(sha256)) return fail("invalid-operation");
      const result = await request({ kind: "getBlob", sha256 }, signal);
      requireActive(signal);
      const bytes = captureReceivedBytes(result);
      requireActive(signal);
      if (await digestSha256(bytes) !== sha256) return fail("invalid-response");
      requireActive(signal);
      return bytes;
    },
    async putBlob(sha256, value, requestOptions) {
      const signal = requestOptions?.signal;
      requireActive(signal);
      if (!isCalibrationHarnessBlobSha256(sha256)) return fail("invalid-operation");
      const bytes = captureBytes(value, CALIBRATION_HARNESS_LIMITS.maxAssetBytes);
      if (await digestSha256(bytes) !== sha256) return fail("invalid-operation");
      requireActive(signal);
      const result = await request({ kind: "putBlob", sha256, bytes }, signal);
      requireActive(signal);
      return parseReceipt(result, sha256, bytes.byteLength);
    },
    async missingBlobs(value, requestOptions) {
      const signal = requestOptions?.signal;
      requireActive(signal);
      const hashes = captureMissingHashes(value);
      requireActive(signal);
      const result = await request({ kind: "missingBlobs", hashes }, signal);
      requireActive(signal);
      return parseMissing(result, hashes);
    },
  } satisfies MpcCalibrationTransport);
}
