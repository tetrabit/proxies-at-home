import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

export const CALIBRATION_HARNESS_CONFIG_MAX_BYTES = 16 * 1024;

const CONFIG_KEYS = ["backendOrigin", "credential", "harnessId", "version"] as const;
const CREDENTIAL_PATTERN = /^calibration_pair_[A-Za-z0-9_-]{43}$/;

type PrivateValues = Readonly<{
  backendOrigin: string;
  harnessId: string;
  credential: string;
}>;

type FileIdentity = Readonly<{
  dev: number;
  ino: number;
  byteLength: number;
  mode: number;
}>;

const privateValues = new WeakMap<CalibrationHarnessPrivateConfig, PrivateValues>();
const fileIdentities = new WeakMap<CalibrationHarnessPrivateConfig, FileIdentity>();

/** A Node-main-only, parsed config whose credential is retained outside public fields. */
export class CalibrationHarnessPrivateConfig {
  readonly harnessId: string;

  private constructor(values: PrivateValues) {
    this.harnessId = values.harnessId;
    privateValues.set(this, values);
    Object.freeze(this);
  }

  static fromValues(values: PrivateValues): CalibrationHarnessPrivateConfig {
    return new CalibrationHarnessPrivateConfig(values);
  }
}

export type CalibrationHarnessConfigLoadResult =
  | Readonly<{ kind: "not-configured" }>
  | Readonly<{
    kind: "configured";
    config: CalibrationHarnessPrivateConfig;
    file: Readonly<{ byteLength: number; mode: number }>;
    platformSecurity: "posix-owner-mode" | "best-effort-acl";
  }>;

export class CalibrationHarnessConfigError extends Error {
  readonly code: "invalid-config" | "untrusted-config";

  constructor(code: "invalid-config" | "untrusted-config") {
    super(code === "invalid-config" ? "invalid private configuration" : "untrusted private configuration");
    this.name = "CalibrationHarnessConfigError";
    this.code = code;
  }
}

function configError(code: CalibrationHarnessConfigError["code"]): never {
  throw new CalibrationHarnessConfigError(code);
}

function exactDataRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value).sort();
  if (names.length !== keys.length || names.some((name, index) => name !== [...keys].sort()[index])) return false;
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}

function isBoundedIdentity(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

function isCanonicalBackendOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const loopbackHttp = parsed.protocol === "http:"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
  return (parsed.protocol === "https:" || loopbackHttp)
    && parsed.username === ""
    && parsed.password === ""
    && parsed.pathname === "/"
    && parsed.search === ""
    && parsed.hash === ""
    && parsed.origin === value;
}

/** Parses the exact provisioning JSON shape; it does not read the filesystem. */
export function parseCalibrationHarnessConfig(value: unknown): CalibrationHarnessPrivateConfig {
  if (!exactDataRecord(value, CONFIG_KEYS)
    || value.version !== 1
    || !isCanonicalBackendOrigin(value.backendOrigin)
    || !isBoundedIdentity(value.harnessId)
    || typeof value.credential !== "string"
    || !CREDENTIAL_PATTERN.test(value.credential)) {
    return configError("invalid-config");
  }
  return CalibrationHarnessPrivateConfig.fromValues({
    backendOrigin: value.backendOrigin,
    harnessId: value.harnessId,
    credential: value.credential,
  });
}

/** Internal Node-main handoff; operation results never receive these values. */
export function calibrationHarnessPrivateValues(config: CalibrationHarnessPrivateConfig): PrivateValues {
  const values = privateValues.get(config);
  if (values === undefined) return configError("untrusted-config");
  return values;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertSafeAncestors(filename: string): Promise<void> {
  const resolved = path.resolve(filename);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component);
    let stat;
    try {
      stat = await lstat(current);
    } catch {
      return configError("untrusted-config");
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return configError("untrusted-config");
    if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) return configError("untrusted-config");
  }
}

function assertPrivateFile(stat: { isFile(): boolean; isSymbolicLink(): boolean; mode: number; uid: number }): void {
  if (!stat.isFile() || stat.isSymbolicLink()) return configError("untrusted-config");
  if (process.platform !== "win32") {
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (currentUid === undefined || stat.uid !== currentUid || (stat.mode & 0o777) !== 0o600) {
      return configError("untrusted-config");
    }
  }
}

async function readBoundedPrivateFile(filename: string): Promise<{ bytes: Uint8Array; identity: FileIdentity }> {
  await assertSafeAncestors(filename);
  let before;
  try {
    before = await lstat(filename);
  } catch (error) {
    if (isMissing(error)) throw error;
    return configError("untrusted-config");
  }
  assertPrivateFile(before);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    assertPrivateFile(opened);
    if (!sameIdentity(before, opened) || !Number.isSafeInteger(opened.size) || opened.size < 0) {
      return configError("untrusted-config");
    }
    if (opened.size > CALIBRATION_HARNESS_CONFIG_MAX_BYTES) {
      return configError("invalid-config");
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let read = 0;
    while (read < buffer.byteLength) {
      const result = await handle.read(buffer, read, buffer.byteLength - read, read);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    const after = await handle.stat();
    if (!sameIdentity(opened, after) || after.size !== opened.size || read > opened.size) {
      return configError("untrusted-config");
    }
    return {
      bytes: buffer.subarray(0, read),
      identity: Object.freeze({ dev: opened.dev, ino: opened.ino, byteLength: read, mode: opened.mode & 0o777 }),
    };
  } catch (error) {
    if (error instanceof CalibrationHarnessConfigError || isMissing(error)) throw error;
    return configError("untrusted-config");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Loads only an operator-provisioned private file. Missing is not an error. */
export async function loadCalibrationHarnessConfig(filename: string): Promise<CalibrationHarnessConfigLoadResult> {
  if (typeof filename !== "string" || filename.length === 0) return configError("invalid-config");
  let loaded: { bytes: Uint8Array; identity: FileIdentity };
  try {
    loaded = await readBoundedPrivateFile(filename);
  } catch (error) {
    if (isMissing(error)) return Object.freeze({ kind: "not-configured" as const });
    if (error instanceof CalibrationHarnessConfigError) throw error;
    return configError("untrusted-config");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes));
  } catch {
    return configError("invalid-config");
  }
  const config = parseCalibrationHarnessConfig(parsed);
  fileIdentities.set(config, loaded.identity);
  return Object.freeze({
    kind: "configured" as const,
    config,
    file: Object.freeze({ byteLength: loaded.identity.byteLength, mode: loaded.identity.mode }),
    platformSecurity: process.platform === "win32" ? "best-effort-acl" as const : "posix-owner-mode" as const,
  });
}

/** Available to the Node-main module for diagnostics-free identity capture only. */
export function calibrationHarnessConfigFileIdentity(config: CalibrationHarnessPrivateConfig): FileIdentity | undefined {
  return fileIdentities.get(config);
}
