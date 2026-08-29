import { describe, expect, it } from "vitest";
import { IMPORT_CONFIG } from "./importConfig";

describe("IMPORT_CONFIG", () => {
    it("exposes the documented import batching and rate limits", () => {
        expect(IMPORT_CONFIG).toEqual({
            MPC_SEARCH_CHUNK_SIZE: 50,
            TOKEN_ENRICH_CHUNK_SIZE: 100,
            SCRYFALL_COLLECTION_BATCH_SIZE: 75,
            PARALLEL_IMAGE_FETCH_SIZE: 10,
            SCRYFALL_RATE_LIMIT_MS: 100,
            IN_FLIGHT_CACHE_TTL_MS: 60_000,
            MAX_IN_FLIGHT_ENTRIES: 500,
        });
    });
});
