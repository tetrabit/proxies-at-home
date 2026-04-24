import { describe, expect, it } from "vitest";
import type { CardOption } from "../../../shared/types";
import { applyInheritedCardbackTargetBleed, normalizeSharedCardbackTargetBleed } from "./backBleedSettings";

const frontCard = (overrides: Partial<CardOption> = {}): CardOption => ({
    uuid: "front-1",
    name: "Front",
    order: 0,
    imageId: "front-image",
    isUserUpload: false,
    ...overrides,
});

const backCard = (overrides: Partial<CardOption> = {}): CardOption => ({
    uuid: "back-1",
    name: "Back",
    order: 0,
    imageId: "cardback_uploaded_1",
    isUserUpload: true,
    linkedFrontId: "front-1",
    ...overrides,
});

describe("applyInheritedCardbackTargetBleed", () => {
    it("inherits a manual generated target from generic cardback fronts without a back override", () => {
        const result = applyInheritedCardbackTargetBleed(
            frontCard({ bleedMode: "generate", generateBleedMm: 1 }),
            backCard({ hasBuiltInBleed: true, existingBleedMm: 3.175 })
        );

        expect(result).toMatchObject({
            bleedMode: "generate",
            generateBleedMm: 1,
            hasBuiltInBleed: true,
            existingBleedMm: 3.175,
        });
    });

    it("inherits a no-bleed target from generic cardback fronts without a back override", () => {
        const result = applyInheritedCardbackTargetBleed(
            frontCard({ bleedMode: "none", generateBleedMm: 1 }),
            backCard()
        );

        expect(result).toMatchObject({
            bleedMode: "none",
            generateBleedMm: undefined,
        });
    });

    it("inherits legacy generate-only target overrides from generic cardback fronts", () => {
        const result = applyInheritedCardbackTargetBleed(
            frontCard({ generateBleedMm: 1 }),
            backCard()
        );

        expect(result).toMatchObject({
            bleedMode: "generate",
            generateBleedMm: 1,
        });
    });

    it("preserves explicit generic cardback target overrides", () => {
        const originalBack = backCard({ bleedMode: "generate", generateBleedMm: 2 });
        const result = applyInheritedCardbackTargetBleed(
            frontCard({ bleedMode: "none" }),
            originalBack
        );

        expect(result).toBe(originalBack);
        expect(result).toMatchObject({
            bleedMode: "generate",
            generateBleedMm: 2,
        });
    });

    it("does not inherit target settings for non-cardback linked backs", () => {
        const originalBack = backCard({ imageId: "custom-dfc-image" });
        const result = applyInheritedCardbackTargetBleed(
            frontCard({ bleedMode: "generate", generateBleedMm: 1 }),
            originalBack
        );

        expect(result).toBe(originalBack);
    });

    it("does not copy legacy existing-bleed mode as a target setting", () => {
        const originalBack = backCard();
        const result = applyInheritedCardbackTargetBleed(
            frontCard({ bleedMode: "existing", generateBleedMm: 1 }),
            originalBack
        );

        expect(result).toBe(originalBack);
    });
});

describe("normalizeSharedCardbackTargetBleed", () => {
    it("removes a one-off inherited target when most shared cardbacks use defaults", () => {
        const cards = [
            backCard({ uuid: "back-1", bleedMode: "generate", generateBleedMm: 4 }),
            backCard({ uuid: "back-2" }),
            backCard({ uuid: "back-3" }),
        ];

        const result = normalizeSharedCardbackTargetBleed(cards);

        expect(result[0]).toMatchObject({
            uuid: "back-1",
            bleedMode: undefined,
            generateBleedMm: undefined,
        });
        expect(result[1]).toBe(cards[1]);
        expect(result[2]).toBe(cards[2]);
    });

    it("applies the majority explicit target to shared cardbacks missing it", () => {
        const cards = [
            backCard({ uuid: "back-1", bleedMode: "generate", generateBleedMm: 2 }),
            backCard({ uuid: "back-2", bleedMode: "generate", generateBleedMm: 2 }),
            backCard({ uuid: "back-3" }),
        ];

        const result = normalizeSharedCardbackTargetBleed(cards);

        expect(result[2]).toMatchObject({
            uuid: "back-3",
            bleedMode: "generate",
            generateBleedMm: 2,
        });
    });

    it("does not normalize different cardback images together", () => {
        const cards = [
            backCard({ uuid: "back-1", imageId: "cardback_a", bleedMode: "generate", generateBleedMm: 4 }),
            backCard({ uuid: "back-2", imageId: "cardback_b" }),
        ];

        const result = normalizeSharedCardbackTargetBleed(cards);

        expect(result).toBe(cards);
    });

    it("does not normalize non-cardback linked backs", () => {
        const cards = [
            backCard({ uuid: "back-1", imageId: "custom-dfc-image", bleedMode: "generate", generateBleedMm: 4 }),
            backCard({ uuid: "back-2", imageId: "custom-dfc-image" }),
        ];

        const result = normalizeSharedCardbackTargetBleed(cards);

        expect(result).toBe(cards);
    });
});
