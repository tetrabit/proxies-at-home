import { useEffect } from "react";
import { liveQuery } from "dexie";
import { db, type ProxxiedDexie } from "@/db";
import {
  createMpcCalibrationOperationScope,
  type MpcCalibrationOperationScope,
} from "@/helpers/mpcCalibrationOperationScope";
import {
  createMpcCalibrationQueueRecoveryController,
  type MpcCalibrationQueueRecoveryController,
} from "@/helpers/mpcCalibrationQueueRecoveryController";
import type { MpcCalibrationQueuedRecoveryResult } from "@/helpers/mpcCalibrationQueuedRecovery";
import { createMpcCalibrationSyncStateStore } from "@/helpers/mpcCalibrationSyncState";
import {
  createMpcCalibrationRefreshScheduler,
  type MpcCalibrationRefreshScheduler,
  type MpcCalibrationRefreshSchedulerStatus,
} from "@/helpers/mpcCalibrationRefreshScheduler";
import { disableMpcCalibrationLink } from "@/helpers/mpcCalibrationDisable";
import {
  runMpcCalibrationInitialAdmissionWithIdentity,
  type MpcCalibrationInitialAdmissionWithIdentityResult,
} from "@/helpers/mpcCalibrationInitialAdmission";
import { selectMpcCalibrationTransport } from "@/helpers/mpcCalibrationTransportSelection";
import type { CalibrationHarnessPersistenceIdentity } from "../../../shared/calibrationHarnessLocalState";
import {
  useMpcCalibrationSyncStore,
  type MpcCalibrationSyncStatus,
} from "@/store/mpcCalibrationSync";

type LinkedTarget = "linked-web" | "linked-electron";
type SyncRow = Readonly<{
  base?: unknown;
  queued?: unknown;
  inFlight?: unknown;
  lastRecovery?: unknown;
}> | undefined;

type LifecycleDependencies = Readonly<{
  database: ProxxiedDexie;
  createScope: typeof createMpcCalibrationOperationScope;
  admit: typeof runMpcCalibrationInitialAdmissionWithIdentity;
  selectTransport: typeof selectMpcCalibrationTransport;
  createQueueController: typeof createMpcCalibrationQueueRecoveryController;
  createRefreshScheduler: typeof createMpcCalibrationRefreshScheduler;
  disable: typeof disableMpcCalibrationLink;
}>;

const defaultDependencies: LifecycleDependencies = {
  database: db,
  createScope: createMpcCalibrationOperationScope,
  admit: runMpcCalibrationInitialAdmissionWithIdentity,
  selectTransport: selectMpcCalibrationTransport,
  createQueueController: createMpcCalibrationQueueRecoveryController,
  createRefreshScheduler: createMpcCalibrationRefreshScheduler,
  disable: disableMpcCalibrationLink,
};

export type MpcCalibrationSyncLifecycleProps = Readonly<{
  /** Narrow test seam; production uses only the fixed app-owned dependencies. */
  dependencies?: LifecycleDependencies;
}>;

function statusFromDurableState(
  state: SyncRow,
  outcome: MpcCalibrationSyncStatus | undefined,
): MpcCalibrationSyncStatus {
  // A real terminal C5/C3 status must remain visible even while C1 preserves
  // the conflicting queue. Pending durable work only outranks optimistic clean.
  if (outcome !== undefined && outcome !== "clean") return outcome;
  if (state?.inFlight !== null && state?.inFlight !== undefined) return "in-flight";
  if (state?.queued !== null && state?.queued !== undefined) return "queued";
  if (outcome !== undefined) return outcome;
  // lastRecovery is a validated C5 settlement proof, not an unpaired sentinel.
  if (state?.base !== null && state?.base !== undefined) return "clean";
  if (state?.lastRecovery !== null && state?.lastRecovery !== undefined) return "clean";
  return "paired-not-hydrated";
}

function schedulerStatus(status: MpcCalibrationRefreshSchedulerStatus): MpcCalibrationSyncStatus | undefined {
  switch (status.kind) {
    case "hydrated":
    case "no-newer":
      return "clean";
    case "retrying":
      return "offline";
    case "needs-reconciliation":
      return "conflict";
    case "blocked":
      return "blocked";
    case "unavailable":
      return "failed";
    default:
      return undefined;
  }
}

function admittedStatus(result: MpcCalibrationInitialAdmissionWithIdentityResult): MpcCalibrationSyncStatus | undefined {
  switch (result.kind) {
    case "hydrated":
    case "no-remote":
      return "clean";
    case "needs-reconciliation":
      return "conflict";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

function admitsConnection(
  result: MpcCalibrationInitialAdmissionWithIdentityResult,
  identity: Readonly<CalibrationHarnessPersistenceIdentity> | undefined,
  target: LinkedTarget,
): result is Extract<MpcCalibrationInitialAdmissionWithIdentityResult, { kind: "hydrated" | "no-remote" }> & { identity: Readonly<CalibrationHarnessPersistenceIdentity> } {
  return (result.kind === "hydrated" || result.kind === "no-remote") &&
    result.target === target &&
    identity !== undefined &&
    "identity" in result;
}

function sameIdentity(
  left: Readonly<CalibrationHarnessPersistenceIdentity>,
  right: Readonly<CalibrationHarnessPersistenceIdentity>,
): boolean {
  return left.ownerId === right.ownerId && left.harnessId === right.harnessId && left.connectionId === right.connectionId;
}

async function hasBoundQueuedRecovery(
  database: ProxxiedDexie,
  identity: Readonly<CalibrationHarnessPersistenceIdentity>,
): Promise<boolean> {
  try {
    const state = await createMpcCalibrationSyncStateStore(database).load(identity);
    const binding = await database.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding");
    return state !== undefined && state.base !== null && state.queued !== null &&
      binding !== undefined &&
      binding.ownerId === identity.ownerId && binding.harnessId === identity.harnessId && binding.connectionId === identity.connectionId &&
      binding.revision === state.base.revision;
  } catch {
    // Malformed, foreign, or inaccessible durable rows are not queue admission.
    return false;
  }
}

function queuedRecoveryStatus(result: MpcCalibrationQueuedRecoveryResult): MpcCalibrationSyncStatus | undefined {
  if (result.kind === "rejected") return "failed";
  if (result.kind !== "recovery") return undefined;
  switch (result.status) {
    case "published":
      return "clean";
    case "conflict":
      return "conflict";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

/**
 * The single app/connection owner for linked calibration sync. Modal visibility
 * is intentionally not an input: closing a modal may cancel UI work but never
 * disposes this connection's queue, scheduler, or durable C1 state.
 */
export function MpcCalibrationSyncLifecycle({
  dependencies = defaultDependencies,
}: MpcCalibrationSyncLifecycleProps) {
  const selection = useMpcCalibrationSyncStore((state) => state.selection);
  const selectionRevision = useMpcCalibrationSyncStore((state) => state.selectionRevision);

  useEffect(() => {
    let disposed = false;
    const selectedTarget = selection.kind === "linked" ? selection.target : undefined;
    const selectionIsCurrent = () => {
      const current = useMpcCalibrationSyncStore.getState();
      return current.selectionRevision === selectionRevision &&
        (selectedTarget === undefined
          ? current.selection.kind === selection.kind
          : current.selection.kind === "linked" && current.selection.target === selectedTarget);
    };
    let preAuthenticationScope: MpcCalibrationOperationScope | undefined;
    let connectionScope: MpcCalibrationOperationScope | undefined;
    let queueController: MpcCalibrationQueueRecoveryController | undefined;
    let refreshScheduler: MpcCalibrationRefreshScheduler | undefined;
    let unsubscribe: (() => void) | undefined;
    let connectionControl: ReturnType<typeof useMpcCalibrationSyncStore.getState>["connectionControl"];
    let latestRow: SyncRow;
    let terminalOutcome: MpcCalibrationSyncStatus | undefined;

    const publish = () => {
      if (!disposed && selectionIsCurrent()) {
        useMpcCalibrationSyncStore.getState().publishStatus(
          statusFromDurableState(latestRow, terminalOutcome),
        );
      }
    };
    const teardown = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      queueController?.dispose();
      queueController = undefined;
      refreshScheduler?.dispose();
      refreshScheduler = undefined;
      if (connectionControl !== undefined
        && useMpcCalibrationSyncStore.getState().connectionControl === connectionControl) {
        useMpcCalibrationSyncStore.getState().registerConnectionControl(undefined);
      }
      connectionControl = undefined;
      connectionScope?.dispose();
      connectionScope = undefined;
      preAuthenticationScope?.dispose();
      preAuthenticationScope = undefined;
    };

    if (selection.kind !== "linked") {
      if (selectionIsCurrent()) useMpcCalibrationSyncStore.getState().publishStatus("unpaired");
      return () => {
        disposed = true;
        teardown();
      };
    }

    const target: LinkedTarget = selection.target;
    if (selectionIsCurrent()) useMpcCalibrationSyncStore.getState().publishStatus("authenticating");
    // This short pre-authentication scope has no persistence identity. The one
    // connection scope below starts only after the authenticated handoff.
    preAuthenticationScope = dependencies.createScope({ target, identity: null, connection: selection });
    const admissionOperation = preAuthenticationScope.captureAppOperation();
    let handedOffIdentity: Readonly<CalibrationHarnessPersistenceIdentity> | undefined;

    void dependencies.admit({
      database: dependencies.database,
      target,
      operation: admissionOperation,
      onAuthenticated(identity) {
        if (disposed || !selectionIsCurrent() || !admissionOperation.isCurrent()) return;
        handedOffIdentity = identity;
        if (selectionIsCurrent()) useMpcCalibrationSyncStore.getState().publishStatus("paired-not-hydrated");
      },
    }).then(async (result) => {
      if (disposed || !selectionIsCurrent() || !admissionOperation.isCurrent()) return;
      const initial = admittedStatus(result);
      const identity = handedOffIdentity;
      const resultIdentity = "identity" in result ? result.identity : undefined;
      const ordinaryAdmission = admitsConnection(result, identity, target) &&
        resultIdentity !== undefined && identity !== undefined && sameIdentity(identity, resultIdentity);
      const queuedAdmission = !ordinaryAdmission &&
        (result.kind === "blocked" || result.kind === "needs-reconciliation") &&
        result.target === target && identity !== undefined && resultIdentity !== undefined &&
        sameIdentity(identity, resultIdentity) &&
        await hasBoundQueuedRecovery(dependencies.database, identity);
      if (disposed || !selectionIsCurrent() || !admissionOperation.isCurrent()) return;
      if (!ordinaryAdmission && !queuedAdmission || identity === undefined) {
        if (initial !== undefined && selectionIsCurrent()) useMpcCalibrationSyncStore.getState().publishStatus(initial);
        return;
      }

      // Admission has fully settled before the identity-bound owner exists, so
      // adopting the identity cannot cancel or stale-publish that admission.
      connectionScope = dependencies.createScope({
        target,
        identity,
        connection: selection,
        authentication: identity,
      });
      const queueOperation = connectionScope.captureAppOperation();
      const ownedConnectionScope = connectionScope;
      connectionControl = Object.freeze({
        target,
        disable: async () => {
          const result = await dependencies.disable({
            target,
            scope: ownedConnectionScope,
            identity,
            database: dependencies.database,
          });
          if (disposed || !selectionIsCurrent()) return result;
          if (result.kind === "disabled") {
            useMpcCalibrationSyncStore.getState().selectLocal();
          } else if (result.kind === "rejected") {
            useMpcCalibrationSyncStore.getState().publishStatus(
              result.status === "offline" ? "offline" : "failed",
            );
          }
          return result;
        },
      });
      if (selectionIsCurrent()) {
        useMpcCalibrationSyncStore.getState().registerConnectionControl(connectionControl);
      }
      let transport;
      try {
        transport = dependencies.selectTransport({ target });
      } catch {
        terminalOutcome = "failed";
        publish();
        return;
      }
      if (disposed || !selectionIsCurrent() || !queueOperation.isCurrent()) return;

      unsubscribe = liveQuery(async () => dependencies.database.mpcCalibrationSyncStates.get([
        identity.ownerId,
        identity.harnessId,
        identity.connectionId,
      ])).subscribe({
        next(row) {
          if (disposed || !selectionIsCurrent() || !queueOperation.isCurrent()) return;
          latestRow = row;
          publish();
        },
        error() {
          if (disposed || !selectionIsCurrent() || !queueOperation.isCurrent()) return;
          terminalOutcome = "blocked";
          publish();
        },
      }).unsubscribe;

      queueController = dependencies.createQueueController({
        database: dependencies.database,
        operation: queueOperation,
        transport,
        onFailure() {
          if (disposed || !selectionIsCurrent() || !queueOperation.isCurrent()) return;
          terminalOutcome = "failed";
          publish();
        },
        onResult(result) {
          if (disposed || !selectionIsCurrent() || !queueOperation.isCurrent()) return;
          const next = queuedRecoveryStatus(result);
          if (next !== undefined) terminalOutcome = next;
          publish();
        },
      });
      refreshScheduler = dependencies.createRefreshScheduler({
        database: dependencies.database,
        operationScope: connectionScope,
        target,
        onStatus(status) {
          if (disposed || !selectionIsCurrent() || !queueOperation.isCurrent()) return;
          const next = schedulerStatus(status);
          if (next !== undefined) terminalOutcome = next;
          publish();
        },
      });
      terminalOutcome = queuedAdmission ? undefined : initial;
      publish();
      await refreshScheduler.start();
    }).catch(() => {
      if (disposed || !selectionIsCurrent() || !admissionOperation.isCurrent()) return;
      useMpcCalibrationSyncStore.getState().publishStatus("failed");
    });

    return () => {
      disposed = true;
      teardown();
    };
  }, [dependencies, selection, selectionRevision]);

  return <span data-testid="mpc-calibration-sync-lifecycle" hidden />;
}
