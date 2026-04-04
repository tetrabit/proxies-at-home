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
export function parseMpcCardName(mpcName: string, fallback?: string): string {
    if (!mpcName) return fallback || "";
    // Match everything before the first bracket, parenthesis, or brace
    const match = mpcName.match(/^([^([{\r\n]+)/);
    return match ? match[1].trim() : (mpcName.trim() || fallback || "");
}

/**
 * Extracted set code and collector number from an MPC card name.
 */
export interface MpcSetCollector {
    set: string;            // Uppercase set code, e.g. "OTC"
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

    // Extract set code from square brackets: [OTC], [STA], [CMR], [LEA], [PF24], [FCA]
    // Must be 2-5 uppercase alphanumeric chars (set codes), not tags like [foil], [hd]
    const setMatch = mpcName.match(/\[([A-Z0-9]{2,5})\]/i);
    const rawSet = setMatch?.[1];
    // Filter out known non-set tags (case-insensitive)
    const NON_SET_TAGS = new Set(["foil", "hd", "en", "jp", "de", "fr", "it", "es", "pt", "ko", "ru", "zhs", "zht"]);
    const set = rawSet && !NON_SET_TAGS.has(rawSet.toLowerCase()) ? rawSet.toUpperCase() : undefined;

    // Extract collector number from curly braces: {267}, {15}, {395}
    // Must be numeric (possibly with letter suffix like "267a")
    const cnMatch = mpcName.match(/\{(\d+[a-z]?)\}/i);
    const collectorNumber = cnMatch?.[1];

    if (!set && !collectorNumber) return null;

    return {
        set: set ?? "",
        collectorNumber: collectorNumber ?? "",
    };
}
