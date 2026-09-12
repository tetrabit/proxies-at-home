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
  connectionControl?: MpcCalibrationConnectionControl;
  selectLocal: () => void;
  selectLinked: (target: MpcCalibrationLinkedTarget) => void;
  clearSelection: () => void;
  /** Registers only the current lifecycle's finite, non-secret disable command. */
  registerConnectionControl: (control: MpcCalibrationConnectionControl | undefined) => void;
  /** Invokes the registered app lifecycle command only for the still-selected target. */
  disableCurrentConnection: () => Promise<MpcCalibrationDisableResult | undefined>;
  /** App lifecycle output only: a closed, non-secret presentation value. */
  publishStatus: (status: MpcCalibrationSyncStatus) => void;
}>;

const unselected: MpcCalibrationSyncSelection = Object.freeze({ kind: "unselected" });

export const useMpcCalibrationSyncStore = create<MpcCalibrationSyncStore>(
  (set, get) => ({
    selection: unselected,
    selectionRevision: 0,
    status: "unpaired",
    connectionControl: undefined,
    selectLocal: () => set(state => ({ selection: { kind: "local" }, selectionRevision: state.selectionRevision + 1, status: "unpaired", connectionControl: undefined })),
    selectLinked: (target) => {
      if (target !== "linked-web" && target !== "linked-electron") return;
      set(state => ({ selection: { kind: "linked", target }, selectionRevision: state.selectionRevision + 1, status: "authenticating", connectionControl: undefined }));
    },
    clearSelection: () => set(state => ({ selection: unselected, selectionRevision: state.selectionRevision + 1, status: "unpaired", connectionControl: undefined })),
    registerConnectionControl: (connectionControl) => set({ connectionControl }),
    disableCurrentConnection: async () => {
      const { selection, connectionControl } = get();
      if (selection.kind !== "linked" || connectionControl === undefined || connectionControl.target !== selection.target) return undefined;
      return connectionControl.disable();
    },
    publishStatus: (status) => set({ status }),
  })
);
