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

// Task-28 residual coverage for remaining target key variants.
describe("normalizeSharedCardbackTargetBleed residual target variants", () => {
    it("normalizes shared cardbacks to explicit existing bleed targets", () => {
        const cards = [
            backCard({ uuid: "back-1", bleedMode: "existing", existingBleedMm: 3.175 }),
            backCard({ uuid: "back-2", bleedMode: "existing", existingBleedMm: 3.175 }),
            backCard({ uuid: "back-3", bleedMode: "generate", generateBleedMm: 2 }),
        ];

        const result = normalizeSharedCardbackTargetBleed(cards);

        expect(result[2]).toMatchObject({
            uuid: "back-3",
            bleedMode: "existing",
            existingBleedMm: 3.175,
            generateBleedMm: undefined,
        });
    });

    it("normalizes shared cardbacks to global existing bleed targets", () => {
        const cards = [
            backCard({ uuid: "back-1", bleedMode: "existing", existingBleedMm: undefined }),
            backCard({ uuid: "back-2", bleedMode: "existing", existingBleedMm: undefined }),
            backCard({ uuid: "back-3", bleedMode: "none" }),
        ];

        const result = normalizeSharedCardbackTargetBleed(cards);

        expect(result[2]).toMatchObject({
            uuid: "back-3",
            bleedMode: "existing",
            generateBleedMm: undefined,
        });
    });

    it("uses first occurrence as tie breaker and ignores blank builtin cardbacks", () => {
        const cards = [
            backCard({ uuid: "back-1", bleedMode: "none" }),
            backCard({ uuid: "back-2", bleedMode: "generate", generateBleedMm: 2 }),
            backCard({ uuid: "back-3", imageId: "cardback_builtin_blank", bleedMode: "generate", generateBleedMm: 9 }),
        ];

        const result = normalizeSharedCardbackTargetBleed(cards);

        expect(result[1]).toMatchObject({
            uuid: "back-2",
            bleedMode: "none",
            generateBleedMm: undefined,
        });
        expect(result[2]).toBe(cards[2]);
    });
});


// Task-44 global helper residual coverage for remaining normalization keys.
describe("normalizeSharedCardbackTargetBleed global residual variants", () => {
    it("normalizes legacy generate-only targets and generate-global targets", () => {
        const legacyCards = [
            backCard({ uuid: "back-1", generateBleedMm: 5 }),
            backCard({ uuid: "back-2", generateBleedMm: 5 }),
            backCard({ uuid: "back-3", bleedMode: "none" }),
        ];

        const legacyResult = normalizeSharedCardbackTargetBleed(legacyCards);
        expect(legacyResult[2]).toMatchObject({
            bleedMode: "generate",
            generateBleedMm: 5,
        });

        const globalCards = [
            backCard({ uuid: "global-1", bleedMode: "generate", generateBleedMm: undefined }),
            backCard({ uuid: "global-2", bleedMode: "generate", generateBleedMm: undefined }),
            backCard({ uuid: "global-3", bleedMode: "existing", existingBleedMm: 3.175 }),
        ];

        const globalResult = normalizeSharedCardbackTargetBleed(globalCards);
        expect(globalResult[2]).toMatchObject({
            bleedMode: "generate",
            generateBleedMm: undefined,
        });
    });

    it("normalizes multiple shared groups after the result has already been copied", () => {
        const cards = [
            backCard({ uuid: "a-1", imageId: "cardback_a", bleedMode: "none" }),
            backCard({ uuid: "a-2", imageId: "cardback_a", bleedMode: "generate", generateBleedMm: 2 }),
            backCard({ uuid: "b-1", imageId: "cardback_b", bleedMode: "existing", existingBleedMm: 1 }),
            backCard({ uuid: "b-2", imageId: "cardback_b", bleedMode: "none" }),
        ];

        const result = normalizeSharedCardbackTargetBleed(cards);

        expect(result).not.toBe(cards);
        expect(result[1]).toMatchObject({ bleedMode: "none", generateBleedMm: undefined });
        expect(result[3]).toMatchObject({ bleedMode: "existing", existingBleedMm: 1, generateBleedMm: undefined });
    });

    it("leaves shared cardbacks unchanged when all target keys match", () => {
        const cards = [
            backCard({ uuid: "back-1", bleedMode: "none" }),
            backCard({ uuid: "back-2", bleedMode: "none" }),
        ];

        expect(normalizeSharedCardbackTargetBleed(cards)).toBe(cards);
    });
});
