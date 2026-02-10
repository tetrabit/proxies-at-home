/**
 * Microservice Performance Metrics
 *
 * Tracks query response times, cache hit rates, and error rates
 * for the Scryfall cache microservice.
 */

export interface MicroserviceMetrics {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    totalResponseTime: number; // milliseconds
    minResponseTime: number;
    maxResponseTime: number;
    cacheHits: number;
    cacheMisses: number;
    errorsByType: Map<string, number>;
    requestsByEndpoint: Map<string, EndpointMetrics>;
}

export interface EndpointMetrics {
    count: number;
    totalTime: number;
    minTime: number;
    maxTime: number;
    errors: number;
}

export interface MetricsSummary {
    totalRequests: number;
    successRate: number;
    averageResponseTime: number;
    minResponseTime: number;
    maxResponseTime: number;
    cacheHitRate: number;
    errorRate: number;
    topErrors: Array<{ type: string; count: number }>;
    endpointStats: Array<{ endpoint: string; avgTime: number; count: number }>;
}

class MicroserviceMetricsCollector {
    private metrics: MicroserviceMetrics = {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        totalResponseTime: 0,
        minResponseTime: Infinity,
        maxResponseTime: 0,
        cacheHits: 0,
        cacheMisses: 0,
        errorsByType: new Map(),
        requestsByEndpoint: new Map(),
    };

    /**
     * Record a successful request
     */
    recordRequest(endpoint: string, responseTime: number, cacheHit?: boolean): void {
        this.metrics.totalRequests++;
        this.metrics.successfulRequests++;
        this.metrics.totalResponseTime += responseTime;
        this.metrics.minResponseTime = Math.min(this.metrics.minResponseTime, responseTime);
        this.metrics.maxResponseTime = Math.max(this.metrics.maxResponseTime, responseTime);

        if (cacheHit !== undefined) {
            if (cacheHit) {
                this.metrics.cacheHits++;
            } else {
                this.metrics.cacheMisses++;
            }
        }

        // Update endpoint-specific metrics
        const endpointMetrics = this.metrics.requestsByEndpoint.get(endpoint) || {
            count: 0,
            totalTime: 0,
            minTime: Infinity,
            maxTime: 0,
            errors: 0,
        };

        endpointMetrics.count++;
        endpointMetrics.totalTime += responseTime;
        endpointMetrics.minTime = Math.min(endpointMetrics.minTime, responseTime);
        endpointMetrics.maxTime = Math.max(endpointMetrics.maxTime, responseTime);

        this.metrics.requestsByEndpoint.set(endpoint, endpointMetrics);
    }

    /**
     * Record a failed request
     */
    recordError(endpoint: string, errorType: string): void {
        this.metrics.totalRequests++;
        this.metrics.failedRequests++;

        // Track error by type
        const currentCount = this.metrics.errorsByType.get(errorType) || 0;
        this.metrics.errorsByType.set(errorType, currentCount + 1);

        // Update endpoint-specific error count
        const endpointMetrics = this.metrics.requestsByEndpoint.get(endpoint) || {
            count: 0,
            totalTime: 0,
            minTime: Infinity,
            maxTime: 0,
            errors: 0,
        };
        endpointMetrics.errors++;
        this.metrics.requestsByEndpoint.set(endpoint, endpointMetrics);
    }

    /**
     * Get metrics summary
     */
    getSummary(): MetricsSummary {
        const avgResponseTime = this.metrics.totalRequests > 0
            ? this.metrics.totalResponseTime / this.metrics.successfulRequests
            : 0;

        const successRate = this.metrics.totalRequests > 0
            ? (this.metrics.successfulRequests / this.metrics.totalRequests) * 100
            : 100;

        const totalCacheChecks = this.metrics.cacheHits + this.metrics.cacheMisses;
        const cacheHitRate = totalCacheChecks > 0
            ? (this.metrics.cacheHits / totalCacheChecks) * 100
            : 0;

        const errorRate = this.metrics.totalRequests > 0
            ? (this.metrics.failedRequests / this.metrics.totalRequests) * 100
            : 0;

        // Get top errors
        const topErrors = Array.from(this.metrics.errorsByType.entries())
            .map(([type, count]) => ({ type, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5);

        // Get endpoint stats
        const endpointStats = Array.from(this.metrics.requestsByEndpoint.entries())
            .map(([endpoint, metrics]) => ({
                endpoint,
                avgTime: metrics.count > 0 ? metrics.totalTime / metrics.count : 0,
                count: metrics.count,
            }))
            .sort((a, b) => b.count - a.count);

        return {
            totalRequests: this.metrics.totalRequests,
            successRate,
            averageResponseTime: avgResponseTime,
            minResponseTime: this.metrics.minResponseTime === Infinity ? 0 : this.metrics.minResponseTime,
            maxResponseTime: this.metrics.maxResponseTime,
            cacheHitRate,
            errorRate,
            topErrors,
            endpointStats,
        };
    }

    /**
     * Reset all metrics
     */
    reset(): void {
        this.metrics = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            totalResponseTime: 0,
            minResponseTime: Infinity,
            maxResponseTime: 0,
            cacheHits: 0,
            cacheMisses: 0,
            errorsByType: new Map(),
            requestsByEndpoint: new Map(),
        };
    }

    /**
     * Get raw metrics (for advanced analysis)
     */
    getRawMetrics(): MicroserviceMetrics {
        return { ...this.metrics };
    }

    /**
     * Check if performance is degraded (avg response time > 2s or error rate > 5%)
     */
    isPerformanceDegraded(): boolean {
        const summary = this.getSummary();
        return summary.averageResponseTime > 2000 || summary.errorRate > 5;
    }

    /**
     * Log metrics summary to console
     */
    logSummary(): void {
        const summary = this.getSummary();
        console.log('[MicroserviceMetrics] Performance Summary:');
        console.log(`  Total Requests: ${summary.totalRequests}`);
        console.log(`  Success Rate: ${summary.successRate.toFixed(2)}%`);
        console.log(`  Avg Response Time: ${summary.averageResponseTime.toFixed(2)}ms`);
        console.log(`  Min/Max Response Time: ${summary.minResponseTime}ms / ${summary.maxResponseTime}ms`);
        console.log(`  Cache Hit Rate: ${summary.cacheHitRate.toFixed(2)}%`);
        console.log(`  Error Rate: ${summary.errorRate.toFixed(2)}%`);

        if (summary.topErrors.length > 0) {
            console.log('  Top Errors:');
            summary.topErrors.forEach(({ type, count }) => {
                console.log(`    - ${type}: ${count}`);
            });
        }

        if (this.isPerformanceDegraded()) {
            console.warn('[MicroserviceMetrics] ⚠️  PERFORMANCE DEGRADED');
        }
    }
}

// Singleton instance
export const metricsCollector = new MicroserviceMetricsCollector();

/**
 * Wrapper to track a microservice call
 */
export async function trackMicroserviceCall<T>(
    endpoint: string,
    operation: () => Promise<T>
): Promise<T> {
    const startTime = Date.now();
    try {
        const result = await operation();
        const responseTime = Date.now() - startTime;
        metricsCollector.recordRequest(endpoint, responseTime);
        return result;
    } catch (error) {
        const errorType = error instanceof Error ? error.constructor.name : 'UnknownError';
        metricsCollector.recordError(endpoint, errorType);
        throw error;
    }
}
