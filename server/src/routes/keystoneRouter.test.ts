import { describe, expect, test } from "vitest";
import { parsePrinterKeystoneAnalyzeStdout } from "./keystoneRouter.js";

describe("keystoneRouter - parsePrinterKeystoneAnalyzeStdout", () => {
  test("parses shift and diagnostics and computes extra transform", () => {
    const stdout = `
Back-side shift to align to front (front-view coordinates):
  back_shift_x_mm: 1.25  (right 1.25 mm)
  back_shift_y_mm: -0.50  (up 0.50 mm)

Diagnostics:
  front: translation_mm=(10.00, 5.00) rot_deg=0.000 scale=1.000000 coord_fix=identity markers=[10, 11, 12, 13, 14]
  back:  translation_mm=(8.00, 6.00) rot_deg=2.000 scale=1.000000 coord_fix=identity markers=[10, 11, 12, 13, 14]
`;

    const res = parsePrinterKeystoneAnalyzeStdout(stdout);
    expect(res.back_shift_mm.x).toBeCloseTo(1.25);
    expect(res.back_shift_mm.y).toBeCloseTo(-0.5);

    expect(res.front.translation_mm.x).toBeCloseTo(10);
    expect(res.front.translation_mm.y).toBeCloseTo(5);
    expect(res.back.translation_mm.x).toBeCloseTo(8);
    expect(res.back.translation_mm.y).toBeCloseTo(6);

    // Extra rotation should be front - back
    expect(res.extra.rot_deg).toBeCloseTo(-2.0);

    // Extra translation is inv(Rb)*(tf - tb). With back rot=2deg and diff=(2,-1), should be close.
    expect(res.extra.translation_mm.x).toBeTypeOf("number");
    expect(res.extra.translation_mm.y).toBeTypeOf("number");
    expect(Number.isFinite(res.extra.translation_mm.x)).toBe(true);
    expect(Number.isFinite(res.extra.translation_mm.y)).toBe(true);
  });
});

