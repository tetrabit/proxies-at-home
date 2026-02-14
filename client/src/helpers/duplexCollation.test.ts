import { describe, expect, test } from "vitest";
import { buildCollatedDuplexPageOrder } from "./duplexCollation";

describe("buildCollatedDuplexPageOrder", () => {
  test("interleaves front/back pages", () => {
    expect(buildCollatedDuplexPageOrder(3, 3)).toEqual([
      { src: "front", index: 0 },
      { src: "back", index: 0 },
      { src: "front", index: 1 },
      { src: "back", index: 1 },
      { src: "front", index: 2 },
      { src: "back", index: 2 },
    ]);
  });

  test("handles mismatched counts", () => {
    expect(buildCollatedDuplexPageOrder(2, 1)).toEqual([
      { src: "front", index: 0 },
      { src: "back", index: 0 },
      { src: "front", index: 1 },
    ]);

    expect(buildCollatedDuplexPageOrder(1, 2)).toEqual([
      { src: "front", index: 0 },
      { src: "back", index: 0 },
      { src: "back", index: 1 },
    ]);
  });
});

