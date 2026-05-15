import { describe, expect, it } from "vitest";
import type { CardOption } from "../../../shared/types";
import {
  extractAvailableFilters,
  getCardTypes,
  matchesFilters,
  sortCards,
  sortManual,
  type FilterCriteria,
} from "./sortAndFilterUtils";

const baseCriteria: FilterCriteria = {
  manaCost: [],
  colors: [],
  types: [],
  categories: [],
  matchType: "partial",
};

function card(overrides: Partial<CardOption>): CardOption {
  return {
    uuid: overrides.uuid ?? overrides.name ?? "card",
    name: overrides.name ?? "Card",
    order: overrides.order ?? 0,
    isUserUpload: overrides.isUserUpload ?? false,
    ...overrides,
  };
}

describe("sortAndFilterUtils", () => {
  it("sorts manual order with front faces before linked backs and supports descending order", () => {
    const front = card({
      uuid: "front",
      name: "Front",
      order: 2,
      linkedBackId: "back",
    });
    const back = card({
      uuid: "back",
      name: "Back",
      order: 2,
      linkedFrontId: "front",
    });
    const first = card({ uuid: "first", name: "First", order: 1 });

    expect(sortManual([back, front, first]).map((c) => c.uuid)).toEqual([
      "first",
      "front",
      "back",
    ]);
    expect(
      sortCards([back, front, first], { by: "manual", order: "desc" }).map(
        (c) => c.uuid
      )
    ).toEqual(["back", "front", "first"]);
  });

  it("sorts by name, type, cmc, rarity, and falls back to order for unknown sort keys", () => {
    const cards = [
      card({
        uuid: "rare",
        name: "Beta // Back",
        type_line: "Legendary Creature",
        cmc: 5,
        rarity: "rare",
        order: 3,
      }),
      card({
        uuid: "basic",
        name: "Forest",
        type_line: "Basic Land",
        cmc: 0,
        order: 1,
      }),
      card({
        uuid: "mythic",
        name: "Alpha",
        type_line: "Snow Artifact",
        cmc: 2,
        rarity: "mythic",
        order: 2,
      }),
    ];

    expect(
      sortCards(cards, { by: "name", order: "asc" }).map((c) => c.uuid)
    ).toEqual(["mythic", "rare", "basic"]);
    expect(
      sortCards(cards, { by: "name", order: "desc" }).map((c) => c.uuid)
    ).toEqual(["basic", "rare", "mythic"]);
    expect(
      sortCards(cards, { by: "manual", order: "asc" }).map((c) => c.uuid)
    ).toEqual(["basic", "mythic", "rare"]);
    expect(
      sortCards(cards, { by: "type", order: "asc" }).map((c) => c.uuid)
    ).toEqual(["mythic", "rare", "basic"]);
    expect(
      sortCards(cards, { by: "cmc", order: "asc" }).map((c) => c.uuid)
    ).toEqual(["basic", "mythic", "rare"]);
    expect(
      sortCards(
        [card({ uuid: "missing-cmc-b", name: "B" }), card({ uuid: "missing-cmc-a", name: "A" })],
        { by: "cmc", order: "asc" }
      ).map((c) => c.uuid)
    ).toEqual(["missing-cmc-b", "missing-cmc-a"]);
    expect(
      sortCards(cards, { by: "rarity", order: "asc" }).map((c) => c.uuid)
    ).toEqual(["basic", "rare", "mythic"]);
    expect(
      sortCards(cards, { by: "rarity", order: "desc" }).map((c) => c.uuid)
    ).toEqual(["mythic", "rare", "basic"]);
    expect(
      sortCards(
        [
          card({ name: "No Rarity B", type_line: "Creature", order: 2 }),
          card({ name: "No Rarity A", type_line: "Creature", order: 1 }),
        ],
        { by: "rarity", order: "asc" }
      ).map((c) => c.name)
    ).toEqual(["No Rarity B", "No Rarity A"]);
    expect(
      sortCards(cards, { by: "unknown" as never, order: "asc" }).map(
        (c) => c.uuid
      )
    ).toEqual(["basic", "mythic", "rare"]);
    expect(sortCards([], { by: "name", order: "asc" })).toEqual([]);
  });

  it("sorts colors by primary color, land priority, color count, canonical string, and name", () => {
    const cards = [
      card({
        uuid: "wu-name-b",
        name: "Zulu",
        colors: ["U", "W"],
        type_line: "Creature",
        order: 5,
      }),
      card({
        uuid: "wu-name-a",
        name: "Alpha",
        colors: ["W", "U"],
        type_line: "Creature",
        order: 6,
      }),
      card({
        uuid: "w-land",
        name: "Plains",
        colors: ["W"],
        type_line: "Land",
        order: 2,
      }),
      card({
        uuid: "w-creature",
        name: "Soldier",
        colors: ["W"],
        type_line: "Creature",
        order: 3,
      }),
      card({
        uuid: "colorless",
        name: "Stone",
        colors: [],
        type_line: "Artifact",
        order: 1,
      }),
      card({
        uuid: "green",
        name: "Elf",
        colors: ["G"],
        type_line: "Creature",
        order: 4,
      }),
    ];

    expect(
      sortCards(cards, { by: "color", order: "asc" }).map((c) => c.uuid)
    ).toEqual([
      "green",
      "w-land",
      "w-creature",
      "wu-name-a",
      "wu-name-b",
      "colorless",
    ]);
    expect(
      sortCards(
        [
          card({ uuid: "wr", name: "WR", colors: ["W", "R"] }),
          card({ uuid: "wu", name: "WU", colors: ["W", "U"] }),
        ],
        { by: "color", order: "asc" }
      ).map((c) => c.uuid)
    ).toEqual(["wr", "wu"]);
    expect(
      sortCards(cards, { by: "color", order: "desc" }).map((c) => c.uuid)[0]
    ).toBe("colorless");
  });

  it("extracts filters with token, dual-faced, type, and category ordering", () => {
    expect(extractAvailableFilters([card({ name: "Plain", type_line: "Creature" })])).toEqual({
      types: ["Creature"],
      categories: [],
    });

    expect(
      extractAvailableFilters([
        card({ name: "Side", type_line: "Sorcery", category: "Sideboard" }),
        card({
          name: "Commander",
          type_line: "Creature",
          category: "Commander",
        }),
        card({
          name: "Main",
          type_line: "Instant",
          category: "Mainboard",
          linkedBackId: "back",
        }),
        card({
          name: "Token",
          isToken: true,
          type_line: "Creature Token",
          category: "Tokens",
        }),
      ])
    ).toEqual({
      types: ["Token", "Creature", "Instant", "Sorcery", "Dual Faced"],
      categories: ["Commander", "Mainboard", "Sideboard", "Tokens"],
    });
  });

  it("extracts card types from supported primary types", () => {
    expect(getCardTypes(undefined)).toEqual([]);
    expect(getCardTypes("Legendary Creature Artifact — Golem")).toEqual([
      "Creature",
      "Artifact",
    ]);
    expect(getCardTypes("Token // Battle")).toEqual(["Battle"]);
  });

  it("matches exact color filters including multicolor, colorless, selected colors, and invalid empty exact filters", () => {
    expect(
      matchesFilters(card({ colors: ["W", "U"] }), {
        ...baseCriteria,
        colors: ["M"],
        matchType: "exact",
      })
    ).toBe(true);
    expect(
      matchesFilters(card({ colors: ["W"] }), {
        ...baseCriteria,
        colors: ["M"],
        matchType: "exact",
      })
    ).toBe(false);
    expect(
      matchesFilters(card({ colors: [] }), {
        ...baseCriteria,
        colors: ["C"],
        matchType: "exact",
      })
    ).toBe(true);
    expect(
      matchesFilters(card({ colors: ["G"] }), {
        ...baseCriteria,
        colors: ["C"],
        matchType: "exact",
      })
    ).toBe(false);
    expect(
      matchesFilters(card({ colors: ["W", "U"] }), {
        ...baseCriteria,
        colors: ["W", "U"],
        matchType: "exact",
      })
    ).toBe(true);
    expect(
      matchesFilters(card({ colors: ["W", "U", "B"] }), {
        ...baseCriteria,
        colors: ["W", "U"],
        matchType: "exact",
      })
    ).toBe(false);
    expect(
      matchesFilters(card({ colors: ["W"] }), {
        ...baseCriteria,
        colors: ["U"],
        matchType: "exact",
      })
    ).toBe(false);
    expect(
      matchesFilters(card({ colors: ["W"] }), {
        ...baseCriteria,
        colors: ["M", "C"],
        matchType: "exact",
      })
    ).toBe(false);
  });

  it("matches partial color filters across both faces", () => {
    const front = card({ colors: ["W"] });
    const back = card({ colors: ["B"] });

    expect(
      matchesFilters(front, { ...baseCriteria, colors: ["M"] }, back)
    ).toBe(true);
    expect(
      matchesFilters(card({ colors: [] }), { ...baseCriteria, colors: ["C"] })
    ).toBe(true);
    expect(
      matchesFilters(card({ colors: undefined }), {
        ...baseCriteria,
        colors: ["C"],
      })
    ).toBe(true);
    expect(
      matchesFilters(front, { ...baseCriteria, colors: ["G"] }, back)
    ).toBe(false);
    expect(
      matchesFilters(front, { ...baseCriteria, colors: ["B"] }, back)
    ).toBe(true);
    expect(
      matchesFilters(card({ colors: ["W"] }), { ...baseCriteria, colors: ["C"] })
    ).toBe(false);
  });

  it("matches token and type filters for exact and partial modes across faces", () => {
    const creature = card({ type_line: "Creature", isToken: false });
    const artifactBack = card({ type_line: "Artifact", isToken: true });

    expect(
      matchesFilters(creature, {
        ...baseCriteria,
        types: ["Token"],
        matchType: "exact",
      })
    ).toBe(false);
    expect(
      matchesFilters(
        creature,
        { ...baseCriteria, types: ["Token"], matchType: "exact" },
        artifactBack
      )
    ).toBe(true);
    expect(
      matchesFilters(creature, {
        ...baseCriteria,
        types: ["Token"],
        matchType: "partial",
      })
    ).toBe(false);
    expect(
      matchesFilters(creature, {
        ...baseCriteria,
        types: ["Token", "Creature"],
        matchType: "partial",
      })
    ).toBe(true);
    expect(
      matchesFilters(
        creature,
        { ...baseCriteria, types: ["Token", "Artifact"], matchType: "partial" },
        artifactBack
      )
    ).toBe(true);
    expect(
      matchesFilters(
        creature,
        { ...baseCriteria, types: ["Artifact"], matchType: "exact" },
        artifactBack
      )
    ).toBe(true);
    expect(
      matchesFilters(
        creature,
        { ...baseCriteria, types: ["Artifact", "Land"], matchType: "exact" },
        artifactBack
      )
    ).toBe(false);
    expect(
      matchesFilters(creature, {
        ...baseCriteria,
        types: ["Dual Faced"],
        matchType: "partial",
      })
    ).toBe(true);
    expect(
      matchesFilters(card({ type_line: "Emblem", isToken: true }), {
        ...baseCriteria,
        types: ["Token", "Creature"],
        matchType: "partial",
      })
    ).toBe(true);
  });


  it("covers fallback color and rarity branch defaults", () => {
    expect(
      sortCards(
        [
          card({ uuid: "unknown", name: "Unknown", colors: ["X"], type_line: "Creature" }),
          card({ uuid: "none", name: "None", type_line: "Creature" }),
        ],
        { by: "color", order: "asc" }
      ).map((c) => c.uuid)
    ).toEqual(["unknown", "none"]);

    expect(
      sortCards(
        [
          card({ uuid: "z-no-colors", name: "Zulu", type_line: "Artifact" }),
          card({ uuid: "a-no-colors", name: "Alpha", type_line: "Artifact" }),
        ],
        { by: "color", order: "asc" }
      ).map((c) => c.uuid)
    ).toEqual(["a-no-colors", "z-no-colors"]);

    expect(
      sortCards(
        [
          card({ uuid: "wx", name: "WX", colors: ["W", "X"] }),
          card({ uuid: "wu", name: "WU", colors: ["W", "U"] }),
        ],
        { by: "color", order: "asc" }
      ).map((c) => c.uuid)
    ).toEqual(["wu", "wx"]);

    expect(
      sortCards(
        [
          card({ uuid: "weird", name: "Weird", rarity: "masterpiece" }),
          card({ uuid: "basic-name", name: "Island" }),
        ],
        { by: "rarity", order: "asc" }
      ).map((c) => c.uuid)
    ).toEqual(["weird", "basic-name"]);
  });
});
