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

// Successful health results are lazily cached; no timer is needed for expiry.
const HEALTH_CHECK_SUCCESS_TTL_MS = 1_000;
let cachedHealthCheck: { checkedAt: number } | null = null;
// Failures use a zero-duration cache policy, so the next caller can immediately retry.
// The current health operation, shared by concurrent availability checks.
let pendingHealthCheck: Promise<boolean> | null = null;

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
export function isMicroserviceAvailable(): Promise<boolean> {
    if (cachedHealthCheck && Date.now() - cachedHealthCheck.checkedAt < HEALTH_CHECK_SUCCESS_TTL_MS) {
        return Promise.resolve(true);
    }

    if (!pendingHealthCheck) {
        pendingHealthCheck = (async () => {
            try {
                const client = getScryfallClient();
                await trackMicroserviceCall('/health', () => client.health());
                cachedHealthCheck = { checkedAt: Date.now() };
                return true;
            } catch {
                cachedHealthCheck = null;
                return false;
            }
        })().finally(() => {
            pendingHealthCheck = null;
        });
    }

    return pendingHealthCheck;
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
