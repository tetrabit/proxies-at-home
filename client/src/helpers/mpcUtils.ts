/**
 * Utility functions for MPC card handling.
 * Separated to avoid circular imports between mpcAutofillApi and mpcSearchCache.
 */

/**
 * Parse an MPC card name to extract just the base card name.
 * MPC names often include set/collector info like "Forest [THB] {254}" or "Lightning Bolt (M21)".
 * This extracts just "Forest" or "Lightning Bolt".
 * @param mpcName The full MPC card name
 * @param fallback Optional fallback if parsing fails
 * @returns The base card name
 */
const NON_SET_TAGS = new Set([
  "foil",
  "hd",
  "alt",
  "art",
  "jp",
  "de",
  "fr",
  "it",
  "es",
  "pt",
  "ko",
  "ru",
  "zhs",
  "zht",
  "en",
]);

const TRAILING_NAME_TAG_PATTERN =
  /(?:[ _-](foil|hd|alt|art|jp|de|fr|it|es|pt|ko|ru|zhs|zht|en))+$/i;

function normalizeMpcText(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTrailingNameTags(value: string): string {
  return value.replace(TRAILING_NAME_TAG_PATTERN, "").trim();
}

export function parseMpcCardName(mpcName: string, fallback?: string): string {
  if (!mpcName) return fallback || "";
  const normalizedName = normalizeMpcText(mpcName);
  // Match everything before the first bracket, parenthesis, or brace
  const match = normalizedName.match(/^([^([{}\r\n]+)/);
  const baseName = match ? match[1].trim() : normalizedName || fallback || "";
  return stripTrailingNameTags(baseName);
}

/**
 * Extracted set code and collector number from an MPC card name.
 */
export interface MpcSetCollector {
  set: string; // Uppercase set code, e.g. "OTC"
  collectorNumber: string; // Collector number as string, e.g. "267"
}

/**
 * Parse set code and collector number from an MPC card name.
 *
 * MPC names use several patterns:
 *   "Sol Ring (Kekai Kotaki) [OTC] {267}"     → { set: "OTC", collectorNumber: "267" }
 *   "Counterspell [STA] {15}"                  → { set: "STA", collectorNumber: "15" }
 *   "Counterspell [CMR] {395} (Zack Stella)"   → { set: "CMR", collectorNumber: "395" }
 *   "Counterspell-[FCA]-(FFXIV)"               → { set: "FCA", collectorNumber: undefined }
 *   "Counterspell {175}"                        → { collectorNumber: "175" } (no set)
 *   "Counterspell [foil]"                       → null (not a set code)
 *   "Sol Ring (Dom)"                            → null (parenthetical without brackets)
 *
 * Returns null if neither set code nor collector number can be extracted.
 */
export function parseMpcSetCollector(mpcName: string): MpcSetCollector | null {
  if (!mpcName) return null;

  const normalizedName = normalizeMpcText(mpcName);

  // Extract set code from square brackets: [OTC], [STA], [CMR], [LEA], [PF24], [FCA]
  // Must be 2-5 uppercase alphanumeric chars (set codes), not tags like [foil], [hd]
  // Iterate ALL bracket groups to find the first valid set code (non-set tags may appear first)
  const bracketMatches = Array.from(
    normalizedName.matchAll(/\[([A-Z0-9]{2,5})\]/gi)
  );
  let set: string | undefined;

  const collectorMatch = normalizedName.match(/\{(\d[\da-z-]*)\}/i);
  const collectorNumber = collectorMatch?.[1];
  const collectorIndex = collectorMatch?.index ?? Number.POSITIVE_INFINITY;

  const validSetMatches = bracketMatches.filter(
    (match) => !NON_SET_TAGS.has(match[1].toLowerCase())
  );

  if (validSetMatches.length === 1) {
    set = validSetMatches[0][1].toUpperCase();
  } else if (validSetMatches.length > 1) {
    const closestBeforeCollector = validSetMatches
      .filter((match) => (match.index ?? -1) < collectorIndex)
      .at(-1);
    set = (closestBeforeCollector ?? validSetMatches.at(-1))?.[1].toUpperCase();
  }

  if (!set && !collectorNumber) return null;

  return {
    set: set ?? "",
    collectorNumber: collectorNumber ?? "",
  };
}
