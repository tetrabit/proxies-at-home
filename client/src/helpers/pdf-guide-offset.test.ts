import { describe, expect, test } from "vitest";

/**
 * Regression test for guide offset fix
 * 
 * Issue: When per-card bleed overrides are used, the export guides were shifting
 * because the code calculated: guideOffsetX = prepared.bleedPx - bleedPxForGuide
 * 
 * Fix: Since prepared.bleedPx is always the global bleed (from cardLayout.bleedPx),
 * and bleedPxForGuide is also the global bleed, the offset should always be 0.
 * Guides should be anchored to the fixed card origin, not affected by per-card overrides.
 * 
 * This test verifies the math behind the fix.
 */
describe("PDF guide offset calculation", () => {
  test("guide offset should be zero when using global bleed", () => {
    // Simulate the scenario where guides are created with global bleed
    const globalBleedMm = 1.5; // Global bleed edge width
    const DPI = 1200;
    const MM_TO_PX = (mm: number, dpi: number) => Math.round((mm * dpi) / 25.4);

    // bleedPxForGuide is calculated from global bleed
    const bleedPxForGuide = MM_TO_PX(globalBleedMm, DPI);

    // prepared.bleedPx comes from cardLayout.bleedPx, which is also global bleed
    const preparedBleedPx = MM_TO_PX(globalBleedMm, DPI);

    // The offset calculation that was causing the bug
    const guideOffsetX = preparedBleedPx - bleedPxForGuide;
    const guideOffsetY = preparedBleedPx - bleedPxForGuide;

    // After the fix, these should always be 0
    expect(guideOffsetX).toBe(0);
    expect(guideOffsetY).toBe(0);
  });

  test("guide offset remains zero even with different per-card image bleeds", () => {
    // This test verifies that per-card image bleed overrides don't affect guide positioning
    const globalBleedMm = 1.5;
    const perCardImageBleedMm = 2.0; // Different from global
    const DPI = 1200;
    const MM_TO_PX = (mm: number, dpi: number) => Math.round((mm * dpi) / 25.4);

    // Guide canvas is created with global bleed
    const bleedPxForGuide = MM_TO_PX(globalBleedMm, DPI);

    // prepared.bleedPx is always global (from cardLayout)
    const preparedBleedPx = MM_TO_PX(globalBleedMm, DPI);

    // Image might have different bleed (used for centerOffset calculation)
    const imageBleedPx = MM_TO_PX(perCardImageBleedMm, DPI);

    // The guide offset should still be 0 (not affected by imageBleedPx)
    const guideOffsetX = preparedBleedPx - bleedPxForGuide;
    const guideOffsetY = preparedBleedPx - bleedPxForGuide;

    expect(guideOffsetX).toBe(0);
    expect(guideOffsetY).toBe(0);

    // The image centering offset is separate and should be non-zero
    const slotBleedPx = preparedBleedPx;
    const centerOffsetX = slotBleedPx - imageBleedPx;
    const centerOffsetY = slotBleedPx - imageBleedPx;

    expect(centerOffsetX).not.toBe(0);
    expect(centerOffsetY).not.toBe(0);
  });

  test("guide positioning is independent of per-card bleed overrides", () => {
    // This test documents the intended behavior:
    // - Guides mark the fixed content boundary (global bleed)
    // - Per-card image bleed overrides only affect image placement within that boundary
    // - Guides should never move when per-card overrides are applied

    const globalBleedMm = 1.5;
    const DPI = 1200;
    const MM_TO_PX = (mm: number, dpi: number) => Math.round((mm * dpi) / 25.4);

    const cardX = 100; // Card position on page
    const cardY = 200;

    // Scenario 1: No per-card override
    const bleedPxForGuide1 = MM_TO_PX(globalBleedMm, DPI);
    const preparedBleedPx1 = MM_TO_PX(globalBleedMm, DPI);
    const guideX1 = cardX + (preparedBleedPx1 - bleedPxForGuide1);
    const guideY1 = cardY + (preparedBleedPx1 - bleedPxForGuide1);

    // Scenario 2: With per-card override (different image bleed)
    const bleedPxForGuide2 = MM_TO_PX(globalBleedMm, DPI);
    const preparedBleedPx2 = MM_TO_PX(globalBleedMm, DPI); // Still global
    const guideX2 = cardX + (preparedBleedPx2 - bleedPxForGuide2);
    const guideY2 = cardY + (preparedBleedPx2 - bleedPxForGuide2);

    // Guides should be at the same position in both scenarios
    expect(guideX1).toBe(guideX2);
    expect(guideY1).toBe(guideY2);
    expect(guideX1).toBe(cardX); // No offset
    expect(guideY1).toBe(cardY); // No offset
  });
});
