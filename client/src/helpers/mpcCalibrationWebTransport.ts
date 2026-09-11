import {
  CALIBRATION_HARNESS_LIMITS,
  canonicalHarnessJson,
  validateCalibrationHarnessSnapshot,
  type CalibrationHarnessRevision,
  type CalibrationHarnessSnapshot,
} from "../../../shared/calibrationHarness";
import {
  CALIBRATION_HARNESS_HTTP,
  calibrationHarnessBlobPath,
  calibrationHarnessRevisionEtag,
  isCalibrationHarnessBlobSha256,
} from "../../../shared/calibrationHarnessHttp";
import {
  MpcCalibrationTransportError,
  type MpcCalibrationBlobReceipt,
  type MpcCalibrationMissingBlobs,
  type MpcCalibrationRequestOptions,
  type MpcCalibrationSession,
  type MpcCalibrationTransport,
  type MpcCalibrationTransportErrorCode,
} from "./mpcCalibrationTransport";

const MAX_MISSING_HASHES = 512;
const MAX_MISSING_BYTES = 64 * 1024;
const PAIR_CREDENTIAL = /^calibration_pair_[A-Za-z0-9_-]{43}$/;

type FetchImplementation = typeof fetch;
type ExactRecord = Record<string, unknown>;

export type MpcCalibrationWebTransportOptions = Readonly<{
  fetch?: FetchImplementation;
  timeoutMs?: number;
}>;

function fail(code: MpcCalibrationTransportErrorCode, status?: number): never {
  throw new MpcCalibrationTransportError(code, status);
}

function exactDataRecord(value: unknown, keys: readonly string[]): value is ExactRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length !== 0) return false;
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

function parseRevision(value: unknown, response: Response): CalibrationHarnessRevision {
  if (!exactDataRecord(value, ["revision", "snapshot"]) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    return fail("invalid-response");
  }
  let snapshot: CalibrationHarnessSnapshot;
  try {
    snapshot = validateCalibrationHarnessSnapshot(value.snapshot);
  } catch {
    return fail("invalid-response");
  }
  if (response.headers.get("etag") !== calibrationHarnessRevisionEtag(value.revision as number)) return fail("invalid-response");
  return Object.freeze({ revision: value.revision as number, snapshot });
}

function parseReceipt(value: unknown, status: number, sha256: string, byteLength: number): MpcCalibrationBlobReceipt {
  if (!exactDataRecord(value, ["sha256", "byteLength", "inserted"])
    || value.sha256 !== sha256 || value.byteLength !== byteLength || typeof value.inserted !== "boolean"
    || (value.inserted && status !== 201) || (!value.inserted && status !== 200)) return fail("invalid-response");
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
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable || !isCalibrationHarnessBlobSha256(descriptor.value) || seen.has(descriptor.value)) {
      return fail("invalid-operation");
    }
    seen.add(descriptor.value);
    hashes.push(descriptor.value);
  }
  const body = JSON.stringify({ hashes });
  if (new TextEncoder().encode(body).byteLength > MAX_MISSING_BYTES) return fail("invalid-operation");
  return hashes;
}

function parseMissing(value: unknown, requested: readonly string[]): MpcCalibrationMissingBlobs {
  if (!exactDataRecord(value, ["missing"]) || !Array.isArray(value.missing) || value.missing.length > requested.length) return fail("invalid-response");
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const hash of value.missing) {
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
    if (!(value instanceof Uint8Array)) return fail("invalid-operation");
    const descriptorKeys = ["buffer", "byteOffset", "byteLength"] as const;
    if (Object.getPrototypeOf(value) !== Uint8Array.prototype || descriptorKeys.some(key => Object.getOwnPropertyDescriptor(value, key) !== undefined)) {
      return fail("invalid-operation");
    }
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

async function digestSha256(bytes: Uint8Array): Promise<string> {
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  } catch {
    return fail("invalid-operation");
  }
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function settleCancellation(cancellation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cancellation.catch(() => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function cancelResponseBody(response: Response, timeoutMs: number): Promise<void> {
  if (response.body === null) return;
  try {
    await settleCancellation(response.body.cancel(), timeoutMs);
  } catch {
    // A synchronous fixture cancellation failure must not replace the transport failure.
  }
}

function isByteChunk(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

async function requireStatus(response: Response, statuses: readonly number[], timeoutMs: number): Promise<void> {
  if (!statuses.includes(response.status)) {
    await cancelResponseBody(response, timeoutMs);
    return fail("invalid-response");
  }
}

async function boundedBody(response: Response, maximum: number, timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^(?:0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > maximum)) {
    await cancelResponseBody(response, timeoutMs);
    return fail("response-too-large");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let reason: "timeout" | "aborted" | undefined;
  const interruption = Symbol("calibration-transport-interruption");
  let resolveInterruption!: () => void;
  const interrupted = new Promise<typeof interruption>(resolve => { resolveInterruption = () => resolve(interruption); });
  let cancellation: Promise<void> | undefined;
  const cancel = (nextReason?: "timeout" | "aborted"): Promise<void> => {
    if (nextReason !== undefined && reason === undefined) {
      reason = nextReason;
      resolveInterruption();
    }
    if (cancellation === undefined) {
      try {
        cancellation = settleCancellation(reader.cancel(), timeoutMs);
      } catch {
        cancellation = Promise.resolve();
      }
    }
    return cancellation;
  };
  const abort = () => { void cancel("aborted"); };
  const timer = setTimeout(() => { void cancel("timeout"); }, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let complete = false;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), interrupted]);
      if (next === interruption || reason !== undefined) {
        await cancel();
        return fail(reason ?? "aborted");
      }
      if (next.done) break;
      if (!isByteChunk(next.value) || total + next.value.byteLength > maximum) {
        await cancel();
        return fail("response-too-large");
      }
      total += next.value.byteLength;
      chunks.push(next.value);
    }
    complete = true;
  } catch (error) {
    await cancel();
    if (error instanceof MpcCalibrationTransportError) throw error;
    return fail(reason ?? "invalid-response");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (!complete) await cancel();
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function boundedJson(response: Response, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;|\s*$)/i.test(contentType.trim())) {
    await cancelResponseBody(response, timeoutMs);
    return fail("invalid-response");
  }
  const bytes = await boundedBody(response, CALIBRATION_HARNESS_LIMITS.maxMetadataBytes, timeoutMs, signal);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("invalid-response");
  }
}

/**
 * Same-origin browser transport. It deliberately has no base URL, RequestInit,
 * browser-storage, or private-API seam. Pairing state is an in-memory identity
 * marker only; the browser owns the HttpOnly cookie and native Origin/Host/Cookie
 * headers. A returned session is not an atomic cross-tab identity binding.
 */
export function createMpcCalibrationWebTransport(options: MpcCalibrationWebTransportOptions = {}): MpcCalibrationTransport {
  const implementationFetch = options.fetch ?? globalThis.fetch;
  if (typeof implementationFetch !== "function") throw new TypeError("Calibration harness fetch unavailable");
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError("Invalid calibration harness timeout");
  let paired: MpcCalibrationSession | undefined;

  const request = async (
    path: string,
    init: RequestInit,
    requestOptions: MpcCalibrationRequestOptions | undefined,
    authenticated: boolean
  ): Promise<Response> => {
    const signal = requestOptions?.signal;
    if (signal?.aborted) return fail("aborted");
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await implementationFetch(path, {
        ...init,
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        await cancelResponseBody(response, timeoutMs);
        return fail("redirect");
      }
      if (!response.ok) {
        await cancelResponseBody(response, timeoutMs);
        if (authenticated && response.status === 401) {
          paired = undefined;
          return fail("authentication", 401);
        }
        return fail("http", response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof MpcCalibrationTransportError) throw error;
      if (timedOut) return fail("timeout");
      if (signal?.aborted) return fail("aborted");
      return fail("offline");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };

  const requirePaired = (): void => {
    if (paired === undefined) fail("unpaired");
  };
  const headers = (contentType?: string, precondition?: Record<string, string>, accept = "application/json"): Record<string, string> => ({
    accept,
    ...(contentType === undefined ? {} : { "content-type": contentType }),
    ...precondition,
  });

  const transport: MpcCalibrationTransport = {
    async pair(credential, requestOptions) {
      if (requestOptions?.signal?.aborted) return fail("aborted");
      if (typeof credential !== "string" || !PAIR_CREDENTIAL.test(credential)) return fail("invalid-operation");
      const response = await request(CALIBRATION_HARNESS_HTTP.pairPath, {
        method: "POST",
        headers: { ...headers(), authorization: `Bearer ${credential}` },
      }, requestOptions, false);
      await requireStatus(response, [200], timeoutMs);
      const session = parseSession(await boundedJson(response, timeoutMs, requestOptions?.signal));
      paired = session;
      return session;
    },
    async unpair(requestOptions) {
      requirePaired();
      const response = await request(CALIBRATION_HARNESS_HTTP.unpairPath, { method: "POST", headers: headers() }, requestOptions, true);
      if (response.status !== 204) {
        paired = undefined;
        await requireStatus(response, [204], timeoutMs);
      }
      await cancelResponseBody(response, timeoutMs);
      paired = undefined;
    },
    async getSession(requestOptions) {
      const response = await request(CALIBRATION_HARNESS_HTTP.sessionPath, { method: "GET", headers: headers() }, requestOptions, true);
      await requireStatus(response, [200], timeoutMs);
      const session = parseSession(await boundedJson(response, timeoutMs, requestOptions?.signal));
      paired = session;
      return session;
    },
    async getSnapshot(requestOptions) {
      requirePaired();
      try {
        const response = await request(CALIBRATION_HARNESS_HTTP.snapshotPath, { method: "GET", headers: headers() }, requestOptions, true);
        await requireStatus(response, [200], timeoutMs);
        return parseRevision(await boundedJson(response, timeoutMs, requestOptions?.signal), response);
      } catch (error) {
        if (error instanceof MpcCalibrationTransportError && error.code === "http" && error.status === 404) return null;
        throw error;
      }
    },
    async publishSnapshot(snapshot, expectedRevision, requestOptions) {
      requirePaired();
      if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) return fail("invalid-operation");
      let body: string;
      try {
        validateCalibrationHarnessSnapshot(snapshot);
        body = canonicalHarnessJson(snapshot);
      } catch {
        return fail("invalid-operation");
      }
      if (new TextEncoder().encode(body).byteLength > CALIBRATION_HARNESS_LIMITS.maxMetadataBytes) return fail("invalid-operation");
      const precondition: Record<string, string> = expectedRevision === null
        ? { "if-none-match": "*" }
        : { "if-match": calibrationHarnessRevisionEtag(expectedRevision) };
      const response = await request(CALIBRATION_HARNESS_HTTP.snapshotPath, {
        method: "PUT", headers: headers("application/json", precondition), body,
      }, requestOptions, true);
      await requireStatus(response, [expectedRevision === null ? 201 : 200], timeoutMs);
      const published = parseRevision(await boundedJson(response, timeoutMs, requestOptions?.signal), response);
      if (canonicalHarnessJson(published.snapshot) !== body || (expectedRevision !== null && published.revision <= expectedRevision)) {
        return fail("invalid-response");
      }
      return published;
    },
    async getBlob(sha256, requestOptions) {
      requirePaired();
      if (!isCalibrationHarnessBlobSha256(sha256)) return fail("invalid-operation");
      const response = await request(calibrationHarnessBlobPath(sha256), { method: "GET", headers: headers(undefined, undefined, "application/octet-stream") }, requestOptions, true);
      await requireStatus(response, [200], timeoutMs);
      const contentType = response.headers.get("content-type");
      if (contentType === null || !/^application\/octet-stream(?:\s*;|\s*$)/i.test(contentType.trim())) {
        await cancelResponseBody(response, timeoutMs);
        return fail("invalid-response");
      }
      const contentLength = response.headers.get("content-length");
      const identityEncoding = response.headers.get("content-encoding");
      const bytes = await boundedBody(response, CALIBRATION_HARNESS_LIMITS.maxAssetBytes, timeoutMs, requestOptions?.signal);
      if ((identityEncoding === null || identityEncoding.trim().toLowerCase() === "identity") && contentLength !== null && Number(contentLength) !== bytes.byteLength) {
        return fail("invalid-response");
      }
      if (await digestSha256(bytes) !== sha256) return fail("invalid-response");
      return bytes;
    },
    async putBlob(sha256, value, requestOptions) {
      requirePaired();
      if (!isCalibrationHarnessBlobSha256(sha256)) return fail("invalid-operation");
      const bytes = captureBytes(value, CALIBRATION_HARNESS_LIMITS.maxAssetBytes);
      if (await digestSha256(bytes) !== sha256) return fail("invalid-operation");
      const response = await request(calibrationHarnessBlobPath(sha256), {
        method: "PUT", headers: headers("application/octet-stream"), body: bytes as unknown as BodyInit,
      }, requestOptions, true);
      await requireStatus(response, [200, 201], timeoutMs);
      return parseReceipt(await boundedJson(response, timeoutMs, requestOptions?.signal), response.status, sha256, bytes.byteLength);
    },
    async missingBlobs(value, requestOptions) {
      requirePaired();
      const hashes = captureMissingHashes(value);
      const body = JSON.stringify({ hashes });
      const response = await request(CALIBRATION_HARNESS_HTTP.blobsMissingPath, {
        method: "POST", headers: headers("application/json"), body,
      }, requestOptions, true);
      await requireStatus(response, [200], timeoutMs);
      return parseMissing(await boundedJson(response, timeoutMs, requestOptions?.signal), hashes);
    },
  };
  return Object.freeze(transport);
}

export { MpcCalibrationTransportError } from "./mpcCalibrationTransport";
