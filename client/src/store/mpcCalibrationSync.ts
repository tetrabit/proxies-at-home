import { create } from "zustand";
import type { MpcCalibrationDisableResult } from "@/helpers/mpcCalibrationDisable";
import type { MpcCalibrationTransportTarget } from "@/helpers/mpcCalibrationTransportSelection";

export type MpcCalibrationLinkedTarget = Exclude<
  MpcCalibrationTransportTarget,
  "local"
>;

/**
 * This is an explicit, non-secret user/application choice. It deliberately
 * starts unselected and never reads runtime bridge, configuration, profile, or
 * credential state to infer a linked connection.
 */
export type MpcCalibrationSyncSelection =
  | Readonly<{ kind: "unselected" }>
  | Readonly<{ kind: "local" }>
  | Readonly<{ kind: "linked"; target: MpcCalibrationLinkedTarget }>;

export type MpcCalibrationSyncStatus =
  | "unpaired"
  | "authenticating"
  | "paired-not-hydrated"
  | "clean"
  | "queued"
  | "in-flight"
  | "conflict"
  | "offline"
  | "blocked"
  | "failed";

/**
 * Closed, non-secret reason codes that explain a terminal sync status in the
 * UI. They are produced by the admission, scheduler, and queue-recovery layers
 * and mapped here to human-readable text so a blocked/conflict state is
 * diagnosable without opening devtools.
 */
const STATUS_REASON_TEXT: Readonly<Record<string, string>> = {
  "foreign-physical-binding": "The local calibration cache is bound to a different owner or service than the current connection.",
  "identity-changed": "The service identity changed since this cache was last connected.",
  "invalid-identity": "The cached service identity is invalid.",
  "session-identity-mismatch": "The service session does not match the cached connection identity.",
  "corrupt-sync-state": "The local sync record is corrupt.",
  "physical-cache-bound-to-different-identity": "The local cache is bound to a different connection identity.",
  "remote-revision-not-newer": "The remote snapshot is not newer than the local sync base.",
  "session-identity-replaced": "The service session was replaced during synchronization.",
  "unbased-local-sync-state-is-not-clean": "The local sync record has unsent changes without a recorded base.",
  "unbased-or-dirty-local-harness": "The local calibration data has diverged from its recorded sync base.",
  "unbound-physical-cache": "Local calibration data exists but is not bound to a connection.",
  "missing-identity-or-database": "The connection identity or local database is unavailable.",
  "transport-unavailable": "The calibration transport could not be established.",
  "service-unavailable": "The calibration service is not reachable.",
  "retries-exhausted": "Repeated connection attempts timed out.",
  "stale-local-base": "The local sync base no longer matches the stored cache binding.",
  "remote-diverged": "The remote snapshot diverged from the local sync base.",
  "sync-state-unreadable": "The local sync record could not be read.",
  "refresh-failed": "The background refresh failed.",
  "remote-base-regressed-or-diverged": "The remote snapshot no longer matches the local sync base.",
  "precondition-failed": "The service rejected the publish because its stored revision changed first.",
  "empty-snapshot-requires-reconciliation": "The remote snapshot is empty and cannot be applied over local data.",
  "missing-recorded-base": "The recorded local sync base is missing.",
  "unresolved-inflight": "A previous publish is still in flight and could not be settled.",
  "transport-failure": "The calibration service request failed.",
  "recovery-cycle-budget-exhausted": "Recovery used its retry budget without settling.",
  "remote-missing-after-base": "The remote snapshot could no longer be loaded.",
  "unspecified": "No further details are available.",
};

/** Human-readable text for a status reason code; unknown codes fall back to the raw code. */
export function mpcCalibrationStatusReasonText(reason: string | undefined): string | undefined {
  if (reason === undefined || reason === "") return undefined;
  return STATUS_REASON_TEXT[reason] ?? reason;
}

/** App-owned command registration has no credential or configurable transport input. */
export type MpcCalibrationConnectionControl = Readonly<{
  target: MpcCalibrationLinkedTarget;
  disable: () => Promise<MpcCalibrationDisableResult>;
}>;

export type MpcCalibrationSyncStore = Readonly<{
  selection: MpcCalibrationSyncSelection;
  /** Monotonic user-selection snapshot used to fence late lifecycle callbacks. */
  selectionRevision: number;
  status: MpcCalibrationSyncStatus;
  /** Closed, non-secret reason code for the current terminal status, when one exists. */
  statusReason?: string;
  connectionControl?: MpcCalibrationConnectionControl;
  selectLocal: () => void;
  selectLinked: (target: MpcCalibrationLinkedTarget) => void;
  clearSelection: () => void;
  /** Registers only the current lifecycle's finite, non-secret disable command. */
  registerConnectionControl: (control: MpcCalibrationConnectionControl | undefined) => void;
  /** Invokes the registered app lifecycle command only for the still-selected target. */
  disableCurrentConnection: () => Promise<MpcCalibrationDisableResult | undefined>;
  /** App lifecycle output only: a closed, non-secret presentation value plus an optional reason code. */
  publishStatus: (status: MpcCalibrationSyncStatus, reason?: string) => void;
}>;

const unselected: MpcCalibrationSyncSelection = Object.freeze({ kind: "unselected" });

export const useMpcCalibrationSyncStore = create<MpcCalibrationSyncStore>(
  (set, get) => ({
    selection: unselected,
    selectionRevision: 0,
    status: "unpaired",
    statusReason: undefined,
    connectionControl: undefined,
    selectLocal: () => set(state => ({ selection: { kind: "local" }, selectionRevision: state.selectionRevision + 1, status: "unpaired", statusReason: undefined, connectionControl: undefined })),
    selectLinked: (target) => {
      if (target !== "linked-web" && target !== "linked-electron") return;
      set(state => ({ selection: { kind: "linked", target }, selectionRevision: state.selectionRevision + 1, status: "authenticating", statusReason: undefined, connectionControl: undefined }));
    },
    clearSelection: () => set(state => ({ selection: unselected, selectionRevision: state.selectionRevision + 1, status: "unpaired", statusReason: undefined, connectionControl: undefined })),
    registerConnectionControl: (connectionControl) => set({ connectionControl }),
    disableCurrentConnection: async () => {
      const { selection, connectionControl } = get();
      if (selection.kind !== "linked" || connectionControl === undefined || connectionControl.target !== selection.target) return undefined;
      return connectionControl.disable();
    },
    publishStatus: (status, reason) => set({ status, statusReason: reason }),
  })
);
