import { describe, expect, it } from "vitest";
import {
  IMPORT_REQUEST_LIMITS,
  validateImportCardRequest,
} from "./importRequestValidation.js";

describe("validateImportCardRequest", () => {
  it("accepts the documented exact card and field boundaries before normalization", () => {
    const result = validateImportCardRequest({
      language: "x".repeat(IMPORT_REQUEST_LIMITS.languageLength),
      cardQueries: Array.from({ length: IMPORT_REQUEST_LIMITS.cardCount }, () => ({
        name: "n".repeat(IMPORT_REQUEST_LIMITS.nameLength),
        set: "s".repeat(IMPORT_REQUEST_LIMITS.setLength),
        number: "1".repeat(IMPORT_REQUEST_LIMITS.numberLength),
        scryfallId: "i".repeat(IMPORT_REQUEST_LIMITS.identifierLength),
        oracleId: "o".repeat(IMPORT_REQUEST_LIMITS.identifierLength),
        language: "l".repeat(IMPORT_REQUEST_LIMITS.languageLength),
        quantity: IMPORT_REQUEST_LIMITS.quantity,
        isToken: false,
      })),
    }, "cardQueries");

    expect(result).toEqual({ ok: true });
  });

  it("rejects oversized lists before inspecting individual entries", () => {
    const result = validateImportCardRequest({
      cardQueries: Array.from({ length: IMPORT_REQUEST_LIMITS.cardCount + 1 }, () => ({
        get name() {
          throw new Error("entries must not be inspected after cardinality rejection");
        },
      })),
    }, "cardQueries");

    expect(result).toEqual({ ok: false, error: "Invalid import request" });
  });

  it.each([
    { cardQueries: "not-an-array" },
    { cardQueries: [{ name: "" }] },
    { cardQueries: [{ name: 3 }] },
    { cardQueries: [{ name: "Card", set: 3 }] },
    { cardQueries: [{ name: "Card", quantity: IMPORT_REQUEST_LIMITS.quantity + 1 }] },
    { cardQueries: [{ name: "Card", quantity: 1.5 }] },
    { cardQueries: [{ name: "Card", isToken: "true" }] },
    { cardQueries: [{ name: "Card", language: { code: "en" } }] },
    { cardQueries: [{ name: "n".repeat(IMPORT_REQUEST_LIMITS.nameLength + 1) }] },
  ])("rejects malformed fields without normalizing them: %#", (body) => {
    expect(validateImportCardRequest(body, "cardQueries")).toEqual({
      ok: false,
      error: "Invalid import request",
    });
  });
});
