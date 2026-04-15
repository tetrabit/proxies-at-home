import { create } from "zustand";
import type { CardOption } from "../../../shared/types";

type MpcUpgradeModalData = {
  cardUuid: string;
  card: CardOption;
};

export type MpcUpgradeModalStore = {
  open: boolean;
  cardUuid: string | null;
  card: CardOption | null;
  openModal: (data: MpcUpgradeModalData) => void;
  closeModal: () => void;
};

export const useMpcUpgradeModalStore = create<MpcUpgradeModalStore>((set) => ({
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
}));
