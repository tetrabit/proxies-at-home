export const IMPORT_REQUEST_LIMITS = {
  // POST /images/enrich is the existing public import-batch contract (routes/README.md).
  cardCount: 100,
  // Bound strings that become cache keys, collection identifiers, or token search clauses.
  nameLength: 256,
  setLength: 16,
  numberLength: 64,
  identifierLength: 64,
  languageLength: 16,
  // Quantity is preserved by import callers; a safe integer cap prevents downstream expansion overflow.
  quantity: 1_000,
} as const;

export type ImportCardListKey = "cardQueries" | "cards";

export type ImportRequestValidation =
  | { ok: true }
  | { ok: false; error: "Invalid import request" };

const invalidRequest = (): ImportRequestValidation => ({
  ok: false,
  error: "Invalid import request",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function optionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || isBoundedNonEmptyString(value, maxLength);
}

function isValidCardQuery(value: unknown): boolean {
  if (!isRecord(value) || !isBoundedNonEmptyString(value.name, IMPORT_REQUEST_LIMITS.nameLength)) {
    return false;
  }

  if (!optionalBoundedString(value.set, IMPORT_REQUEST_LIMITS.setLength)
    || !optionalBoundedString(value.number, IMPORT_REQUEST_LIMITS.numberLength)
    || !optionalBoundedString(value.scryfallId, IMPORT_REQUEST_LIMITS.identifierLength)
    || !optionalBoundedString(value.oracleId, IMPORT_REQUEST_LIMITS.identifierLength)
    || !optionalBoundedString(value.language, IMPORT_REQUEST_LIMITS.languageLength)) {
    return false;
  }

  if (value.isToken !== undefined && typeof value.isToken !== "boolean") {
    return false;
  }

  const quantity = value.quantity;
  if (quantity !== undefined
    && (typeof quantity !== "number"
      || !Number.isSafeInteger(quantity)
      || quantity < 1
      || quantity > IMPORT_REQUEST_LIMITS.quantity)) {
    return false;
  }

  return true;
}

/**
 * Reject malformed import data before `normalizeCardInfos` can map or lowercase it.
 * Cardinality intentionally precedes entry inspection because each entry may create
 * cache, resolver, and stream work once normalization starts.
 */
export function validateImportCardRequest(
  body: unknown,
  listKey: ImportCardListKey,
  options: { validateCardArt?: boolean } = {},
): ImportRequestValidation {
  if (!isRecord(body)) return invalidRequest();

  const cards = body[listKey];
  if (!Array.isArray(cards) || cards.length > IMPORT_REQUEST_LIMITS.cardCount) {
    return invalidRequest();
  }

  if (!optionalBoundedString(body.language, IMPORT_REQUEST_LIMITS.languageLength)) {
    return invalidRequest();
  }

  if (options.validateCardArt
    && body.cardArt !== undefined
    && body.cardArt !== "art"
    && body.cardArt !== "prints") {
    return invalidRequest();
  }

  for (const card of cards) {
    if (!isValidCardQuery(card)) return invalidRequest();
  }

  return { ok: true };
}
