/**
 * Metrics Router
 *
 * Provides endpoints for monitoring microservice performance
 */

import { Router, Request, Response } from 'express';
import { createPrivateRouteAuth } from '../auth/privateRouteAuth.js';
import { getMicroserviceMetrics, logMicroserviceMetrics, resetMicroserviceMetrics } from '../services/scryfallMicroserviceClient.js';

/**
 * Builds the metrics router with the server's private authorization seam.
 * A caller without an injected verifier gets the fail-closed default export.
 */
export function createMetricsRouter(privateRouteAuth: ReturnType<typeof createPrivateRouteAuth>) {
const router = Router();

/**
 * GET /api/metrics
 * Get current microservice performance metrics
 */
router.get('/', privateRouteAuth.private('metrics:read'), (_req: Request, res: Response) => {
    try {
        const metrics = getMicroserviceMetrics();
        res.json({
            success: true,
            data: metrics,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error('Error getting metrics:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to get metrics',
        });
    }
});

/**
 * POST /api/metrics/log
 * Log current metrics to console
 */
router.post('/log', privateRouteAuth.private('metrics:write'), (_req: Request, res: Response) => {
    try {
        logMicroserviceMetrics();
        res.json({
            success: true,
            message: 'Metrics logged to console',
        });
    } catch (error) {
        console.error('Error logging metrics:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to log metrics',
        });
    }
});

/**
 * POST /api/metrics/reset
 * Reset all metrics counters
 */
router.post('/reset', privateRouteAuth.private('metrics:write'), (_req: Request, res: Response) => {
    try {
        resetMicroserviceMetrics();
        res.json({
            success: true,
            message: 'Metrics reset successfully',
        });
    } catch (error) {
        console.error('Error resetting metrics:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to reset metrics',
        });
    }
});

/**
 * GET /api/metrics/health
 * Check if performance is degraded (avg response time > 2s or error rate > 5%)
 */
router.get('/health', privateRouteAuth.private('metrics:read'), (_req: Request, res: Response) => {
    try {
        const metrics = getMicroserviceMetrics();
        const isDegraded = metrics.averageResponseTime > 2000 || metrics.errorRate > 5;

        res.json({
            success: true,
            data: {
                status: isDegraded ? 'degraded' : 'healthy',
                degraded: isDegraded,
                averageResponseTime: metrics.averageResponseTime,
                errorRate: metrics.errorRate,
                recommendation: isDegraded
                    ? 'Performance is degraded. Check metrics for details.'
                    : 'Performance is within acceptable ranges.',
            },
        });
    } catch (error) {
        console.error('Error checking health:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to check health',
        });
    }
});

return router;
}

export default createMetricsRouter(createPrivateRouteAuth({ verifyBearer: () => null }));
