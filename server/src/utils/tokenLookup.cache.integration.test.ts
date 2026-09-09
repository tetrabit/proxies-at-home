import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => {
  const tokenIdentityGet = vi.fn();
  const pagedSearchGet = vi.fn();
  const collectionPost = vi.fn();
  const create = vi.fn((config?: { headers?: Record<string, string> }) => ({
    get: config?.headers?.["User-Agent"] === "Proxxied/1.0 (token-lookup)"
      ? tokenIdentityGet
      : pagedSearchGet,
    post: collectionPost,
  }));

  return { tokenIdentityGet, pagedSearchGet, collectionPost, create };
});

// Both direct Scryfall clients are intercepted at the HTTP boundary; DB and lookup
// modules remain real so this test exercises the cache row identity projection.
vi.mock("axios", () => ({
  create: transport.create,
  default: {
    create: transport.create,
    post: transport.collectionPost,
  },
}));

const fixtureRoot = fileURLToPath(
  new URL("../../../.review-artifacts/token-oracle-verification-01", import.meta.url)
);
const originalServerDataDir = process.env.SERVER_DATA_DIR;

async function loadModules() {
  vi.resetModules();
  const dbModule = await import("../db/db.js");
  const lookupModule = await import("../db/proxxiedCardLookup.js");
  const pagedModule = await import("./getCardImagesPaged.js");
  const tokenLookupModule = await import("./tokenLookup.js");
  const tokenUtilsModule = await import("./tokenUtils.js");
  dbModule.initDatabase();
  return { dbModule, lookupModule, pagedModule, tokenLookupModule, tokenUtilsModule };
}

describe("cached token oracle resolution", () => {
  let fixtureDir: string;

  beforeEach(() => {
    transport.tokenIdentityGet.mockReset();
    transport.pagedSearchGet.mockReset();
    transport.collectionPost.mockReset();
    transport.create.mockClear();
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fixtureDir = fs.mkdtempSync(path.join(fixtureRoot, "db-"));
    process.env.SERVER_DATA_DIR = fixtureDir;
  });

  afterEach(async () => {
    const { closeDatabase } = await import("../db/db.js").catch(() => ({ closeDatabase: () => undefined }));
    closeDatabase();
    if (originalServerDataDir === undefined) {
      delete process.env.SERVER_DATA_DIR;
    } else {
      process.env.SERVER_DATA_DIR = originalServerDataDir;
    }
    vi.resetModules();
  });

  it("uses the cached parent token link to select the newest matching oracle print", async () => {
    const { dbModule, lookupModule, pagedModule, tokenLookupModule, tokenUtilsModule } = await loadModules();

    lookupModule.insertOrUpdateCard({
      id: "cache-parent-print",
      oracle_id: "cache-parent-oracle",
      name: "Cached Token Maker",
      set: "cch",
      collector_number: "7",
      lang: "en",
      type_line: "Creature — Artificer",
      all_parts: [
        {
          id: "linked-treasure-print",
          component: "token",
          name: "Treasure",
          type_line: "Token Artifact — Treasure",
          uri: "https://api.scryfall.com/cards/linked-treasure-print",
        },
      ],
    });

    const rawCachedRow = dbModule.getDatabase().prepare(
      "SELECT id, oracle_id, all_parts FROM cards WHERE id = ?"
    ).get("cache-parent-print") as { id: string; oracle_id: string; all_parts: string };
    expect(rawCachedRow).toEqual({
      id: "cache-parent-print",
      oracle_id: "cache-parent-oracle",
      all_parts: expect.any(String),
    });

    const cachedParent = (await pagedModule.batchFetchCards([
      { name: "Cached Token Maker", set: "cch", number: "7" },
    ], "en")).get("cch:7");
    expect(cachedParent).toMatchObject({
      id: "cache-parent-print",
      oracle_id: "cache-parent-oracle",
      all_parts: [expect.objectContaining({ id: "linked-treasure-print", name: "Treasure" })],
    });

    transport.tokenIdentityGet.mockResolvedValueOnce({
      data: {
        id: "linked-treasure-print",
        name: "Treasure",
        oracle_id: "treasure-oracle",
        set: "told",
        collector_number: "1",
        released_at: "2020-01-01",
      },
    });
    transport.pagedSearchGet.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: "wrong-newer-homonym",
            name: "Treasure",
            oracle_id: "different-treasure-oracle",
            set: "twrong",
            collector_number: "99",
            released_at: "2026-01-01",
          },
          {
            id: "intended-latest-treasure",
            name: "Treasure",
            oracle_id: "treasure-oracle",
            set: "tnew",
            collector_number: "42",
            released_at: "2025-01-01",
          },
          {
            id: "older-matching-treasure",
            name: "Treasure",
            oracle_id: "treasure-oracle",
            set: "told",
            collector_number: "1",
            released_at: "2020-01-01",
          },
        ],
        has_more: false,
        next_page: null,
      },
    });

    const result = await tokenLookupModule.resolveLatestTokenParts(
      tokenUtilsModule.extractTokenParts(cachedParent),
      "en"
    );

    expect(result).toEqual([
      {
        id: "intended-latest-treasure",
        name: "Treasure",
        uri: "https://api.scryfall.com/cards/tnew/42",
        type_line: "Token Artifact — Treasure",
      },
    ]);
    expect(transport.collectionPost).not.toHaveBeenCalled();
    expect(transport.tokenIdentityGet).toHaveBeenCalledWith(
      "https://api.scryfall.com/cards/linked-treasure-print",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const searchedUrl = transport.pagedSearchGet.mock.calls[0]?.[0] as string;
    expect(new URL(searchedUrl).searchParams.get("q")).toBe(
      '!"Treasure" type:token include:extras unique:prints lang:en'
    );
  });
});
