import type { CardOption } from "../../../shared/types";
import { getHasBuiltInBleed, type BleedMetadataImage } from "./imageSpecs";

export const baseCardWidthMm = 63;
export const baseCardHeightMm = 88;

export type CardLayoutInfo = {
    cardWidthMm: number;
    cardHeightMm: number;
    bleedMm: number;
};

export type SourceTypeSettings = {
    withBleedTargetMode: 'global' | 'manual' | 'none';
    withBleedTargetAmount: number;
    noBleedTargetMode: 'global' | 'manual' | 'none';
    noBleedTargetAmount: number;
};

/**
 * Manual generate overrides on cardbacks are rendered as an inset black border:
 * the page/card slot keeps the global layout bleed and the original art is
 * shrunk inward by the override amount. Regular cards still grow/shrink to
 * their target bleed.
 */
export function usesCardbackInsetBorderBleed(
    card: Pick<CardOption, 'imageId' | 'bleedMode' | 'generateBleedMm'>,
): boolean {
    return !!(
        card.imageId?.startsWith('cardback_') &&
        card.bleedMode === 'generate' &&
        card.generateBleedMm !== undefined
    );
}

/** Compute per-card bleed width based on overrides, settings, and global defaults. */
export function getCardTargetBleed(
    card: CardOption,
    sourceSettings: SourceTypeSettings,
    globalBleedWidth: number,
    image?: BleedMetadataImage,
): number {
    // 1. Card-Specific Override
    if (card.bleedMode) {
        if (card.bleedMode === 'none') return 0;
        if (card.bleedMode === 'generate') {
            return card.generateBleedMm ?? globalBleedWidth;
        }
        // Legacy 'existing' mode support (treat as manual override if amount exists)
        if (card.bleedMode === 'existing' && card.existingBleedMm !== undefined) {
            return card.existingBleedMm;
        }
    }

    // 2. Type Settings (Global Defaults)
    if (getHasBuiltInBleed(card, image)) {
        switch (sourceSettings.withBleedTargetMode) {
            case 'none': return 0;
            case 'manual': return sourceSettings.withBleedTargetAmount;
            case 'global': return globalBleedWidth;
            default: return globalBleedWidth;
        }
    } else {
        // Standard cards (no built-in bleed)
        switch (sourceSettings.noBleedTargetMode) {
            case 'none': return 0;
            case 'manual': return sourceSettings.noBleedTargetAmount;
            case 'global': return globalBleedWidth;
            default: return globalBleedWidth;
        }
    }
}

/**
 * Physical layout bleed for page/grid placement.
 *
 * Cardback inset-border overrides use the global bleed as their outer card
 * dimensions so the override does not make the card larger on the page.
 */
export function getCardLayoutBleed(
    card: CardOption,
    sourceSettings: SourceTypeSettings,
    globalBleedWidth: number,
    image?: BleedMetadataImage,
): number {
    if (usesCardbackInsetBorderBleed(card)) {
        return globalBleedWidth;
    }

    return getCardTargetBleed(card, sourceSettings, globalBleedWidth, image);
}

/**
 * Inner black-border inset amount for manual cardback target overrides.
 * Undefined means the card should use the regular generated/existing bleed path.
 */
export function getCardInsetBorderBleed(
    card: CardOption,
    sourceSettings: SourceTypeSettings,
    globalBleedWidth: number,
    image?: BleedMetadataImage,
): number | undefined {
    if (!usesCardbackInsetBorderBleed(card)) {
        return undefined;
    }

    return getCardTargetBleed(card, sourceSettings, globalBleedWidth, image);
}

export function computeCardLayouts(
    pageCards: CardOption[],
    sourceSettings: SourceTypeSettings,
    globalBleedWidth: number,
): CardLayoutInfo[] {
    return pageCards.map((card) => {
        const bleedMm = getCardLayoutBleed(card, sourceSettings, globalBleedWidth);
        return {
            cardWidthMm: baseCardWidthMm + bleedMm * 2,
            cardHeightMm: baseCardHeightMm + bleedMm * 2,
            bleedMm,
        };
    });
}

/**
 * Compute a uniform guide/layout box for export.
 *
 * Export guide positions stay anchored to the global bleed box even when
 * individual cards render with different bleed widths. The PDF worker handles
 * those differences during image composition instead of moving the cutline grid.
 */
export function computeGuideLayouts(
    pageCards: CardOption[],
    guideBleedWidth: number,
): CardLayoutInfo[] {
    return pageCards.map(() => ({
        cardWidthMm: baseCardWidthMm + guideBleedWidth * 2,
        cardHeightMm: baseCardHeightMm + guideBleedWidth * 2,
        bleedMm: guideBleedWidth,
    }));
}

export type GridDimensions = {
    colWidthsMm: number[];
    rowHeightsMm: number[];
    totalGridWidthMm: number;
    totalGridHeightMm: number;
};

export function computeGridDimensions(
    layouts: CardLayoutInfo[],
    columns: number,
    rows: number,
    cardSpacingMm: number = 0
): GridDimensions {
    // Initialize with base dimensions (no bleed) to allow growing only as needed
    // This matches PageView behavior: empty slots or small cards don't force global bleed size
    const startWidth = baseCardWidthMm;
    const startHeight = baseCardHeightMm;

    // Compute max width per column
    const colWidthsMm: number[] = Array(columns).fill(startWidth);
    layouts.forEach((layout, idx) => {
        const col = idx % columns;
        colWidthsMm[col] = Math.max(colWidthsMm[col], layout.cardWidthMm);
    });

    // Compute max height per row
    const rowHeightsMm: number[] = Array(rows).fill(startHeight);
    layouts.forEach((layout, idx) => {
        const row = Math.floor(idx / columns);
        // Ensure we don't go out of bounds if layouts has more items than rows * columns (shouldn't happen per page, but safe to check)
        if (row < rows) {
            rowHeightsMm[row] = Math.max(rowHeightsMm[row], layout.cardHeightMm);
        }
    });

    const totalGridWidthMm = colWidthsMm.reduce((sum, w) => sum + w, 0) + Math.max(0, columns - 1) * cardSpacingMm;
    const totalGridHeightMm = rowHeightsMm.reduce((sum, h) => sum + h, 0) + Math.max(0, rows - 1) * cardSpacingMm;

    return { colWidthsMm, rowHeightsMm, totalGridWidthMm, totalGridHeightMm };
}

export function chunkCards<T>(cards: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < cards.length; i += size) {
        chunks.push(cards.slice(i, i + size));
    }
    return chunks;
}
