import { create } from "zustand";
import type { CardOption } from "../../../shared/types";

type CalibrationModalData = {
  cardUuid: string;
  card: CardOption;
};

export type CalibrationModalStore = {
  open: boolean;
  cardUuid: string | null;
  card: CardOption | null;
  openModal: (data: CalibrationModalData) => void;
  closeModal: () => void;
};

export const useCalibrationModalStore = create<CalibrationModalStore>(
  (set) => ({
    open: false,
    cardUuid: null,
    card: null,
    openModal: (data) =>
      set({
        open: true,
        cardUuid: data.cardUuid,
        card: data.card,
      }),
    closeModal: () =>
      set({
        open: false,
        cardUuid: null,
        card: null,
      }),
  })
);
