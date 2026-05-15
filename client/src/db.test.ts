import { describe, expect, it } from "vitest";

import { db, METADATA_CACHE_VERSION } from "./db";

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
});
