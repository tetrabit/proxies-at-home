import { describe, expect, test } from "vitest";
import { exportModeUsesPerCardBackOffsets } from "./exportMode";

describe("exportModeUsesPerCardBackOffsets", () => {
  test("applies only for duplex/back exports", () => {
    expect(exportModeUsesPerCardBackOffsets("duplex")).toBe(true);
    expect(exportModeUsesPerCardBackOffsets("duplex-collated")).toBe(true);
    expect(exportModeUsesPerCardBackOffsets("backs")).toBe(true);

    expect(exportModeUsesPerCardBackOffsets("fronts")).toBe(false);
    expect(exportModeUsesPerCardBackOffsets("interleaved-all")).toBe(false);
    expect(exportModeUsesPerCardBackOffsets("interleaved-custom")).toBe(false);
    expect(exportModeUsesPerCardBackOffsets("visible_faces")).toBe(false);
  });
});

