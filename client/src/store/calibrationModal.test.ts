import { describe, expect, it } from "vitest";
import { useCalibrationModalStore } from "./calibrationModal";

describe("useCalibrationModalStore", () => {
  it("opens and closes the modal", () => {
    useCalibrationModalStore.getState().closeModal();
    const card = { uuid: "1", name: "Test", order: 0, isUserUpload: false } as never;

    useCalibrationModalStore.getState().openModal({ cardUuid: "card-1", card });
    expect(useCalibrationModalStore.getState().open).toBe(true);
    expect(useCalibrationModalStore.getState().cardUuid).toBe("card-1");

    useCalibrationModalStore.getState().closeModal();
    expect(useCalibrationModalStore.getState().open).toBe(false);
    expect(useCalibrationModalStore.getState().card).toBeNull();
  });
});
