import { ImageProcessor } from "./imageProcessor";
import { useToastStore } from "../store/toast";

// Shared abort controller for metadata enrichment
let enrichmentAbortController = new AbortController();
const processingCancellationHandlers = new Set<() => void>();

/**
 * Register work that must stop before a project clear or switch mutates IndexedDB.
 */
export function registerProcessingCancellation(handler: () => void): () => void {
    processingCancellationHandlers.add(handler);
    return () => processingCancellationHandlers.delete(handler);
}

/**
 * Get the current abort controller for metadata enrichment
 */
export function getEnrichmentAbortController(): AbortController {
    return enrichmentAbortController;
}

/**
 * Reset the abort controller (call after cancellation to allow new enrichments)
 */
function resetEnrichmentAbortController(): void {
    enrichmentAbortController = new AbortController();
}

/**
 * Cancel all processing operations:
 * - Image processing workers
 * - Metadata enrichment
 * - Toast notifications
 */
export function cancelAllProcessing(): void {
    // Cancel image processing
    ImageProcessor.getInstance().cancelAll();

    // Cancel metadata enrichment
    enrichmentAbortController.abort();
    resetEnrichmentAbortController(); // Create fresh controller for next run

    // Fence direct imports before clear/switch transactions remove their placeholders.
    for (const cancel of processingCancellationHandlers) {
        cancel();
    }

    // Clear all toasts
    useToastStore.getState().clearToasts();
}
