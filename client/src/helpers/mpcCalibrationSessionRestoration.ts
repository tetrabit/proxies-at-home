import type { ProxxiedDexie } from "@/db";
import {
  createMpcCalibrationLinkStateStore,
  type MpcCalibrationLinkIdentity,
  type MpcCalibrationLinkStateStore,
} from "./mpcCalibrationLinkState";
import type { MpcCalibrationElectronBridge } from "./mpcCalibrationElectronTransport";
import {
  MpcCalibrationTransportError,
  type MpcCalibrationSession,
  type MpcCalibrationTransport,
} from "./mpcCalibrationTransport";
import {
  selectMpcCalibrationTransport,
  type MpcCalibrationTransportTarget,
} from "./mpcCalibrationTransportSelection";

type MpcCalibrationLinkedTransportTarget = Exclude<MpcCalibrationTransportTarget, "local">;
export type MpcCalibrationSessionRestorationStatus =
  | "offline"
  | "unpaired"
  | "authentication"
  | "invalid-operation"
  | "unavailable";

export type MpcCalibrationSessionRestorationResult =
  | Readonly<{ kind: "local"; target: "local" }>
  | Readonly<{ kind: "restored"; target: MpcCalibrationLinkedTransportTarget; identity: MpcCalibrationLinkIdentity }>
  | Readonly<{ kind: "rejected"; target: MpcCalibrationLinkedTransportTarget; status: MpcCalibrationSessionRestorationStatus }>
  | Readonly<{ kind: "cancelled"; target: MpcCalibrationLinkedTransportTarget }>;

export type MpcCalibrationSessionRestorationInput = Readonly<{
  database: ProxxiedDexie;
  target?: MpcCalibrationTransportTarget;
  local?: MpcCalibrationTransport;
  createWebTransport?: () => MpcCalibrationTransport;
  electronBridge?: MpcCalibrationElectronBridge;
  /** An owning controller may inject the accepted non-secret identity boundary. */
  linkStateStore?: MpcCalibrationLinkStateStore;
  signal?: AbortSignal;
  operation?: Readonly<{ isCurrent?: () => boolean }>;
}>;

function current(signal: AbortSignal | undefined, isCurrent: (() => boolean) | undefined): boolean {
  try {
    return !signal?.aborted && isCurrent?.() !== false;
  } catch {
    return false;
  }
}

function targetFrom(input: MpcCalibrationSessionRestorationInput): MpcCalibrationTransportTarget {
  try {
    const rawTarget: unknown = input.target;
    const target = rawTarget === undefined ? "local" : rawTarget;
    if (target === "local" || target === "linked-web" || target === "linked-electron") return target;
  } catch {
    // A failed target read has no safe target to expose.
  }
  throw new MpcCalibrationTransportError("invalid-operation");
}

function statusFor(error: unknown): MpcCalibrationSessionRestorationStatus {
  try {
    if (!(error instanceof MpcCalibrationTransportError)) return "unavailable";
    const code = error.code;
    switch (code) {
      case "offline":
      case "unpaired":
      case "authentication":
      case "invalid-operation":
        return code;
      default:
        return "unavailable";
    }
  } catch {
    return "unavailable";
  }
}

/**
 * Performs one finite authentication-and-identity action. It neither hydrates nor
 * synchronizes protocol/cache state. A cancelled result can leave only metadata
 * already committed by the accepted link store; this outer fence cannot roll it back.
 */
export async function restoreMpcCalibrationSession(
  input: MpcCalibrationSessionRestorationInput
): Promise<MpcCalibrationSessionRestorationResult> {
  const target = targetFrom(input);
  if (target === "local") return { kind: "local", target };

  let signal: AbortSignal | undefined;
  let isCurrent: (() => boolean) | undefined;
  let getSession: MpcCalibrationTransport["getSession"];
  let resolveIdentity: MpcCalibrationLinkStateStore["resolve"];
  try {
    signal = input.signal;
    const operation = input.operation;
    isCurrent = operation?.isCurrent?.bind(operation);
    if (!current(signal, isCurrent)) return { kind: "cancelled", target };

    const transport = selectMpcCalibrationTransport({
      target,
      local: input.local,
      createWebTransport: input.createWebTransport,
      electronBridge: input.electronBridge,
    });
    getSession = transport.getSession.bind(transport);
    const store = input.linkStateStore ?? createMpcCalibrationLinkStateStore(input.database);
    resolveIdentity = store.resolve.bind(store);
  } catch (error) {
    return { kind: "rejected", target, status: statusFor(error) };
  }

  if (!current(signal, isCurrent)) return { kind: "cancelled", target };
  let session: MpcCalibrationSession;
  try {
    session = await getSession({ signal });
  } catch (error) {
    if (!current(signal, isCurrent)) return { kind: "cancelled", target };
    return { kind: "rejected", target, status: statusFor(error) };
  }

  if (!current(signal, isCurrent)) return { kind: "cancelled", target };
  let identity: MpcCalibrationLinkIdentity;
  try {
    identity = await resolveIdentity(session);
  } catch (error) {
    if (!current(signal, isCurrent)) return { kind: "cancelled", target };
    return { kind: "rejected", target, status: statusFor(error) };
  }

  if (!current(signal, isCurrent)) return { kind: "cancelled", target };
  return { kind: "restored", target, identity };
}
