import { describe, it, expect } from "vitest";
import { parseMpcCardName, parseMpcSetCollector } from "./mpcUtils";

describe("mpcUtils", () => {
  describe("parseMpcCardName", () => {
    it("strips bracket suffixes", () => {
      expect(parseMpcCardName("Forest [THB] {254}")).toBe("Forest");
    });

    it("strips parenthetical suffixes", () => {
      expect(parseMpcCardName("Lightning Bolt (M21)")).toBe("Lightning Bolt");
    });

    it("strips brace suffixes", () => {
      expect(parseMpcCardName("Sol Ring {C21}")).toBe("Sol Ring");
    });

    it("returns name unchanged when no suffix", () => {
      expect(parseMpcCardName("Lightning Bolt")).toBe("Lightning Bolt");
    });

    it("trims whitespace", () => {
      expect(parseMpcCardName("  Forest  [SET]")).toBe("Forest");
    });

    it("returns fallback for empty input", () => {
      expect(parseMpcCardName("", "Fallback")).toBe("Fallback");
    });

    it("returns empty string when no fallback and empty input", () => {
      expect(parseMpcCardName("")).toBe("");
    });

    it("strips trailing language or quality tags before metadata", () => {
      expect(parseMpcCardName("Sol Ring_EN [C21] {267}")).toBe("Sol Ring");
      expect(parseMpcCardName("Counterspell-hd [STA] {15}")).toBe(
        "Counterspell"
      );
    });

    it("normalizes multiline MPC names before parsing", () => {
      expect(parseMpcCardName("Sol Ring\n[C21] {267}")).toBe("Sol Ring");
    });
  });

  describe("parseMpcSetCollector", () => {
    it("extracts set and collector number: [OTC] {267}", () => {
      const result = parseMpcSetCollector(
        "Sol Ring (Kekai Kotaki) [OTC] {267}"
      );
      expect(result).toEqual({ set: "OTC", collectorNumber: "267" });
    });

    it("extracts set and collector number: [STA] {15}", () => {
      const result = parseMpcSetCollector("Counterspell [STA] {15}");
      expect(result).toEqual({ set: "STA", collectorNumber: "15" });
    });

    it("extracts set and collector number when parenthetical follows: [CMR] {395} (artist)", () => {
      const result = parseMpcSetCollector(
        "Counterspell [CMR] {395} (Zack Stella)"
      );
      expect(result).toEqual({ set: "CMR", collectorNumber: "395" });
    });

    it("extracts set code without collector number: [FCA]", () => {
      const result = parseMpcSetCollector("Counterspell-[FCA]-(FFXIV)");
      expect(result).toEqual({ set: "FCA", collectorNumber: "" });
    });

    it("extracts collector number without set code: {175}", () => {
      const result = parseMpcSetCollector("Counterspell {175}");
      expect(result).toEqual({ set: "", collectorNumber: "175" });
    });

    it("extracts from names with parenthetical before brackets", () => {
      const result = parseMpcSetCollector(
        "Counterspell (Mystical Archive) [STA] {15}"
      );
      expect(result).toEqual({ set: "STA", collectorNumber: "15" });
    });

    it("handles 4-char set codes like PF24", () => {
      const result = parseMpcSetCollector("Counterspell [PF24] {1}");
      expect(result).toEqual({ set: "PF24", collectorNumber: "1" });
    });

    it("handles 5-char set codes like PURL", () => {
      const result = parseMpcSetCollector("Counterspell [PURL] {9}");
      // PURL is 4 chars, but test 5 just in case
      expect(result).toEqual({ set: "PURL", collectorNumber: "9" });
    });

    it("handles collector numbers with letter suffix like {267a}", () => {
      const result = parseMpcSetCollector("Card Name [SET] {267a}");
      expect(result).toEqual({ set: "SET", collectorNumber: "267a" });
    });

    it("handles lowercase set codes and normalizes to uppercase", () => {
      const result = parseMpcSetCollector("Card [sta] {15}");
      expect(result).toEqual({ set: "STA", collectorNumber: "15" });
    });

    it("filters out [foil] as non-set tag", () => {
      const result = parseMpcSetCollector("Counterspell [foil]");
      expect(result).toBeNull();
    });

    it("filters out [hd] as non-set tag", () => {
      const result = parseMpcSetCollector("Counterspell [hd]");
      expect(result).toBeNull();
    });

    it("filters out [hd] but extracts [foil] + set when both present", () => {
      // [hd] [foil] → both filtered, no set
      const result = parseMpcSetCollector("Counterspell [hd] [foil]");
      expect(result).toBeNull();
    });

    it("filters out language tags like [EN], [JP]", () => {
      expect(parseMpcSetCollector("Card [EN]")).toBeNull();
      expect(parseMpcSetCollector("Card [JP]")).toBeNull();
    });

    it("returns null for parenthetical-only names", () => {
      const result = parseMpcSetCollector("Sol Ring (Dom)");
      expect(result).toBeNull();
    });

    it("returns null for plain names", () => {
      const result = parseMpcSetCollector("Counterspell");
      expect(result).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseMpcSetCollector("")).toBeNull();
    });

    it("extracts from name with large collector numbers: {1933}", () => {
      const result = parseMpcSetCollector("Counterspell {1933} (EN)");
      expect(result).toEqual({ set: "", collectorNumber: "1933" });
    });

    it("extracts set from [LEA] {54}", () => {
      const result = parseMpcSetCollector("Counterspell [LEA] {54}");
      expect(result).toEqual({ set: "LEA", collectorNumber: "54" });
    });

    it("handles [FCA] {4} format", () => {
      const result = parseMpcSetCollector("Counterspell [FCA] {4}");
      expect(result).toEqual({ set: "FCA", collectorNumber: "4" });
    });

    it("skips non-set tag before real set: [hd] [STA] {15}", () => {
      const result = parseMpcSetCollector("Counterspell [hd] [STA] {15}");
      expect(result).toEqual({ set: "STA", collectorNumber: "15" });
    });

    it("skips multiple non-set tags before real set: [foil] [hd] [CMR] {395}", () => {
      const result = parseMpcSetCollector("Sol Ring [foil] [hd] [CMR] {395}");
      expect(result).toEqual({ set: "CMR", collectorNumber: "395" });
    });

    it("returns only collector number when all brackets are non-set tags: [foil] {267}", () => {
      const result = parseMpcSetCollector("Sol Ring [foil] {267}");
      expect(result).toEqual({ set: "", collectorNumber: "267" });
    });

    it("prefers the bracket closest to the collector number when multiple valid set-like tags exist", () => {
      const result = parseMpcSetCollector("Counterspell [ALT] [STA] {15}");
      expect(result).toEqual({ set: "STA", collectorNumber: "15" });
    });

    it("accepts collector numbers with hyphenated suffixes", () => {
      const result = parseMpcSetCollector("Card Name [SLD] {123-456}");
      expect(result).toEqual({ set: "SLD", collectorNumber: "123-456" });
    });

    it("normalizes multiline MPC names before extracting set and collector number", () => {
      const result = parseMpcSetCollector("Sol Ring\n[CMR] {395}");
      expect(result).toEqual({ set: "CMR", collectorNumber: "395" });
    });
  });
});
