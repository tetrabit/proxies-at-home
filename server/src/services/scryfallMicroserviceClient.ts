/**
 * Scryfall Microservice Client Adapter
 *
 * Wraps the scryfall-cache-client for use in server routes.
 * The microservice is bundled with Electron and runs on a configurable port.
 */

import { ScryfallCacheClient } from '@tetrabit/scryfall-cache-client';
import { trackMicroserviceCall, metricsCollector } from './microserviceMetrics.js';

// Configuration
const MICROSERVICE_BASE_URL = process.env.SCRYFALL_CACHE_URL || 'http://localhost:8080';

// Singleton client instance
let clientInstance: ScryfallCacheClient | null = null;

/**
 * Get or create the microservice client instance
 */
export function getScryfallClient(): ScryfallCacheClient {
    if (!clientInstance) {
        clientInstance = new ScryfallCacheClient({
            baseUrl: MICROSERVICE_BASE_URL,
            timeout: 10000,
        });
    }
    return clientInstance;
}

/**
 * Check if microservice is available
 */
export async function isMicroserviceAvailable(): Promise<boolean> {
    try {
        const client = getScryfallClient();
        await trackMicroserviceCall('/health', () => client.health());
        return true;
    } catch {
        return false;
    }
}

/**
 * Get performance metrics summary
 */
export function getMicroserviceMetrics() {
    return metricsCollector.getSummary();
}

/**
 * Log current performance metrics
 */
export function logMicroserviceMetrics() {
    metricsCollector.logSummary();
}

/**
 * Reset performance metrics
 */
export function resetMicroserviceMetrics() {
    metricsCollector.reset();
}
