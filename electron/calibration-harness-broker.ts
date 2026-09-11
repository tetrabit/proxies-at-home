import { createHash } from "node:crypto";
import {
  CALIBRATION_HARNESS_LIMITS,
  canonicalHarnessJson,
  validateCalibrationHarnessSnapshot,
  type CalibrationHarnessRevision,
  type CalibrationHarnessSnapshot,
} from "../shared/calibrationHarness.js";
import {
  calibrationHarnessPrivateValues,
  type CalibrationHarnessConfigLoadResult,
  type CalibrationHarnessPrivateConfig,
} from "./calibration-harness-config.js";

const API_ROOT = "/api/calibration-harness";
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_MISSING_HASHES = 512;
const MAX_MISSING_REQUEST_BYTES = 64 * 1024;

type BrokerCode = "not-configured" | "invalid-operation" | "http" | "offline" | "timeout" | "aborted" | "redirect" | "response-too-large" | "invalid-response";

export class CalibrationHarnessBrokerError extends Error {
  readonly code: BrokerCode;
  readonly status?: number;

  constructor(code: BrokerCode, status?: number) {
    super(code === "http" ? "calibration harness request failed" : `calibration harness ${code}`);
    this.name = "CalibrationHarnessBrokerError";
    this.code = code;
    this.status = status;
  }
}

export type CalibrationHarnessSession = Readonly<{ ownerId: string; harnessId: string }>;
export type CalibrationHarnessBlobReceipt = Readonly<{ sha256: string; byteLength: number; inserted: boolean }>;
export type CalibrationHarnessMissingBlobs = Readonly<{ missing: string[] }>;

export type CalibrationHarnessOperation =
  | Readonly<{ kind: "getSession" }>
  | Readonly<{ kind: "getSnapshot" }>
  | Readonly<{ kind: "publishSnapshot"; snapshot: CalibrationHarnessSnapshot; expectedRevision: number | null }>
  | Readonly<{ kind: "getBlob"; sha256: string }>
  | Readonly<{ kind: "putBlob"; sha256: string; bytes: Uint8Array | ArrayBuffer }>
  | Readonly<{ kind: "missingBlobs"; hashes: string[] }>;

export type CalibrationHarnessBroker = Readonly<{
  execute(operation: unknown): Promise<CalibrationHarnessSession | CalibrationHarnessRevision | Uint8Array | CalibrationHarnessBlobReceipt | CalibrationHarnessMissingBlobs>;
}>;

export type CalibrationHarnessBrokerOptions = Readonly<{
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

function fail(code: BrokerCode, status?: number): never {
  throw new CalibrationHarnessBrokerError(code, status);
}

function exactDataRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) return false;
  return names.every((name) => {
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

function captureMissingHashes(value: unknown): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return fail("invalid-operation");
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MISSING_HASHES
    || Object.getOwnPropertyNames(value).length !== length + 1) return fail("invalid-operation");
  const hashes: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable
      || typeof descriptor.value !== "string" || !SHA256.test(descriptor.value)) return fail("invalid-operation");
    hashes.push(descriptor.value);
  }
  if (new Set(hashes).size !== hashes.length) return fail("invalid-operation");
  return hashes;
}

function parseOperation(value: unknown): CalibrationHarnessOperation {
  if (!exactDataRecord(value, ["kind"]) && !(value !== null && typeof value === "object")) return fail("invalid-operation");
  const kind = exactDataRecord(value, ["kind"])
    ? value.kind
    : (Object.getOwnPropertyDescriptor(value, "kind")?.value);
  switch (kind) {
    case "getSession":
    case "getSnapshot":
      if (!exactDataRecord(value, ["kind"])) return fail("invalid-operation");
      return { kind };
    case "publishSnapshot": {
      if (!exactDataRecord(value, ["kind", "snapshot", "expectedRevision"])) {
        return fail("invalid-operation");
      }
      const expectedRevision = value.expectedRevision;
      if (expectedRevision !== null && (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) return fail("invalid-operation");
      try {
        return { kind, snapshot: validateCalibrationHarnessSnapshot(value.snapshot), expectedRevision: expectedRevision as number | null };
      } catch {
        return fail("invalid-operation");
      }
    }
    case "getBlob":
      if (!exactDataRecord(value, ["kind", "sha256"]) || typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) {
        return fail("invalid-operation");
      }
      return { kind, sha256: value.sha256 };
    case "putBlob": {
      if (!exactDataRecord(value, ["kind", "sha256", "bytes"]) || typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) {
        return fail("invalid-operation");
      }
      const bytes = byteView(value.bytes);
      if (bytes === undefined || bytes.byteLength > CALIBRATION_HARNESS_LIMITS.maxAssetBytes) return fail("invalid-operation");
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== value.sha256) return fail("invalid-operation");
      return { kind, sha256: value.sha256, bytes: value.bytes as Uint8Array | ArrayBuffer };
    }
    case "missingBlobs": {
      if (!exactDataRecord(value, ["kind", "hashes"])) {
        return fail("invalid-operation");
      }
      const hashes = captureMissingHashes(value.hashes);
      try {
        const encoded = JSON.stringify({ hashes });
        if (Buffer.byteLength(encoded, "utf8") > MAX_MISSING_REQUEST_BYTES) return fail("invalid-operation");
      } catch {
        return fail("invalid-operation");
      }
      return { kind, hashes };
    }
    default:
      return fail("invalid-operation");
  }
}

function byteView(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) {
    if (Object.getPrototypeOf(value) !== ArrayBuffer.prototype
      || Object.getOwnPropertyDescriptor(value, "byteLength") !== undefined) return undefined;
    return new Uint8Array(value);
  }
  if (value instanceof Uint8Array) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) return undefined;
    for (const key of ["buffer", "byteOffset", "byteLength"]) {
      if (Object.getOwnPropertyDescriptor(value, key) !== undefined) return undefined;
    }
    if (!(value.buffer instanceof ArrayBuffer)) return undefined;
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

function responseEtag(response: Response, revision: number): void {
  if (response.headers.get("etag") !== `"${revision}"`) fail("invalid-response");
}

async function settleCancellation(cancellation: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cancellation.catch(() => undefined),
      new Promise<void>(resolve => { timeout = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function cancelResponseBody(response: Response, timeoutMs: number): Promise<void> {
  if (response.body === null) return;
  try {
    await settleCancellation(response.body.cancel(), timeoutMs);
  } catch {
    // A synchronous injected cancellation failure cannot replace the declared transport error.
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
  let interruption: "timeout" | "aborted" | undefined;
  const interruptionMarker = Symbol("calibration-harness-interrupted");
  let resolveInterruption!: () => void;
  const interrupted = new Promise<typeof interruptionMarker>(resolve => {
    resolveInterruption = () => resolve(interruptionMarker);
  });
  let cancellation: Promise<void> | undefined;
  const cancelReader = (reason?: "timeout" | "aborted"): Promise<void> => {
    if (reason !== undefined) {
      interruption ??= reason;
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
  const abortReader = () => { void cancelReader("aborted"); };
  const timeout = setTimeout(() => { void cancelReader("timeout"); }, timeoutMs);
  signal?.addEventListener("abort", abortReader, { once: true });
  if (signal?.aborted) abortReader();
  let completed = false;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), interrupted]);
      if (next === interruptionMarker || interruption !== undefined) {
        await cancelReader();
        return fail(interruption ?? "aborted");
      }
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || total + next.value.byteLength > maximum) {
        await cancelReader();
        return fail("response-too-large");
      }
      total += next.value.byteLength;
      chunks.push(next.value);
    }
    completed = true;
  } catch (error) {
    await cancelReader();
    if (error instanceof CalibrationHarnessBrokerError) throw error;
    if (interruption !== undefined) return fail(interruption);
    return fail("invalid-response");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortReader);
    if (!completed) await cancelReader();
    reader.releaseLock();
  }
  const assembled = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    assembled.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return assembled;
}

async function boundedJson(response: Response, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const body = await boundedBody(response, CALIBRATION_HARNESS_LIMITS.maxMetadataBytes, timeoutMs, signal);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return fail("invalid-response");
  }
}

function parseSession(value: unknown, expectedHarnessId: string): CalibrationHarnessSession {
  if (!exactDataRecord(value, ["ownerId", "harnessId"])
    || !boundedIdentity(value.ownerId)
    || value.harnessId !== expectedHarnessId) {
    return fail("invalid-response");
  }
  return Object.freeze({ ownerId: value.ownerId, harnessId: value.harnessId });
}

function parseRevision(value: unknown, response: Response): CalibrationHarnessRevision {
  if (!exactDataRecord(value, ["revision", "snapshot"])
    || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    return fail("invalid-response");
  }
  const revision = value.revision as number;
  let snapshot: CalibrationHarnessSnapshot;
  try {
    snapshot = validateCalibrationHarnessSnapshot(value.snapshot);
  } catch {
    return fail("invalid-response");
  }
  responseEtag(response, revision);
  return Object.freeze({ revision, snapshot });
}

function parseReceipt(value: unknown, status: number, expectedHash: string, expectedLength: number): CalibrationHarnessBlobReceipt {
  if (!exactDataRecord(value, ["sha256", "byteLength", "inserted"])
    || value.sha256 !== expectedHash || value.byteLength !== expectedLength || typeof value.inserted !== "boolean"
    || (value.inserted && status !== 201) || (!value.inserted && status !== 200)) {
    return fail("invalid-response");
  }
  return Object.freeze({ sha256: value.sha256, byteLength: value.byteLength, inserted: value.inserted });
}

function parseMissing(value: unknown, requested: readonly string[]): CalibrationHarnessMissingBlobs {
  if (!exactDataRecord(value, ["missing"]) || !Array.isArray(value.missing)
    || value.missing.some((hash) => typeof hash !== "string" || !SHA256.test(hash))
    || value.missing.length > requested.length || new Set(value.missing).size !== value.missing.length
    || value.missing.some((hash) => !requested.includes(hash))) {
    return fail("invalid-response");
  }
  return Object.freeze({ missing: [...value.missing] });
}

function fixedUrl(origin: string, suffix: string): string {
  return new URL(`${API_ROOT}${suffix}`, origin).href;
}

/**
 * Main-process-only fixed-origin transport. It has no renderer URL/header/cache
 * inputs and never returns the private credential or configured origin.
 */
export function createCalibrationHarnessBroker(
  input: CalibrationHarnessPrivateConfig | CalibrationHarnessConfigLoadResult,
  options: CalibrationHarnessBrokerOptions = {},
): CalibrationHarnessBroker {
  const configured = input instanceof Object && "kind" in input
    ? input.kind === "configured" ? input.config : undefined
    : input;
  if (configured === undefined) {
    return Object.freeze({ execute: async () => fail("not-configured") });
  }
  const values = calibrationHarnessPrivateValues(configured);
  const implementationFetch = options.fetch ?? globalThis.fetch;
  if (typeof implementationFetch !== "function") throw new TypeError("calibration harness fetch unavailable");
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError("invalid calibration harness timeout");

  const request = async (url: string, init: RequestInit): Promise<Response> => {
    const externalSignal = options.signal;
    if (externalSignal?.aborted) return fail("aborted");
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await implementationFetch(url, { ...init, credentials: "omit", redirect: "error", signal: controller.signal });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        await cancelResponseBody(response, timeoutMs);
        return fail("redirect");
      }
      if (!response.ok) {
        await cancelResponseBody(response, timeoutMs);
        return fail("http", response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof CalibrationHarnessBrokerError) throw error;
      if (timedOut) return fail("timeout");
      if (externalSignal?.aborted) return fail("aborted");
      return fail("offline");
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abort);
    }
  };

  const headers = (contentType?: string, precondition?: Record<string, string>): Record<string, string> => ({
    accept: "application/json",
    authorization: `Bearer ${values.credential}`,
    ...(contentType === undefined ? {} : { "content-type": contentType }),
    ...precondition,
  });

  return Object.freeze({
    async execute(untrustedOperation: unknown) {
      let operation: CalibrationHarnessOperation;
      try {
        operation = parseOperation(untrustedOperation);
      } catch (error) {
        if (error instanceof CalibrationHarnessBrokerError) throw error;
        return fail("invalid-operation");
      }
      switch (operation.kind) {
        case "getSession": {
          const response = await request(fixedUrl(values.backendOrigin, "/session"), { method: "GET", headers: headers() });
          return parseSession(await boundedJson(response, timeoutMs, options.signal), values.harnessId);
        }
        case "getSnapshot": {
          const response = await request(fixedUrl(values.backendOrigin, "/snapshot"), { method: "GET", headers: headers() });
          return parseRevision(await boundedJson(response, timeoutMs, options.signal), response);
        }
        case "publishSnapshot": {
          let body: string;
          try {
            body = canonicalHarnessJson(operation.snapshot);
          } catch {
            return fail("invalid-operation");
          }
          if (Buffer.byteLength(body, "utf8") > CALIBRATION_HARNESS_LIMITS.maxMetadataBytes) return fail("invalid-operation");
          const precondition: Record<string, string> = operation.expectedRevision === null
            ? { "if-none-match": "*" }
            : { "if-match": `"${operation.expectedRevision}"` };
          const response = await request(fixedUrl(values.backendOrigin, "/snapshot"), {
            method: "PUT", headers: headers("application/json", precondition), body,
          });
          return parseRevision(await boundedJson(response, timeoutMs, options.signal), response);
        }
        case "getBlob": {
          const response = await request(fixedUrl(values.backendOrigin, `/blobs/${operation.sha256}`), { method: "GET", headers: headers() });
          const bytes = await boundedBody(response, CALIBRATION_HARNESS_LIMITS.maxAssetBytes, timeoutMs, options.signal);
          if (createHash("sha256").update(bytes).digest("hex") !== operation.sha256) return fail("invalid-response");
          return bytes;
        }
        case "putBlob": {
          const bytes = byteView(operation.bytes);
          if (bytes === undefined) return fail("invalid-operation");
          const response = await request(fixedUrl(values.backendOrigin, `/blobs/${operation.sha256}`), {
            method: "PUT", headers: headers("application/octet-stream"), body: operation.bytes as unknown as BodyInit,
          });
          return parseReceipt(await boundedJson(response, timeoutMs, options.signal), response.status, operation.sha256, bytes.byteLength);
        }
        case "missingBlobs": {
          const body = JSON.stringify({ hashes: operation.hashes });
          const response = await request(fixedUrl(values.backendOrigin, "/blobs/missing"), {
            method: "POST", headers: headers("application/json"), body,
          });
          return parseMissing(await boundedJson(response, timeoutMs, options.signal), operation.hashes);
        }
      }
    },
  });
}
