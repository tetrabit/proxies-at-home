import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_RETRY_CONFIG,
  calculateRetryDelay,
  DEFAULT_RETRY_CONFIG,
  isRetryableError,
  withRetry,
  type RetryConfig,
} from './retryUtils';

describe('retryUtils', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exports default and API retry presets', () => {
    expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3);
    expect(API_RETRY_CONFIG.baseDelayMs).toBe(500);
  });

  it('calculates capped exponential delays with positive and negative jitter clamped to zero', () => {
    const config: RetryConfig = { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 250, multiplier: 3, jitterFactor: 0.5 };
    expect(calculateRetryDelay(0, config)).toBe(100);

    vi.mocked(Math.random).mockReturnValueOnce(1);
    expect(calculateRetryDelay(2, config)).toBe(375);

    vi.mocked(Math.random).mockReturnValueOnce(0);
    expect(calculateRetryDelay(2, { ...config, jitterFactor: 2 })).toBe(0);
  });

  it('recognizes retryable network, timeout, fetch, 429, and TypeError failures', () => {
    expect(isRetryableError(new TypeError('failed to fetch'))).toBe(true);
    expect(isRetryableError(new Error('HTTP 429'))).toBe(true);
    expect(isRetryableError(new Error('timeout exceeded'))).toBe(true);
    expect(isRetryableError(new Error('network down'))).toBe(true);
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableError(new Error('validation failed'))).toBe(false);
    expect(isRetryableError('network')).toBe(false);
  });

  it('returns immediately on success without scheduling retries', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries retryable errors and eventually succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('recovered');

    const promise = withRetry(fn, { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 10, multiplier: 1, jitterFactor: 0 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('stops when the retry predicate rejects or retries are exhausted', async () => {
    const nonRetry = new Error('bad request');
    await expect(withRetry(vi.fn().mockRejectedValue(nonRetry), DEFAULT_RETRY_CONFIG, () => false)).rejects.toBe(nonRetry);

    const exhausted = new Error('network');
    const fn = vi.fn().mockRejectedValue(exhausted);
    const promise = withRetry(fn, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, multiplier: 1, jitterFactor: 0 });
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toBe(exhausted);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
