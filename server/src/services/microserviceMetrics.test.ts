import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getMicroserviceMetrics,
  isMicroserviceAvailable,
  logMicroserviceMetrics,
  resetMicroserviceMetrics,
} from './scryfallMicroserviceClient.js';
import { metricsCollector, trackMicroserviceCall } from './microserviceMetrics.js';

describe('microservice metrics', () => {
  beforeEach(() => {
    resetMicroserviceMetrics();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetMicroserviceMetrics();
  });

  it('records successful, failed, cache-hit, and cache-miss request summaries', async () => {
    metricsCollector.recordRequest('/cards', 120, true);
    metricsCollector.recordRequest('/cards', 80, false);
    metricsCollector.recordError('/cards', 'TypeError');
    metricsCollector.recordError('/other', 'TypeError');
    metricsCollector.recordError('/other', 'RangeError');

    const summary = metricsCollector.getSummary();
    expect(summary).toMatchObject({
      totalRequests: 5,
      successRate: 40,
      averageResponseTime: 100,
      minResponseTime: 80,
      maxResponseTime: 120,
      cacheHitRate: 50,
      errorRate: 60,
    });
    expect(summary.topErrors).toEqual([
      { type: 'TypeError', count: 2 },
      { type: 'RangeError', count: 1 },
    ]);
    expect(summary.endpointStats[0]).toEqual({ endpoint: '/cards', avgTime: 100, count: 2 });
    expect(metricsCollector.getRawMetrics().failedRequests).toBe(3);
    expect(metricsCollector.isPerformanceDegraded()).toBe(true);
  });

  it('returns zeroed/default metrics after reset', () => {
    metricsCollector.recordRequest('/slow', 3000);
    metricsCollector.reset();

    expect(metricsCollector.getSummary()).toMatchObject({
      totalRequests: 0,
      successRate: 100,
      averageResponseTime: 0,
      minResponseTime: 0,
      maxResponseTime: 0,
      cacheHitRate: 0,
      errorRate: 0,
      topErrors: [],
      endpointStats: [],
    });
    expect(metricsCollector.isPerformanceDegraded()).toBe(false);
  });

  it('tracks async operations and rethrows failures', async () => {
    const success = await trackMicroserviceCall('/health', async () => 'ok');
    expect(success).toBe('ok');

    await expect(trackMicroserviceCall('/health', async () => {
      throw new TypeError('boom');
    })).rejects.toThrow('boom');

    expect(getMicroserviceMetrics()).toMatchObject({ totalRequests: 2, successRate: 50, errorRate: 50 });
  });

  it('logs summaries and degraded warnings', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    metricsCollector.recordRequest('/slow', 3001);
    metricsCollector.recordError('/slow', 'TypeError');

    logMicroserviceMetrics();

    expect(logSpy).toHaveBeenCalledWith('[MicroserviceMetrics] Performance Summary:');
    expect(logSpy).toHaveBeenCalledWith('  Top Errors:');
    expect(logSpy).toHaveBeenCalledWith('    - TypeError: 1');
    expect(warnSpy).toHaveBeenCalledWith('[MicroserviceMetrics] ⚠️  PERFORMANCE DEGRADED');
  });

  it('reports microservice availability success and failure', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    resetMicroserviceMetrics();
    await expect(isMicroserviceAvailable()).resolves.toBe(true);

    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('offline'));
    await expect(isMicroserviceAvailable()).resolves.toBe(false);
    globalThis.fetch = originalFetch;
  });
});
