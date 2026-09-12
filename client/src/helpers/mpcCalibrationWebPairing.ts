import type { ProxxiedDexie } from "@/db";
import {
  createMpcCalibrationLinkStateStore,
  type MpcCalibrationLinkIdentity,
  type MpcCalibrationLinkStateStore,
} from "./mpcCalibrationLinkState";
import {
  MpcCalibrationTransportError,
  type MpcCalibrationSession,
  type MpcCalibrationTransport,
} from "./mpcCalibrationTransport";
import {
  selectMpcCalibrationTransport,
  type MpcCalibrationTransportTarget,
} from "./mpcCalibrationTransportSelection";

export type MpcCalibrationTransientCredential = Readonly<{
  /** Takes one user-entered credential from an owner-controlled transient input. */
  take: () => string;
  /** Clears exactly that input generation; this action never reads mutable UI state again. */
  clear: () => void;
}>;

export type MpcCalibrationWebPairingInput = Readonly<{
  database: ProxxiedDexie;
  target?: MpcCalibrationTransportTarget;
  /** A pre-auth operation is valid only for an explicitly linked-web action. */
  operation: Readonly<{
    target: MpcCalibrationTransportTarget;
    signal: AbortSignal;
    isCurrent: () => boolean;
  }>;
  transientCredential: MpcCalibrationTransientCredential;
  createWebTransport?: () => MpcCalibrationTransport;
  linkStateStore?: MpcCalibrationLinkStateStore;
}>;

export type MpcCalibrationWebPairingStatus = "offline" | "authentication" | "invalid-operation" | "unavailable";

/** Deliberately contains no credential, route, header, transport, or raw error detail. */
export type MpcCalibrationWebPairingResult =
  | Readonly<{ kind: "cancelled"; target: "linked-web" }>
  | Readonly<{ kind: "paired"; target: "linked-web"; identity: MpcCalibrationLinkIdentity }>
  | Readonly<{ kind: "rejected"; target?: "linked-web"; status: MpcCalibrationWebPairingStatus }>;

type CapturedOperation = Readonly<{
  target: MpcCalibrationTransportTarget;
  signal: AbortSignal;
  isCurrent: () => boolean;
}>;

type CapturedClear = Readonly<{ source: MpcCalibrationTransientCredential; clear: () => void }>;

type CapturedCredential = Readonly<{ credential: string }>;

/** Contains only dependencies that remain needed after the pair dispatch. */
type PairPreparation = Readonly<{
  kind: "ready";
  operation: CapturedOperation;
  pairPromise: Promise<MpcCalibrationSession>;
  getSession: MpcCalibrationTransport["getSession"];
  resolveIdentity: MpcCalibrationLinkStateStore["resolve"];
}>;

type PairPreparationResult = PairPreparation | MpcCalibrationWebPairingResult;

function rejected(status: MpcCalibrationWebPairingStatus): MpcCalibrationWebPairingResult {
  return { kind: "rejected", target: "linked-web", status };
}

function readTarget(input: MpcCalibrationWebPairingInput): MpcCalibrationTransportTarget | undefined {
  try {
    const target: unknown = input.target;
    if (target === undefined) return "local";
    if (target === "local" || target === "linked-web" || target === "linked-electron") return target;
  } catch {
    // Do not reflect a hostile target getter.
  }
  return undefined;
}

function captureOperation(input: MpcCalibrationWebPairingInput): CapturedOperation | undefined {
  try {
    const operation = input.operation;
    const target = operation.target;
    if (target !== "local" && target !== "linked-web" && target !== "linked-electron") return undefined;
    const signal = operation.signal;
    const current = operation.isCurrent;
    if (!(signal instanceof AbortSignal) || typeof current !== "function") return undefined;
    return { target, signal, isCurrent: current.bind(operation) };
  } catch {
    return undefined;
  }
}

function current(operation: CapturedOperation): boolean {
  try {
    return !operation.signal.aborted && operation.isCurrent() === true;
  } catch {
    return false;
  }
}

function captureClear(input: MpcCalibrationWebPairingInput): CapturedClear | undefined {
  try {
    const transientCredential = input.transientCredential;
    const candidateClear = transientCredential.clear;
    if (typeof candidateClear !== "function") return undefined;
    return { source: transientCredential, clear: candidateClear.bind(transientCredential) };
  } catch {
    return undefined;
  }
}

function clearCaptured(captured: CapturedClear): boolean {
  try {
    captured.clear();
    return true;
  } catch {
    return false;
  }
}

/**
 * Takes and clears synchronously before the first await. This preserves original
 * ownership: a later user entry cannot be cleared by an older settlement.
 */
function captureCredential(capturedClear: CapturedClear): CapturedCredential | undefined {
  let credential: unknown;
  try {
    const transientCredential = capturedClear.source;
    const take = transientCredential.take;
    if (typeof take === "function") credential = take.call(transientCredential);
  } catch {
    // Still attempt clearing the captured owned input.
  }
  if (!clearCaptured(capturedClear)) return undefined;
  return typeof credential === "string" ? { credential } : undefined;
}

function dispatchPair(
  pair: MpcCalibrationTransport["pair"],
  credential: string,
  signal: AbortSignal,
): Promise<MpcCalibrationSession> {
  return pair(credential, { signal });
}

function captureSession(value: unknown): MpcCalibrationSession | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length !== 0) return undefined;
    const names = Object.getOwnPropertyNames(value).sort();
    if (names.length !== 2 || names[0] !== "harnessId" || names[1] !== "ownerId") return undefined;
    const owner = Object.getOwnPropertyDescriptor(value, "ownerId");
    const harness = Object.getOwnPropertyDescriptor(value, "harnessId");
    if (owner === undefined || harness === undefined || !("value" in owner) || !("value" in harness) || !owner.enumerable || !harness.enumerable) return undefined;
    if (!boundedIdentity(owner.value) || !boundedIdentity(harness.value)) return undefined;
    return Object.freeze({ ownerId: owner.value, harnessId: harness.value });
  } catch {
    return undefined;
  }
}

function captureIdentity(value: unknown): MpcCalibrationLinkIdentity | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length !== 0) return undefined;
    const names = Object.getOwnPropertyNames(value).sort();
    if (names.length !== 3 || names[0] !== "connectionId" || names[1] !== "harnessId" || names[2] !== "ownerId") return undefined;
    const owner = Object.getOwnPropertyDescriptor(value, "ownerId");
    const harness = Object.getOwnPropertyDescriptor(value, "harnessId");
    const connection = Object.getOwnPropertyDescriptor(value, "connectionId");
    if (owner === undefined || harness === undefined || connection === undefined
      || !("value" in owner) || !("value" in harness) || !("value" in connection)
      || !owner.enumerable || !harness.enumerable || !connection.enumerable
      || !boundedIdentity(owner.value) || !boundedIdentity(harness.value) || !boundedIdentity(connection.value)) return undefined;
    return Object.freeze({ ownerId: owner.value, harnessId: harness.value, connectionId: connection.value });
  } catch {
    return undefined;
  }
}

function boundedIdentity(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;
  // eslint-disable-next-line no-control-regex -- durable identity excludes control characters.
  return !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function statusFor(error: unknown): MpcCalibrationWebPairingStatus {
  try {
    if (!(error instanceof MpcCalibrationTransportError)) return "unavailable";
    const code = error.code;
    switch (code) {
      case "offline":
        return "offline";
      case "authentication":
      case "unpaired":
        return "authentication";
      case "invalid-operation":
        return "invalid-operation";
      default:
        return "unavailable";
    }
  } catch {
    return "unavailable";
  }
}

/**
 * Performs one finite linked-web pairing action. The input credential is cleared
 * synchronously after transfer; browser cookies remain owned by the fixed web
 * transport, and only validated non-secret link identity is persisted.
 */
function prepareMpcCalibrationWebPairing(input: MpcCalibrationWebPairingInput): PairPreparationResult {
  let capturedClear = captureClear(input);
  const target = readTarget(input);
  if (capturedClear === undefined) return target === "linked-web"
    ? rejected("invalid-operation")
    : { kind: "rejected", status: "invalid-operation" };
  if (target !== "linked-web") {
    clearCaptured(capturedClear);
    return { kind: "rejected", status: "invalid-operation" };
  }

  const operation = captureOperation(input);
  if (operation === undefined || operation.target !== "linked-web") {
    clearCaptured(capturedClear);
    return rejected("invalid-operation");
  }

  let capturedCredential = captureCredential(capturedClear);
  if (capturedCredential === undefined) return rejected("invalid-operation");
  if (!current(operation)) return { kind: "cancelled", target: "linked-web" };

  let pair: MpcCalibrationTransport["pair"];
  let getSession: MpcCalibrationTransport["getSession"];
  let resolveIdentity: MpcCalibrationLinkStateStore["resolve"];
  try {
    const transport = selectMpcCalibrationTransport({ target: "linked-web", createWebTransport: input.createWebTransport });
    pair = transport.pair.bind(transport);
    getSession = transport.getSession.bind(transport);
    const store = input.linkStateStore ?? createMpcCalibrationLinkStateStore(input.database);
    resolveIdentity = store.resolve.bind(store);
  } catch (error) {
    return rejected(statusFor(error));
  }

  if (!current(operation)) return { kind: "cancelled", target: "linked-web" };
  const credential = capturedCredential.credential;
  capturedCredential = undefined;
  capturedClear = undefined;
  try {
    return {
      kind: "ready",
      operation,
      pairPromise: dispatchPair(pair, credential, operation.signal),
      getSession,
      resolveIdentity,
    };
  } catch (error) {
    return current(operation) ? rejected(statusFor(error)) : { kind: "cancelled", target: "linked-web" };
  }
}

async function finishMpcCalibrationWebPairing(preparation: PairPreparation): Promise<MpcCalibrationWebPairingResult> {
  const { operation, pairPromise, getSession, resolveIdentity } = preparation;
  let paired: MpcCalibrationSession;
  try {
    const response = await pairPromise;
    if (!current(operation)) return { kind: "cancelled", target: "linked-web" };
    const session = captureSession(response);
    if (session === undefined) return rejected("unavailable");
    paired = session;
  } catch (error) {
    return current(operation) ? rejected(statusFor(error)) : { kind: "cancelled", target: "linked-web" };
  }

  if (!current(operation)) return { kind: "cancelled", target: "linked-web" };
  let discovered: MpcCalibrationSession;
  try {
    const response = await getSession({ signal: operation.signal });
    if (!current(operation)) return { kind: "cancelled", target: "linked-web" };
    const session = captureSession(response);
    if (session === undefined) return rejected("unavailable");
    discovered = session;
  } catch (error) {
    return current(operation) ? rejected(statusFor(error)) : { kind: "cancelled", target: "linked-web" };
  }

  if (!current(operation)) return { kind: "cancelled", target: "linked-web" };
  if (paired.ownerId !== discovered.ownerId || paired.harnessId !== discovered.harnessId) return rejected("authentication");

  let identity: MpcCalibrationLinkIdentity;
  try {
    const resolved = await resolveIdentity(discovered);
    if (!current(operation)) return { kind: "cancelled", target: "linked-web" };
    const captured = captureIdentity(resolved);
    if (captured === undefined || captured.ownerId !== discovered.ownerId || captured.harnessId !== discovered.harnessId) return rejected("unavailable");
    identity = captured;
  } catch (error) {
    return current(operation) ? rejected(statusFor(error)) : { kind: "cancelled", target: "linked-web" };
  }

  if (!current(operation)) return { kind: "cancelled", target: "linked-web" };
  return { kind: "paired", target: "linked-web", identity };
}

export function pairMpcCalibrationWeb(input: MpcCalibrationWebPairingInput): Promise<MpcCalibrationWebPairingResult> {
  const preparation = prepareMpcCalibrationWebPairing(input);
  return preparation.kind === "ready"
    ? finishMpcCalibrationWebPairing(preparation)
    : Promise.resolve(preparation);
}
