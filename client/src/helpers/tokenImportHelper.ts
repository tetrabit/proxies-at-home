import { ImportOrchestrator } from "./ImportOrchestrator";
import { useSettingsStore } from "@/store/settings";

export interface AutoTokenOptions {
    signal?: AbortSignal;
    onComplete?: () => void;
    onNoTokens?: () => void;
    silent?: boolean;
    /**
     * If true, bypasses the autoImportTokens setting check.
     * Use for explicit user-triggered actions.
     */
    force?: boolean;
}

/**
 * Triggers import of missing tokens for cards that need them.
 * Checks autoImportTokens setting and returns early if disabled.
 */
export async function handleAutoImportTokens(options: AutoTokenOptions = {}) {
    const { silent = false } = options;

    // Check global setting - return early if disabled
    if (!options.force && !useSettingsStore.getState().autoImportTokens) {
        return;
    }

    try {
        await ImportOrchestrator.importMissingTokens({
            skipExisting: silent,
            signal: options.signal,
            onComplete: options.onComplete,
            onNoTokens: options.onNoTokens,
        });
    } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
            // Ignore aborts
            return;
        }
        console.error("Failed to auto-import tokens:", err);
        if (!silent) {
            // Re-throw or alert if not silent?
            // The original code in DecklistUploader alert()ed non-aborts.
            // MpcImportSection just console.error'd.
            // We'll let the caller decide or just throw non-aborts.
            throw err;
        }
    }
}

/**
 * Manual token import triggered by user action.
 * Always performs a full project scan (refreshes token_parts for all cards)
 * and skips existing tokens to prevent duplicates.
 */
export async function handleManualTokenImport(options: Omit<AutoTokenOptions, 'force'> = {}) {
    const { silent = false } = options;

    try {
        await ImportOrchestrator.importMissingTokens({
            skipExisting: true, // Always skip existing to prevent duplicates
            forceRefresh: true, // Always refresh all cards for full project scan
            signal: options.signal,
            onComplete: options.onComplete,
            onNoTokens: options.onNoTokens,
        });
    } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
            // Ignore aborts
            return;
        }
        console.error("Failed to import tokens:", err);
        if (!silent) {
            throw err;
        }
    }
}
