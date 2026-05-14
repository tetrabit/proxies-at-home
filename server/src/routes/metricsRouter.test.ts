import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const serviceMocks = vi.hoisted(() => ({
  getMicroserviceMetrics: vi.fn(),
  logMicroserviceMetrics: vi.fn(),
  resetMicroserviceMetrics: vi.fn(),
}));
const { getMicroserviceMetrics, logMicroserviceMetrics, resetMicroserviceMetrics } = serviceMocks;

vi.mock('../services/scryfallMicroserviceClient.ts', () => ({
  getMicroserviceMetrics: serviceMocks.getMicroserviceMetrics,
  logMicroserviceMetrics: serviceMocks.logMicroserviceMetrics,
  resetMicroserviceMetrics: serviceMocks.resetMicroserviceMetrics,
}));

const { default: metricsRouter } = await import('./metricsRouter.js');

const app = express();
app.use('/api/metrics', metricsRouter);

describe('metricsRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getMicroserviceMetrics.mockReturnValue({ averageResponseTime: 100, errorRate: 1, requests: 3 });
  });

  it('returns metrics with a timestamp', async () => {
    const response = await request(app).get('/api/metrics');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toEqual({ averageResponseTime: 100, errorRate: 1, requests: 3 });
    expect(response.body.timestamp).toEqual(expect.any(String));
  });

  it('reports metric read failures', async () => {
    getMicroserviceMetrics.mockImplementationOnce(() => { throw new Error('boom'); });
    const response = await request(app).get('/api/metrics');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ success: false, error: 'boom' });
  });

  it('logs metrics and reports log failures', async () => {
    const ok = await request(app).post('/api/metrics/log');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true, message: 'Metrics logged to console' });
    expect(logMicroserviceMetrics).toHaveBeenCalledOnce();

    logMicroserviceMetrics.mockImplementationOnce(() => { throw 'nope'; });
    const failed = await request(app).post('/api/metrics/log');
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ success: false, error: 'Failed to log metrics' });
  });

  it('resets metrics and reports reset failures', async () => {
    const ok = await request(app).post('/api/metrics/reset');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true, message: 'Metrics reset successfully' });
    expect(resetMicroserviceMetrics).toHaveBeenCalledOnce();

    resetMicroserviceMetrics.mockImplementationOnce(() => { throw new Error('cannot reset'); });
    const failed = await request(app).post('/api/metrics/reset');
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ success: false, error: 'cannot reset' });
  });

  it('reports healthy, degraded, and health-check failure states', async () => {
    const healthy = await request(app).get('/api/metrics/health');
    expect(healthy.status).toBe(200);
    expect(healthy.body.data.status).toBe('healthy');
    expect(healthy.body.data.degraded).toBe(false);

    getMicroserviceMetrics.mockReturnValueOnce({ averageResponseTime: 2500, errorRate: 1 });
    const slow = await request(app).get('/api/metrics/health');
    expect(slow.body.data.status).toBe('degraded');
    expect(slow.body.data.recommendation).toContain('degraded');

    getMicroserviceMetrics.mockReturnValueOnce({ averageResponseTime: 100, errorRate: 6 });
    const errorRate = await request(app).get('/api/metrics/health');
    expect(errorRate.body.data.status).toBe('degraded');

    getMicroserviceMetrics.mockImplementationOnce(() => { throw 'bad'; });
    const failed = await request(app).get('/api/metrics/health');
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ success: false, error: 'Failed to check health' });
  });
});
