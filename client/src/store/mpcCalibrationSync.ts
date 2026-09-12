import { create } from "zustand";
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

export type MpcCalibrationSyncStore = Readonly<{
  selection: MpcCalibrationSyncSelection;
  /** Monotonic user-selection snapshot used to fence late lifecycle callbacks. */
  selectionRevision: number;
  status: MpcCalibrationSyncStatus;
  selectLocal: () => void;
  selectLinked: (target: MpcCalibrationLinkedTarget) => void;
  clearSelection: () => void;
  /** App lifecycle output only: a closed, non-secret presentation value. */
  publishStatus: (status: MpcCalibrationSyncStatus) => void;
}>;

const unselected: MpcCalibrationSyncSelection = Object.freeze({ kind: "unselected" });

export const useMpcCalibrationSyncStore = create<MpcCalibrationSyncStore>(
  (set) => ({
    selection: unselected,
    selectionRevision: 0,
    status: "unpaired",
    selectLocal: () => set(state => ({ selection: { kind: "local" }, selectionRevision: state.selectionRevision + 1, status: "unpaired" })),
    selectLinked: (target) => {
      if (target !== "linked-web" && target !== "linked-electron") return;
      set(state => ({ selection: { kind: "linked", target }, selectionRevision: state.selectionRevision + 1, status: "authenticating" }));
    },
    clearSelection: () => set(state => ({ selection: unselected, selectionRevision: state.selectionRevision + 1, status: "unpaired" })),
    publishStatus: (status) => set({ status }),
  })
);
