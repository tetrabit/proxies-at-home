import { describe, expect, test } from "vitest";
import {
  buildCollatedDuplexPageOrder,
  splitInterleavedDuplexPageIndices,
} from "./duplexCollation";

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

describe("splitInterleavedDuplexPageIndices", () => {
  test("returns grouped front/back page indices for interleaved output", () => {
    expect(splitInterleavedDuplexPageIndices(3, 3)).toEqual({
      frontPageIndices: [0, 2, 4],
      backPageIndices: [1, 3, 5],
    });
  });

  test("handles mismatched counts", () => {
    expect(splitInterleavedDuplexPageIndices(2, 1)).toEqual({
      frontPageIndices: [0, 2],
      backPageIndices: [1],
    });

    expect(splitInterleavedDuplexPageIndices(1, 2)).toEqual({
      frontPageIndices: [0],
      backPageIndices: [1, 2],
    });
  });
});
