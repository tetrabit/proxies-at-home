import type { ProxxiedDexie } from "@/db";
import {
  validateCalibrationHarnessPersistenceIdentity,
  type CalibrationHarnessPersistenceIdentity,
} from "../../../shared/calibrationHarnessLocalState";
import {
  hydrateMpcCalibrationCache,
  type MpcCalibrationHydrationStatus,
} from "./mpcCalibrationCache";
import type { MpcCalibrationElectronBridge } from "./mpcCalibrationElectronTransport";
import type { MpcCalibrationCapturedOperation } from "./mpcCalibrationOperationScope";
import { createMpcCalibrationLinkStateStore } from "./mpcCalibrationLinkState";
import { restoreMpcCalibrationSession } from "./mpcCalibrationSessionRestoration";
import type { MpcCalibrationSession, MpcCalibrationTransport } from "./mpcCalibrationTransport";
import {
  selectMpcCalibrationTransport,
  type MpcCalibrationTransportTarget,
} from "./mpcCalibrationTransportSelection";

type LinkedTarget = Exclude<MpcCalibrationTransportTarget, "local">;
type CapturedTransport = Pick<MpcCalibrationTransport, "getSession" | "getSnapshot" | "getBlob">;

export type MpcCalibrationInitialAdmissionInput = Readonly<{
  database: ProxxiedDexie;
  /** The finite app/connection operation that owns this admission attempt. */
  operation: Pick<MpcCalibrationCapturedOperation, "target" | "identity" | "signal" | "isCurrent">;
  /** Undefined intentionally selects request-free local mode; null is invalid. */
  target?: MpcCalibrationTransportTarget;
  local?: MpcCalibrationTransport;
  createWebTransport?: () => MpcCalibrationTransport;
  electronBridge?: MpcCalibrationElectronBridge;
  now?: () => number;
}>;

export type MpcCalibrationInitialAdmissionResult =
  | Readonly<{ kind: "local"; target: "local" }>
  | Readonly<{ kind: "hydrated"; target: LinkedTarget; revision?: number }>
  | Readonly<{ kind: "no-remote"; target: LinkedTarget }>
  | Readonly<{ kind: "blocked"; target: LinkedTarget }>
  | Readonly<{ kind: "needs-reconciliation"; target: LinkedTarget }>
  | Readonly<{ kind: "cancelled"; target: LinkedTarget }>
  | Readonly<{ kind: "failed"; target?: LinkedTarget; code: "invalid-operation" | "unavailable" }>;

type CapturedInput = Readonly<{
  database?: ProxxiedDexie;
  target: MpcCalibrationTransportTarget;
  operationTarget: MpcCalibrationTransportTarget;
  priorIdentity?: CalibrationHarnessPersistenceIdentity | null;
  signal: AbortSignal;
  isCurrent: () => boolean;
  cancelled?: true;
  createWebTransport?: () => MpcCalibrationTransport;
  electronBridge?: MpcCalibrationElectronBridge;
  now?: () => number;
}>;

function targetFrom(value: unknown): MpcCalibrationTransportTarget | undefined {
  return value === "local" || value === "linked-web" || value === "linked-electron" ? value : undefined;
}

function captureIdentity(value: CalibrationHarnessPersistenceIdentity | null): CalibrationHarnessPersistenceIdentity | null {
  if (value === null) return null;
  const identity = validateCalibrationHarnessPersistenceIdentity(value);
  return Object.freeze({
    ownerId: identity.ownerId,
    harnessId: identity.harnessId,
    connectionId: identity.connectionId,
  });
}

function sameIdentity(left: CalibrationHarnessPersistenceIdentity, right: CalibrationHarnessPersistenceIdentity): boolean {
  return left.ownerId === right.ownerId && left.harnessId === right.harnessId && left.connectionId === right.connectionId;
}

const unavailableElectronBridge: MpcCalibrationElectronBridge = Object.freeze({
  async calibrationHarnessExecute(): Promise<never> {
    throw new TypeError("Calibration Electron bridge is unavailable");
  },
});

function captureBridge(bridge: unknown): MpcCalibrationElectronBridge {
  const execute = (bridge as MpcCalibrationElectronBridge).calibrationHarnessExecute;
  if (typeof execute !== "function") throw new TypeError("Invalid calibration Electron bridge");
  return Object.freeze({ calibrationHarnessExecute: execute.bind(bridge) });
}

/** Capture the fixed preload bridge once so restoration and C3 cannot re-pick it. */
function captureDefaultElectronBridge(): MpcCalibrationElectronBridge {
  if (typeof window === "undefined") return unavailableElectronBridge;
  const candidate = window.electronAPI;
  return candidate !== undefined
    ? captureBridge(candidate)
    : unavailableElectronBridge;
}

function captureTransport(transport: MpcCalibrationTransport): CapturedTransport {
  return Object.freeze({
    getSession: transport.getSession.bind(transport),
    getSnapshot: transport.getSnapshot.bind(transport),
    getBlob: transport.getBlob.bind(transport),
  });
}

function captureInput(input: MpcCalibrationInitialAdmissionInput): CapturedInput | undefined {
  try {
    const rawTarget: unknown = input.target;
    const target = rawTarget === undefined ? "local" : targetFrom(rawTarget);
    const operation = input.operation;
    const operationTarget = targetFrom(operation.target);
    if (target === undefined || operationTarget === undefined || target !== operationTarget) return undefined;
    const signal = operation.signal;
    const isCurrent = operation.isCurrent;
    if (typeof isCurrent !== "function" || !(signal instanceof AbortSignal)) return undefined;
    const captured: CapturedInput = {
      target,
      operationTarget,
      signal,
      isCurrent: isCurrent.bind(operation),
    };
    if (target === "local") return captured;
    if (!current(captured)) return { ...captured, cancelled: true };

    const database = input.database;
    const priorIdentity = captureIdentity(operation.identity);
    const now = input.now;
    if (target === "linked-web") {
      const createWebTransport = input.createWebTransport;
      if (createWebTransport !== undefined && typeof createWebTransport !== "function") return undefined;
      return { ...captured, database, priorIdentity, now, createWebTransport };
    }

    const rawBridge = input.electronBridge;
    const electronBridge = rawBridge === undefined ? captureDefaultElectronBridge() : captureBridge(rawBridge);
    return { ...captured, database, priorIdentity, now, electronBridge };
  } catch {
    return undefined;
  }
}

function current(captured: Pick<CapturedInput, "signal" | "isCurrent">): boolean {
  try {
    return !captured.signal.aborted && captured.isCurrent() === true;
  } catch {
    return false;
  }
}

function foreignPhysicalBinding(
  value: unknown,
  session: MpcCalibrationSession | undefined,
): boolean {
  if (session === undefined || value === null || typeof value !== "object") return false;
  try {
    const binding = value as Record<string, unknown>;
    return binding.id === "mpc-calibration-cache-binding"
      && typeof binding.ownerId === "string"
      && typeof binding.harnessId === "string"
      && typeof binding.connectionId === "string"
      && Number.isSafeInteger(binding.revision)
      && (binding.revision as number) > 0
      && Number.isSafeInteger(binding.updatedAt)
      && (binding.updatedAt as number) >= 0
      && (binding.ownerId !== session.ownerId || binding.harnessId !== session.harnessId);
  } catch {
    return false;
  }
}

function resultFromHydration(
  target: LinkedTarget,
  status: MpcCalibrationHydrationStatus,
  revision: unknown,
): MpcCalibrationInitialAdmissionResult {
  switch (status) {
    case "hydrated":
      return Number.isSafeInteger(revision) && (revision as number) > 0
        ? { kind: "hydrated", target, revision: revision as number }
        : { kind: "hydrated", target };
    case "no-remote-snapshot":
      return { kind: "no-remote", target };
    case "blocked":
      return { kind: "blocked", target };
    case "needs-reconciliation":
      return { kind: "needs-reconciliation", target };
    case "cancelled":
      return { kind: "cancelled", target };
    case "failed":
      return { kind: "failed", target, code: "unavailable" };
  }
}

/**
 * Performs one finite, owner-fenced initial C3 admission. It restores a real
 * authenticated session and durable non-secret identity first, then lets C3
 * independently recheck that server identity before any cache admission.
 */
export async function runMpcCalibrationInitialAdmission(
  input: MpcCalibrationInitialAdmissionInput,
): Promise<MpcCalibrationInitialAdmissionResult> {
  const captured = captureInput(input);
  if (captured === undefined) return { kind: "failed", code: "invalid-operation" };
  if (captured.target === "local") return { kind: "local", target: "local" };
  const target = captured.target;
  if (captured.cancelled || !current(captured)) return { kind: "cancelled", target };

  let transport: CapturedTransport;
  let resolveIdentity: ReturnType<typeof createMpcCalibrationLinkStateStore>["resolve"];
  try {
    const selected = selectMpcCalibrationTransport({
      target,
      createWebTransport: captured.createWebTransport,
      electronBridge: captured.electronBridge,
    });
    transport = captureTransport(selected);
    const acceptedLinkStore = createMpcCalibrationLinkStateStore(captured.database!);
    resolveIdentity = acceptedLinkStore.resolve.bind(acceptedLinkStore);
  } catch {
    return { kind: "failed", target, code: "unavailable" };
  }

  const restorationFactory = target === "linked-web" ? () => transport as MpcCalibrationTransport : undefined;
  let authenticatedSession: MpcCalibrationSession | undefined;
  const capturedLinkStore = {
    async resolve(session: MpcCalibrationSession) {
      authenticatedSession = { ownerId: session.ownerId, harnessId: session.harnessId };
      return resolveIdentity(session);
    },
  };
  let restored;
  try {
    restored = await restoreMpcCalibrationSession({
      database: captured.database!,
      target,
      createWebTransport: restorationFactory,
      electronBridge: captured.electronBridge,
      linkStateStore: capturedLinkStore,
      signal: captured.signal,
      operation: { isCurrent: captured.isCurrent },
    });
  } catch {
    return { kind: "failed", target, code: "unavailable" };
  }

  if (!current(captured) || restored.kind === "cancelled") return { kind: "cancelled", target };
  if (restored.kind === "rejected") {
    let binding: unknown;
    try {
      binding = await captured.database!.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding");
    } catch {
      // The restoration status remains the bounded failure when its state cannot be read.
    }
    if (!current(captured)) return { kind: "cancelled", target };
    if (foreignPhysicalBinding(binding, authenticatedSession)) return { kind: "blocked", target };
    return { kind: "failed", target, code: "unavailable" };
  }
  if (restored.kind !== "restored") return { kind: "failed", target, code: "unavailable" };
  if (captured.priorIdentity !== undefined && captured.priorIdentity !== null && !sameIdentity(captured.priorIdentity, restored.identity)) {
    return { kind: "blocked", target };
  }

  try {
    const hydrated = await hydrateMpcCalibrationCache({
      database: captured.database!,
      transport,
      identity: restored.identity,
      signal: captured.signal,
      operation: { isCurrent: captured.isCurrent },
      now: captured.now,
    });
    if (!current(captured) && hydrated.status !== "cancelled") return { kind: "cancelled", target };
    return resultFromHydration(target, hydrated.status, hydrated.revision);
  } catch {
    return { kind: "failed", target, code: "unavailable" };
  }
}
