import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  ScryfallCacheClient: vi.fn(),
}));

vi.mock('@tetrabit/scryfall-cache-client', () => ({
  ScryfallCacheClient: mocks.ScryfallCacheClient,
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

describe('scryfall microservice health checks', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.health.mockReset();
    mocks.ScryfallCacheClient.mockReset().mockImplementation(function () {
      return { health: mocks.health };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('coalesces concurrent health checks into one tracked microservice call', async () => {
    const healthDeferred = createDeferred<unknown>();
    mocks.health.mockReturnValueOnce(healthDeferred.promise);
    const { getMicroserviceMetrics, isMicroserviceAvailable, resetMicroserviceMetrics } = await import('./scryfallMicroserviceClient.js');
    resetMicroserviceMetrics();

    const first = isMicroserviceAvailable();
    const second = isMicroserviceAvailable();

    expect(mocks.health).toHaveBeenCalledTimes(1);

    healthDeferred.resolve({ ok: true });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(getMicroserviceMetrics()).toMatchObject({
      totalRequests: 1,
      successRate: 100,
      errorRate: 0,
    });
  });

  it('returns a fresh successful health result without another probe or metric', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    mocks.health.mockResolvedValue({ ok: true });
    const { getMicroserviceMetrics, isMicroserviceAvailable, resetMicroserviceMetrics } = await import('./scryfallMicroserviceClient.js');
    resetMicroserviceMetrics();

    await expect(isMicroserviceAvailable()).resolves.toBe(true);
    await expect(isMicroserviceAvailable()).resolves.toBe(true);

    expect(mocks.health).toHaveBeenCalledTimes(1);
    expect(getMicroserviceMetrics()).toMatchObject({
      totalRequests: 1,
      successRate: 100,
      errorRate: 0,
    });
  });

  it('rechecks health after the successful result expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    mocks.health.mockResolvedValue({ ok: true });
    const { getMicroserviceMetrics, isMicroserviceAvailable, resetMicroserviceMetrics } = await import('./scryfallMicroserviceClient.js');
    resetMicroserviceMetrics();

    await expect(isMicroserviceAvailable()).resolves.toBe(true);
    vi.setSystemTime(10_999);
    await expect(isMicroserviceAvailable()).resolves.toBe(true);
    vi.setSystemTime(11_000);
    await expect(isMicroserviceAvailable()).resolves.toBe(true);

    expect(mocks.health).toHaveBeenCalledTimes(2);
    expect(getMicroserviceMetrics()).toMatchObject({ totalRequests: 2, successRate: 100 });
  });

  it('clears a failed in-flight health check so a later check can recover', async () => {
    const healthDeferred = createDeferred<unknown>();
    mocks.health
      .mockReturnValueOnce(healthDeferred.promise)
      .mockResolvedValueOnce({ ok: true });
    const { isMicroserviceAvailable, resetMicroserviceMetrics } = await import('./scryfallMicroserviceClient.js');
    resetMicroserviceMetrics();

    const first = isMicroserviceAvailable();
    const second = isMicroserviceAvailable();
    healthDeferred.reject(new Error('offline'));

    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);

    await expect(isMicroserviceAvailable()).resolves.toBe(true);
    expect(mocks.health).toHaveBeenCalledTimes(2);
  });
});
