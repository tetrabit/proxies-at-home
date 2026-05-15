import { describe, expect, it, vi } from "vitest";

import {
  cleanSelfReferentialTokensUpgrade,
  clearCardMetadataCacheUpgrade,
  clearTokenCardDependenciesUpgrade,
  createDefaultProjectUpgrade,
  db,
  METADATA_CACHE_VERSION,
} from "./db";

describe("db schema", () => {
  it("configures the expected IndexedDB name, metadata cache version, and current tables", () => {
    expect(db.name).toBe("ProxxiedDB");
    expect(METADATA_CACHE_VERSION).toBe(2);

    expect(db.tables.map((table) => table.name).sort()).toEqual([
      "cardMetadataCache",
      "cardbacks",
      "cards",
      "effectCache",
      "fsAccessHandles",
      "imageCache",
      "images",
      "mpcCalibrationAssets",
      "mpcCalibrationCases",
      "mpcCalibrationDatasets",
      "mpcCalibrationRuns",
      "mpcSearchCache",
      "projects",
      "settings",
      "userPreferences",
      "user_images",
    ]);

    expect(db.cards.schema.primKey.keyPath).toBe("uuid");
    expect(db.projects.schema.primKey.keyPath).toBe("id");
    expect(db.mpcSearchCache.schema.primKey.keyPath).toEqual([
      "query",
      "cardType",
    ]);
  });

  it("runs schema upgrade helpers for metadata reset and default project creation", async () => {
    const clear = vi.fn().mockResolvedValue(undefined);
    const count = vi.fn().mockResolvedValue(3);
    const get = vi.fn().mockResolvedValue({ value: { paper: "a4" } });
    const addProject = vi.fn().mockResolvedValue(undefined);
    const addPrefs = vi.fn().mockResolvedValue(undefined);
    const tables = {
      cardMetadataCache: { clear },
      cards: { count },
      settings: { get },
      projects: { add: addProject },
      userPreferences: { add: addPrefs },
    } as const;
    const tx = { table: vi.fn((name: keyof typeof tables) => tables[name]) };

    await clearCardMetadataCacheUpgrade(tx);
    await createDefaultProjectUpgrade(tx, {
      randomUUID: () => "project-id",
      now: () => 1234,
    });

    expect(clear).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("proxxied:layout-settings:v1");
    expect(addProject).toHaveBeenCalledWith({
      id: "project-id",
      name: "My Project",
      createdAt: 1234,
      lastOpenedAt: 1234,
      cardCount: 3,
      settings: { paper: "a4" },
    });
    expect(addPrefs).toHaveBeenCalledWith({
      id: "default",
      settings: { paper: "a4" },
      favoriteCardbacks: [],
      lastProjectId: "project-id",
    });
  });

  it("falls back to empty settings and zero cards in project upgrade", async () => {
    const addProject = vi.fn();
    const addPrefs = vi.fn();
    const tx = {
      table: vi.fn(
        (name: string) =>
          ({
            cards: {},
            settings: { get: vi.fn().mockResolvedValue(undefined) },
            projects: { add: addProject },
            userPreferences: { add: addPrefs },
          })[name]
      ),
    };

    await createDefaultProjectUpgrade(tx, {
      randomUUID: () => "empty-project",
      now: () => 5,
    });

    expect(addProject).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "empty-project",
        cardCount: 0,
        settings: {},
      })
    );
    expect(addPrefs).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "default",
        settings: {},
        lastProjectId: "empty-project",
      })
    );
  });

  it("uses runtime uuid and clock defaults for project upgrade", async () => {
    const uuidSpy = vi.spyOn(crypto, "randomUUID").mockReturnValue("runtime-id");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(9876);
    const addProject = vi.fn();
    const addPrefs = vi.fn();
    const tx = {
      table: vi.fn(
        (name: string) =>
          ({
            cards: { count: vi.fn().mockResolvedValue(1) },
            settings: { get: vi.fn().mockResolvedValue({ value: { theme: "dark" } }) },
            projects: { add: addProject },
            userPreferences: { add: addPrefs },
          })[name]
      ),
    };

    await createDefaultProjectUpgrade(tx);

    expect(addProject).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "runtime-id",
        createdAt: 9876,
        lastOpenedAt: 9876,
        cardCount: 1,
        settings: { theme: "dark" },
      })
    );
    expect(addPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ lastProjectId: "runtime-id" })
    );
    uuidSpy.mockRestore();
    nowSpy.mockRestore();
  });

  it("cleans self-referential token parts during card upgrade", async () => {
    const cards = [
      {
        name: "Treasure",
        needs_token: true,
        token_parts: [{ name: "TREASURE" }, { name: "Clue" }, {}],
      },
      {
        name: "Copy",
        needs_token: true,
        token_parts: [{ name: "Copy" }],
      },
      { name: "Ignored", needs_token: false, token_parts: [{ name: "Ignored" }] },
    ];
    const tx = {
      table: vi.fn(() => ({
        filter: (predicate: (card: (typeof cards)[number]) => boolean) => ({
          modify: async (mutator: (card: (typeof cards)[number]) => void) => {
            cards.filter(predicate).forEach(mutator);
          },
        }),
      })),
    };

    await cleanSelfReferentialTokensUpgrade(tx);

    expect(cards[0]).toMatchObject({
      token_parts: [{ name: "Clue" }, {}],
      needs_token: true,
    });
    expect(cards[1]).toMatchObject({ token_parts: [], needs_token: false });
    expect(cards[2]).toMatchObject({
      token_parts: [{ name: "Ignored" }],
      needs_token: false,
    });
  });

  it("clears token dependencies from token cards during card upgrade", async () => {
    const cards = [
      {
        name: "Goblin",
        type_line: "Token Creature — Goblin",
        needs_token: true,
        token_parts: [{ name: "Goblin" }],
      },
      {
        name: "Spell",
        type_line: "Sorcery",
        needs_token: true,
        token_parts: [{ name: "Treasure" }],
      },
      { name: "No type", needs_token: true, token_parts: [{ name: "Clue" }] },
    ];
    const tx = {
      table: vi.fn(() => ({
        filter: (predicate: (card: (typeof cards)[number]) => boolean) => ({
          modify: async (mutator: (card: (typeof cards)[number]) => void) => {
            cards.filter(predicate).forEach(mutator);
          },
        }),
      })),
    };

    await clearTokenCardDependenciesUpgrade(tx);

    expect(cards[0]).toMatchObject({ token_parts: [], needs_token: false });
    expect(cards[1]).toMatchObject({
      token_parts: [{ name: "Treasure" }],
      needs_token: true,
    });
    expect(cards[2]).toMatchObject({
      token_parts: [{ name: "Clue" }],
      needs_token: true,
    });
  });

  it("tolerates upgrade transaction shims without optional filter support", async () => {
    const tx = { table: vi.fn(() => ({})) };

    await cleanSelfReferentialTokensUpgrade(tx);
    await clearTokenCardDependenciesUpgrade(tx);

    expect(tx.table).toHaveBeenCalledWith("cards");
  });
});
