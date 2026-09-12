import { beforeEach, describe, expect, it } from "vitest";
import {
  useMpcCalibrationSyncStore,
  type MpcCalibrationSyncStatus,
} from "./mpcCalibrationSync";

const statuses: MpcCalibrationSyncStatus[] = [
  "unpaired",
  "authenticating",
  "paired-not-hydrated",
  "clean",
  "queued",
  "in-flight",
  "conflict",
  "offline",
  "blocked",
  "failed",
];

describe("useMpcCalibrationSyncStore", () => {
  beforeEach(() => {
    useMpcCalibrationSyncStore.getState().clearSelection();
  });

  it("starts unselected and unpaired without discovering a runtime connection", () => {
    const state = useMpcCalibrationSyncStore.getState();

    expect(state.selection).toEqual({ kind: "unselected" });
    expect(state.status).toBe("unpaired");
  });

  it("changes linked ownership only through an explicit non-secret selection", () => {
    useMpcCalibrationSyncStore.getState().selectLinked("linked-web");

    expect(useMpcCalibrationSyncStore.getState().selection).toEqual({
      kind: "linked",
      target: "linked-web",
    });
  });

  it("increments its selection snapshot on every explicit replacement", () => {
    const initial = (useMpcCalibrationSyncStore.getState() as { selectionRevision?: number }).selectionRevision;
    useMpcCalibrationSyncStore.getState().selectLinked("linked-web");
    const linked = (useMpcCalibrationSyncStore.getState() as { selectionRevision?: number }).selectionRevision;
    useMpcCalibrationSyncStore.getState().clearSelection();
    const cleared = (useMpcCalibrationSyncStore.getState() as { selectionRevision?: number }).selectionRevision;

    expect(initial).toBeTypeOf("number");
    expect(linked).toBe(initial! + 1);
    expect(cleared).toBe(linked! + 1);
  });

  it.each(statuses)("keeps the closed status %s", (status) => {
    useMpcCalibrationSyncStore.getState().publishStatus(status);
    expect(useMpcCalibrationSyncStore.getState().status).toBe(status);
  });
});
