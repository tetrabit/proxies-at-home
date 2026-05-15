import { describe, expect, it, vi } from "vitest";

import {
  clearCardMetadataCacheUpgrade,
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
});
