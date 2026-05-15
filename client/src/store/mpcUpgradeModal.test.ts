import { describe, expect, it } from "vitest";
import { useMpcUpgradeModalStore } from "./mpcUpgradeModal";

describe("useMpcUpgradeModalStore", () => {
  it("opens and closes the modal", () => {
    useMpcUpgradeModalStore.getState().closeModal();
    const card = { uuid: "1", name: "Test", order: 0, isUserUpload: false } as never;

    useMpcUpgradeModalStore.getState().openModal({ cardUuid: "card-1", card });
    expect(useMpcUpgradeModalStore.getState().open).toBe(true);
    expect(useMpcUpgradeModalStore.getState().cardUuid).toBe("card-1");

    useMpcUpgradeModalStore.getState().closeModal();
    expect(useMpcUpgradeModalStore.getState().open).toBe(false);
    expect(useMpcUpgradeModalStore.getState().card).toBeNull();
  });
});
