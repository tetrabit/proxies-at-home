import { describe, expect, it } from "vitest";
import { LAYOUT_FIELDS } from "./layoutSettings";

describe("layoutSettings", () => {
  it("exports the expected layout field keys", () => {
    expect(LAYOUT_FIELDS).toContain("pageSizeUnit");
    expect(LAYOUT_FIELDS).toContain("columns");
    expect(LAYOUT_FIELDS).toContain("dpi");
    expect(LAYOUT_FIELDS).toHaveLength(13);
  });
});
