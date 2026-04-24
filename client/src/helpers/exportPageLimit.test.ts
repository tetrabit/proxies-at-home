import { describe, expect, test } from "vitest";
import {
  countExportPages,
  formatPdfPageLimitInput,
  parsePdfPageLimit,
  splitCollatedDuplexPageLimit,
  splitGroupedDuplexPageLimit,
} from "./exportPageLimit";

describe("export page limits", () => {
  test("parses optional PDF page limit input", () => {
    expect(parsePdfPageLimit("")).toBeUndefined();
    expect(parsePdfPageLimit("  ")).toBeUndefined();
    expect(parsePdfPageLimit("abc")).toBeUndefined();
    expect(parsePdfPageLimit("0")).toBe(1);
    expect(parsePdfPageLimit("-4")).toBe(1);
    expect(parsePdfPageLimit("3.9")).toBe(3);
  });

  test("formats committed page limit input", () => {
    expect(formatPdfPageLimitInput("")).toBe("");
    expect(formatPdfPageLimitInput("2.5")).toBe("2");
    expect(formatPdfPageLimitInput("0")).toBe("1");
  });

  test("counts pages from item count and page capacity", () => {
    expect(countExportPages(0, 9)).toBe(0);
    expect(countExportPages(1, 9)).toBe(1);
    expect(countExportPages(9, 9)).toBe(1);
    expect(countExportPages(10, 9)).toBe(2);
    expect(countExportPages(10, 0)).toBe(10);
  });

  test("splits grouped duplex page limits in final PDF order", () => {
    expect(splitGroupedDuplexPageLimit(undefined, 3, 3)).toEqual({});
    expect(splitGroupedDuplexPageLimit(2, 3, 3)).toEqual({
      frontMaxPages: 2,
      backMaxPages: 0,
    });
    expect(splitGroupedDuplexPageLimit(4, 3, 3)).toEqual({
      frontMaxPages: 3,
      backMaxPages: 1,
    });
    expect(splitGroupedDuplexPageLimit(8, 3, 3)).toEqual({
      frontMaxPages: 3,
      backMaxPages: 3,
    });
  });

  test("splits collated duplex page limits in front/back order", () => {
    expect(splitCollatedDuplexPageLimit(undefined, 3, 3)).toEqual({});
    expect(splitCollatedDuplexPageLimit(1, 3, 3)).toEqual({
      frontMaxPages: 1,
      backMaxPages: 0,
    });
    expect(splitCollatedDuplexPageLimit(2, 3, 3)).toEqual({
      frontMaxPages: 1,
      backMaxPages: 1,
    });
    expect(splitCollatedDuplexPageLimit(5, 3, 3)).toEqual({
      frontMaxPages: 3,
      backMaxPages: 2,
    });
    expect(splitCollatedDuplexPageLimit(8, 3, 3)).toEqual({
      frontMaxPages: 3,
      backMaxPages: 3,
    });
  });
});
