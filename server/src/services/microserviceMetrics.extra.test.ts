import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { metricsCollector, trackMicroserviceCall } from './microserviceMetrics.js';

describe('microserviceMetrics additional coverage', () => {
  beforeEach(() => metricsCollector.reset());
  afterEach(() => vi.restoreAllMocks());

  it('summarizes empty, successful, cache-hit, and failed calls', async () => {
    expect(metricsCollector.getSummary()).toMatchObject({
      totalRequests: 0,
      successRate: 100,
      averageResponseTime: 0,
      cacheHitRate: 0,
      errorRate: 0,
    });

    metricsCollector.recordRequest('/cards/named', 100, true);
    metricsCollector.recordRequest('/cards/search', 300, false);
    metricsCollector.recordError('/cards/search', 'TimeoutError');
    metricsCollector.recordError('/cards/search', 'TimeoutError');

    const summary = metricsCollector.getSummary();
    expect(summary.totalRequests).toBe(4);
    expect(summary.successRate).toBe(50);
    expect(summary.cacheHitRate).toBe(50);
    expect(summary.errorRate).toBe(50);
    expect(summary.topErrors).toEqual([{ type: 'TimeoutError', count: 2 }]);
    expect(summary.endpointStats[0]).toMatchObject({ endpoint: '/cards/search', count: 1, avgTime: 300 });
    expect(metricsCollector.isPerformanceDegraded()).toBe(true);
    expect(metricsCollector.getRawMetrics().failedRequests).toBe(2);
  });

  it('tracks successful and failed wrapped calls', async () => {
    await expect(trackMicroserviceCall('/ok', async () => 'done')).resolves.toBe('done');
    await expect(trackMicroserviceCall('/bad', async () => { throw new TypeError('bad'); })).rejects.toThrow('bad');

    const summary = metricsCollector.getSummary();
    expect(summary.totalRequests).toBe(2);
    expect(summary.topErrors).toEqual([{ type: 'TypeError', count: 1 }]);
  });

  it('logs summaries and degraded warnings', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    metricsCollector.recordRequest('/slow', 2500);

    metricsCollector.logSummary();

    expect(logSpy).toHaveBeenCalledWith('[MicroserviceMetrics] Performance Summary:');
    expect(warnSpy).toHaveBeenCalledWith('[MicroserviceMetrics] ⚠️  PERFORMANCE DEGRADED');
  });
});
