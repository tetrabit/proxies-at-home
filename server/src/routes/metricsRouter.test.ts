import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('@tetrabit/scryfall-cache-client', () => ({
  ScryfallCacheClient: class {
    health = vi.fn();
  },
}));

const service = await import('../services/scryfallMicroserviceClient.js');
const getMetricsSpy = vi.spyOn(service, 'getMicroserviceMetrics');
const logMetricsSpy = vi.spyOn(service, 'logMicroserviceMetrics');
const resetMetricsSpy = vi.spyOn(service, 'resetMicroserviceMetrics');
const { default: metricsRouter } = await import('./metricsRouter.js');

const app = express();
app.use('/api/metrics', metricsRouter);

describe('metricsRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getMetricsSpy.mockReturnValue({ averageResponseTime: 100, errorRate: 1, requests: 3 } as never);
  });

  it('returns metrics with a timestamp', async () => {
    const response = await request(app).get('/api/metrics');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toEqual({ averageResponseTime: 100, errorRate: 1, requests: 3 });
    expect(response.body.timestamp).toEqual(expect.any(String));
  });

  it('reports metric read failures', async () => {
    getMetricsSpy.mockImplementationOnce(() => { throw new Error('boom'); });
    const response = await request(app).get('/api/metrics');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ success: false, error: 'boom' });
  });

  it('logs metrics and reports log failures', async () => {
    const ok = await request(app).post('/api/metrics/log');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true, message: 'Metrics logged to console' });
    expect(logMetricsSpy).toHaveBeenCalledOnce();

    logMetricsSpy.mockImplementationOnce(() => { throw 'nope'; });
    const failed = await request(app).post('/api/metrics/log');
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ success: false, error: 'Failed to log metrics' });
  });

  it('resets metrics and reports reset failures', async () => {
    const ok = await request(app).post('/api/metrics/reset');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true, message: 'Metrics reset successfully' });
    expect(resetMetricsSpy).toHaveBeenCalledOnce();

    resetMetricsSpy.mockImplementationOnce(() => { throw new Error('cannot reset'); });
    const failed = await request(app).post('/api/metrics/reset');
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ success: false, error: 'cannot reset' });
  });

  it('reports healthy, degraded, and health-check failure states', async () => {
    const healthy = await request(app).get('/api/metrics/health');
    expect(healthy.status).toBe(200);
    expect(healthy.body.data.status).toBe('healthy');
    expect(healthy.body.data.degraded).toBe(false);

    getMetricsSpy.mockReturnValueOnce({ averageResponseTime: 2500, errorRate: 1 } as never);
    const slow = await request(app).get('/api/metrics/health');
    expect(slow.body.data.status).toBe('degraded');
    expect(slow.body.data.recommendation).toContain('degraded');

    getMetricsSpy.mockReturnValueOnce({ averageResponseTime: 100, errorRate: 6 } as never);
    const errorRate = await request(app).get('/api/metrics/health');
    expect(errorRate.body.data.status).toBe('degraded');

    getMetricsSpy.mockImplementationOnce(() => { throw 'bad'; });
    const failed = await request(app).get('/api/metrics/health');
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ success: false, error: 'Failed to check health' });
  });
});
