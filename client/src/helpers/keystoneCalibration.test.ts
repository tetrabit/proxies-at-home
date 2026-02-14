import { describe, expect, test } from "vitest";
import { keystoneTransformToPerCardOffsets } from "./keystoneCalibration";

describe("keystoneTransformToPerCardOffsets", () => {
  test("pure translation applies same offset to all slots", () => {
    const offsets = keystoneTransformToPerCardOffsets(
      { rot_deg: 0, translation_mm: { x: 1.5, y: -2.0 } },
      {
        pageSizeUnit: "mm",
        pageWidth: 216, // letter-ish, doesn't matter
        pageHeight: 279,
        columns: 3,
        rows: 3,
        cardSpacingMm: 0,
        bleedEdge: false,
        bleedEdgeWidth: 0,
        bleedEdgeUnit: "mm",
        cardPositionX: 0,
        cardPositionY: 0,
        useCustomBackOffset: false,
        cardBackPositionX: 0,
        cardBackPositionY: 0,
      },
    );

    for (const k of Object.keys(offsets)) {
      expect(offsets[Number(k)].x).toBeCloseTo(1.5);
      expect(offsets[Number(k)].y).toBeCloseTo(-2.0);
      expect(offsets[Number(k)].rotation).toBeCloseTo(0);
    }
  });

  test("rotation produces position-dependent translations", () => {
    const offsets = keystoneTransformToPerCardOffsets(
      { rot_deg: 1.0, translation_mm: { x: 0, y: 0 } },
      {
        pageSizeUnit: "mm",
        pageWidth: 216,
        pageHeight: 279,
        columns: 3,
        rows: 3,
        cardSpacingMm: 0,
        bleedEdge: false,
        bleedEdgeWidth: 0,
        bleedEdgeUnit: "mm",
        cardPositionX: 0,
        cardPositionY: 0,
        useCustomBackOffset: false,
        cardBackPositionX: 0,
        cardBackPositionY: 0,
      },
    );

    // Opposite corners should not have the same offset when rotating about origin.
    const tl = offsets[0];
    const br = offsets[8];
    expect(tl.x === br.x && tl.y === br.y).toBe(false);
    expect(tl.rotation).toBeCloseTo(1.0);
    expect(br.rotation).toBeCloseTo(1.0);
  });
});

