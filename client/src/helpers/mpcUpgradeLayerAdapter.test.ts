import { describe, it, expect } from "vitest";
import type { MpcAutofillCard } from "./mpcAutofillApi";
import type {
  RankedCandidate,
  RankedRecommendations,
} from "./mpcBulkUpgradeMatcher";
import {
  buildLayerTabs,
  getLayerLabel,
  type LayerKey,
} from "./mpcUpgradeLayerAdapter";

function makeCard(id: string): MpcAutofillCard {
  return {
    identifier: id,
    name: "Sol Ring",
    rawName: "Sol Ring",
    dpi: 300,
    tags: [],
    sourceName: "test",
    source: "test",
    extension: "png",
    size: 1000,
    smallThumbnailUrl: "",
    mediumThumbnailUrl: "",
  };
}

function makeRanked(
  id: string,
  bucket: RankedCandidate["bucket"] = "name"
): RankedCandidate {
  return {
    card: makeCard(id),
    reason: "name_dpi_fallback",
    bucket,
  };
}

function emptyRecommendations(): RankedRecommendations {
  return {
    fullProcess: [],
    exactPrinting: [],
    artMatch: [],
    fullCard: [],
    allMatches: [],
  };
}

describe("mpcUpgradeLayerAdapter", () => {
  describe("buildLayerTabs", () => {
    it("returns all five tabs in order", () => {
      const tabs = buildLayerTabs(emptyRecommendations());
      expect(tabs).toHaveLength(5);
      expect(tabs.map((t) => t.key)).toEqual([
        "fullProcess",
        "exactPrinting",
        "artMatch",
        "fullCard",
        "allMatches",
      ]);
    });

    it("uses friendly labels for each tab", () => {
      const tabs = buildLayerTabs(emptyRecommendations());
      expect(tabs.map((t) => t.label)).toEqual([
        "Full Process",
        "Exact Printing",
        "Art Match",
        "Full Card",
        "All Matches",
      ]);
    });

    it("maps fullProcess candidates directly", () => {
      const recs = emptyRecommendations();
      recs.fullProcess = [makeRanked("a"), makeRanked("b")];
      const tabs = buildLayerTabs(recs);
      const tab = tabs.find((t) => t.key === "fullProcess")!;
      expect(tab.count).toBe(2);
      expect(tab.candidates.map((c) => c.card.identifier)).toEqual(["a", "b"]);
    });

    it("maps exactPrinting candidates directly", () => {
      const recs = emptyRecommendations();
      recs.exactPrinting = [makeRanked("x", "set_collector")];
      const tabs = buildLayerTabs(recs);
      const tab = tabs.find((t) => t.key === "exactPrinting")!;
      expect(tab.count).toBe(1);
      expect(tab.candidates[0].card.identifier).toBe("x");
    });

    it("maps artMatch candidates directly", () => {
      const recs = emptyRecommendations();
      recs.artMatch = [
        makeRanked("art1"),
        makeRanked("art2"),
        makeRanked("art3"),
      ];
      const tabs = buildLayerTabs(recs);
      const tab = tabs.find((t) => t.key === "artMatch")!;
      expect(tab.count).toBe(3);
    });

    it("maps fullCard candidates directly", () => {
      const recs = emptyRecommendations();
      recs.fullCard = [makeRanked("fc1")];
      const tabs = buildLayerTabs(recs);
      const tab = tabs.find((t) => t.key === "fullCard")!;
      expect(tab.count).toBe(1);
    });

    it("maps allMatches ranked candidates directly", () => {
      const recs = emptyRecommendations();
      recs.allMatches = [makeRanked("raw1"), makeRanked("raw2")];
      const tabs = buildLayerTabs(recs);
      const tab = tabs.find((t) => t.key === "allMatches")!;
      expect(tab.count).toBe(2);
      expect(tab.candidates[0].card.identifier).toBe("raw1");
      expect(tab.candidates[0].bucket).toBe("name");
      expect(tab.candidates[0].reason).toBe("name_dpi_fallback");
    });

    it("preserves empty layers without error", () => {
      const recs = emptyRecommendations();
      recs.fullProcess = [makeRanked("only")];
      const tabs = buildLayerTabs(recs);
      expect(tabs.find((t) => t.key === "exactPrinting")!.count).toBe(0);
      expect(tabs.find((t) => t.key === "artMatch")!.count).toBe(0);
      expect(tabs.find((t) => t.key === "fullCard")!.count).toBe(0);
      expect(tabs.find((t) => t.key === "allMatches")!.count).toBe(0);
    });

    it("does not mix candidates across layers", () => {
      const recs = emptyRecommendations();
      recs.fullProcess = [makeRanked("fp")];
      recs.exactPrinting = [makeRanked("ep", "set_collector")];
      recs.artMatch = [makeRanked("am")];
      recs.fullCard = [makeRanked("fc")];
      recs.allMatches = [makeRanked("all")];

      const tabs = buildLayerTabs(recs);
      for (const tab of tabs) {
        const ids = tab.candidates.map((c) => c.card.identifier);
        if (tab.key === "fullProcess") expect(ids).toEqual(["fp"]);
        if (tab.key === "exactPrinting") expect(ids).toEqual(["ep"]);
        if (tab.key === "artMatch") expect(ids).toEqual(["am"]);
        if (tab.key === "fullCard") expect(ids).toEqual(["fc"]);
        if (tab.key === "allMatches") expect(ids).toEqual(["all"]);
      }
    });
    it("preserves different orderings across tabs when layers disagree", () => {
      const recs = emptyRecommendations();
      recs.fullProcess = [
        makeRanked("exact-print", "set_collector"),
        makeRanked("art-fav", "name"),
      ];
      recs.artMatch = [
        {
          card: makeCard("art-fav"),
          reason: "name_ssim" as const,
          bucket: "name" as const,
          score: 0.99,
        },
        {
          card: makeCard("exact-print"),
          reason: "set_collector_ssim" as const,
          bucket: "set_collector" as const,
          score: 0.8,
        },
      ];
      recs.fullCard = [
        makeRanked("high-dpi", "name"),
        makeRanked("exact-print", "set_collector"),
      ];

      const tabs = buildLayerTabs(recs);
      const fpTab = tabs.find((t) => t.key === "fullProcess")!;
      const amTab = tabs.find((t) => t.key === "artMatch")!;
      const fcTab = tabs.find((t) => t.key === "fullCard")!;

      expect(fpTab.candidates[0].card.identifier).toBe("exact-print");
      expect(amTab.candidates[0].card.identifier).toBe("art-fav");
      expect(fcTab.candidates[0].card.identifier).toBe("high-dpi");
    });

    it("keeps each friendly layer grouped by its own ranked output", () => {
      const recs = emptyRecommendations();
      recs.fullProcess = [makeRanked("full-process", "set_collector")];
      recs.exactPrinting = [makeRanked("exact-print", "set_collector")];
      recs.artMatch = [makeRanked("art-match")];
      recs.fullCard = [makeRanked("full-card")];
      recs.allMatches = [makeRanked("raw-a"), makeRanked("raw-b")];

      const tabs = buildLayerTabs(recs);

      expect(tabs.map((tab) => tab.label)).toEqual([
        "Full Process",
        "Exact Printing",
        "Art Match",
        "Full Card",
        "All Matches",
      ]);
      expect(tabs.map((tab) => tab.count)).toEqual([1, 1, 1, 1, 2]);
      expect(
        tabs.find((tab) => tab.key === "exactPrinting")!.candidates[0].card
          .identifier
      ).toBe("exact-print");
      expect(
        tabs
          .find((tab) => tab.key === "allMatches")!
          .candidates.map((card) => card.card.identifier)
      ).toEqual(["raw-a", "raw-b"]);
    });
  });

  describe("getLayerLabel", () => {
    const expected: [LayerKey, string][] = [
      ["fullProcess", "Full Process"],
      ["exactPrinting", "Exact Printing"],
      ["artMatch", "Art Match"],
      ["fullCard", "Full Card"],
      ["allMatches", "All Matches"],
    ];

    for (const [key, label] of expected) {
      it(`returns "${label}" for ${key}`, () => {
        expect(getLayerLabel(key)).toBe(label);
      });
    }
  });
});
