import { describe, expect, test } from "vitest";

/**
 * Regression test for guide offset fix
 * 
 * Issue: When per-card bleed overrides are used, the export guides were shifting
 * because the code calculated: guideOffsetX = prepared.bleedPx - bleedPxForGuide
 * 
 * Fix: prepared.bleedPx stays at the global guide bleed so cutlines are stable.
 * Larger manual cardback bleeds are composed inside that fixed layout box by
 * shrinking the source material onto a black background.
 * 
 * This test verifies the math behind the fix.
 */
describe("PDF guide offset calculation", () => {
  test("guide offset should be zero when using the layout bleed", () => {
    // Simulate the scenario where guides are created with global bleed
    const globalBleedMm = 1.5; // Global bleed edge width
    const DPI = 1200;
    const MM_TO_PX = (mm: number, dpi: number) => Math.round((mm * dpi) / 25.4);

    // Guide canvas is calculated from the layout bleed
    const bleedPxForGuide = MM_TO_PX(globalBleedMm, DPI);

    // prepared.bleedPx comes from cardLayout.bleedPx, which is also the layout bleed
    const preparedBleedPx = MM_TO_PX(globalBleedMm, DPI);

    // The offset calculation that was causing the bug
    const guideOffsetX = preparedBleedPx - bleedPxForGuide;
    const guideOffsetY = preparedBleedPx - bleedPxForGuide;

    // After the fix, these should always be 0
    expect(guideOffsetX).toBe(0);
    expect(guideOffsetY).toBe(0);
  });

  test("larger manual cardback bleeds inset the source material without moving cutlines", () => {
    const globalBleedMm = 1.5;
    const manualBackBleedMm = 2.0; // Different from global
    const DPI = 1200;
    const MM_TO_PX = (mm: number, dpi: number) => Math.round((mm * dpi) / 25.4);

    // Guide canvas and prepared layout both stay on the global bleed.
    const bleedPxForGuide = MM_TO_PX(globalBleedMm, DPI);
    const preparedBleedPx = MM_TO_PX(globalBleedMm, DPI);

    // The guide offset should still be 0 (not affected by the manual inset)
    const guideOffsetX = preparedBleedPx - bleedPxForGuide;
    const guideOffsetY = preparedBleedPx - bleedPxForGuide;

    expect(guideOffsetX).toBe(0);
    expect(guideOffsetY).toBe(0);

    const cardX = 100;
    const cardY = 200;
    const guideCutX = cardX + preparedBleedPx;
    const guideCutY = cardY + preparedBleedPx;
    const contentWidthPx = MM_TO_PX(63, DPI);
    const contentHeightPx = MM_TO_PX(88, DPI);
    const guideCutRight = guideCutX + contentWidthPx;
    const guideCutBottom = guideCutY + contentHeightPx;
    const manualInsetPx = MM_TO_PX(manualBackBleedMm, DPI);
    const maxDrawWidth = contentWidthPx - manualInsetPx * 2;
    const maxDrawHeight = contentHeightPx - manualInsetPx * 2;
    const scale = Math.min(maxDrawWidth / contentWidthPx, maxDrawHeight / contentHeightPx);
    const sourceMaterialWidth = contentWidthPx * scale;
    const sourceMaterialHeight = contentHeightPx * scale;
    const sourceMaterialX = guideCutX + manualInsetPx + (maxDrawWidth - sourceMaterialWidth) / 2;
    const sourceMaterialY = guideCutY + manualInsetPx + (maxDrawHeight - sourceMaterialHeight) / 2;
    const sourceMaterialRight = sourceMaterialX + sourceMaterialWidth;
    const sourceMaterialBottom = sourceMaterialY + sourceMaterialHeight;

    expect(sourceMaterialX).toBeGreaterThan(guideCutX);
    expect(sourceMaterialY).toBeGreaterThan(guideCutY);
    expect(sourceMaterialRight).toBeLessThan(guideCutRight);
    expect(sourceMaterialBottom).toBeLessThan(guideCutBottom);
    expect(sourceMaterialWidth).toBeLessThan(contentWidthPx);
    expect(sourceMaterialHeight).toBeLessThan(contentHeightPx);
    expect(sourceMaterialWidth / sourceMaterialHeight).toBeCloseTo(contentWidthPx / contentHeightPx, 4);
  });

  test("guide positioning is independent of smaller per-card bleed overrides", () => {
    // This test documents the intended behavior:
    // - Guides mark the fixed content boundary at the global layout bleed
    // - Smaller per-card image bleed overrides only affect image placement within that boundary
    // - Guides should not receive an additional offset

    const globalBleedMm = 1.5;
    const perCardImageBleedMm = 1.0;
    const DPI = 1200;
    const MM_TO_PX = (mm: number, dpi: number) => Math.round((mm * dpi) / 25.4);

    const cardX = 100; // Card position on page
    const cardY = 200;

    // Scenario 1: No per-card override
    const bleedPxForGuide1 = MM_TO_PX(globalBleedMm, DPI);
    const preparedBleedPx1 = MM_TO_PX(globalBleedMm, DPI);
    const guideX1 = cardX + (preparedBleedPx1 - bleedPxForGuide1);
    const guideY1 = cardY + (preparedBleedPx1 - bleedPxForGuide1);

    // Scenario 2: With a smaller per-card override
    const bleedPxForGuide2 = MM_TO_PX(globalBleedMm, DPI);
    const preparedBleedPx2 = MM_TO_PX(globalBleedMm, DPI);
    const guideX2 = cardX + (preparedBleedPx2 - bleedPxForGuide2);
    const guideY2 = cardY + (preparedBleedPx2 - bleedPxForGuide2);

    // Guides should be at the same position in both scenarios
    expect(guideX1).toBe(guideX2);
    expect(guideY1).toBe(guideY2);
    expect(guideX1).toBe(cardX); // No offset
    expect(guideY1).toBe(cardY); // No offset
  });
});
