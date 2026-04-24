import type { CardOption } from "../../../shared/types";
import { isCardbackId } from "./cardbackLibrary";

type TargetBleedSettings = Pick<CardOption, "bleedMode" | "generateBleedMm">;
type TargetBleedKey =
    | "default"
    | "none"
    | "generate:global"
    | `generate:${number}`
    | "existing:global"
    | `existing:${number}`;

function hasExplicitTargetBleedOverride(card: CardOption): boolean {
    return card.bleedMode !== undefined || card.generateBleedMm !== undefined;
}

function getInheritableTargetBleedSettings(frontCard: CardOption): TargetBleedSettings | undefined {
    if (frontCard.bleedMode === "none") {
        return {
            bleedMode: "none",
            generateBleedMm: undefined,
        };
    }

    if (
        frontCard.bleedMode === "generate" ||
        (frontCard.bleedMode === undefined && frontCard.generateBleedMm !== undefined)
    ) {
        return {
            bleedMode: "generate",
            generateBleedMm: frontCard.generateBleedMm,
        };
    }

    return undefined;
}

/**
 * Generic cardbacks often start without their own target override. In that case
 * they should follow the linked front's target bleed intent for print sizing,
 * while keeping source metadata such as built-in bleed tied to the back image.
 */
export function applyInheritedCardbackTargetBleed(frontCard: CardOption, backCard: CardOption): CardOption {
    if (!backCard.imageId || !isCardbackId(backCard.imageId)) {
        return backCard;
    }

    if (hasExplicitTargetBleedOverride(backCard)) {
        return backCard;
    }

    const inheritedTarget = getInheritableTargetBleedSettings(frontCard);
    if (!inheritedTarget) {
        return backCard;
    }

    return {
        ...backCard,
        ...inheritedTarget,
    };
}

function getTargetBleedKey(card: CardOption): TargetBleedKey {
    if (card.bleedMode === "none") {
        return "none";
    }

    if (card.bleedMode === "existing") {
        return card.existingBleedMm === undefined ? "existing:global" : `existing:${card.existingBleedMm}`;
    }

    if (card.bleedMode === "generate") {
        return card.generateBleedMm === undefined ? "generate:global" : `generate:${card.generateBleedMm}`;
    }

    if (card.generateBleedMm !== undefined) {
        return `generate:${card.generateBleedMm}`;
    }

    return "default";
}

function applyTargetBleedKey(card: CardOption, key: TargetBleedKey): CardOption {
    if (key === "default") {
        return {
            ...card,
            bleedMode: undefined,
            generateBleedMm: undefined,
        };
    }

    if (key === "none") {
        return {
            ...card,
            bleedMode: "none",
            generateBleedMm: undefined,
        };
    }

    if (key === "generate:global") {
        return {
            ...card,
            bleedMode: "generate",
            generateBleedMm: undefined,
        };
    }

    if (key.startsWith("generate:")) {
        return {
            ...card,
            bleedMode: "generate",
            generateBleedMm: Number(key.slice("generate:".length)),
        };
    }

    if (key === "existing:global") {
        return {
            ...card,
            bleedMode: "existing",
            generateBleedMm: undefined,
        };
    }

    return {
        ...card,
        bleedMode: "existing",
        existingBleedMm: Number(key.slice("existing:".length)),
        generateBleedMm: undefined,
    };
}

/**
 * Shared cardback images should render at one target size within an export.
 * Linked back cards can accidentally carry a one-off target from a front card;
 * resolving by image id prevents a single instance from becoming a different
 * size on the printed sheet.
 */
export function normalizeSharedCardbackTargetBleed(cards: CardOption[]): CardOption[] {
    const groups = new Map<string, Array<{ index: number; key: TargetBleedKey }>>();

    cards.forEach((card, index) => {
        if (!card.imageId || !isCardbackId(card.imageId) || card.imageId === "cardback_builtin_blank") {
            return;
        }

        const group = groups.get(card.imageId) ?? [];
        group.push({ index, key: getTargetBleedKey(card) });
        groups.set(card.imageId, group);
    });

    let normalized = cards;

    for (const group of groups.values()) {
        if (group.length < 2) {
            continue;
        }

        const counts = new Map<TargetBleedKey, { count: number; firstIndex: number }>();
        for (const item of group) {
            const existing = counts.get(item.key);
            if (existing) {
                existing.count += 1;
            } else {
                counts.set(item.key, { count: 1, firstIndex: item.index });
            }
        }

        if (counts.size < 2) {
            continue;
        }

        const canonicalKey = Array.from(counts.entries()).sort((a, b) => {
            const countDiff = b[1].count - a[1].count;
            return countDiff !== 0 ? countDiff : a[1].firstIndex - b[1].firstIndex;
        })[0][0];

        if (normalized === cards) {
            normalized = [...cards];
        }

        for (const item of group) {
            if (item.key !== canonicalKey) {
                normalized[item.index] = applyTargetBleedKey(normalized[item.index], canonicalKey);
            }
        }
    }

    return normalized;
}
