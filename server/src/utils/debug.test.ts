import { afterEach, describe, expect, it, vi } from 'vitest';

describe('debug utilities', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.NODE_ENV;
  });

  it('logs only when NODE_ENV is development at import time', async () => {
    process.env.NODE_ENV = 'development';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dev = await import('./debug.js');
    expect(dev.DEBUG).toBe(true);
    dev.debugLog('hello', { debug: true });
    expect(logSpy).toHaveBeenCalledWith('hello', { debug: true });

    vi.resetModules();
    logSpy.mockClear();
    process.env.NODE_ENV = 'test';
    const prod = await import('./debug.js');
    expect(prod.DEBUG).toBe(false);
    prod.debugLog('hidden');
    expect(logSpy).not.toHaveBeenCalled();
  });
});
