import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScryfallCacheClient } from './index';

const jsonPayload = { object: 'list', data: [] };

function mockFetch(response: Partial<Response>) {
  const fetchMock = vi.fn(async () => response as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ScryfallCacheClient', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('merges JSON headers with caller headers and parses successful responses', async () => {
    const fetchMock = mockFetch({
      ok: true,
      json: vi.fn(async () => jsonPayload),
    });
    const client = new ScryfallCacheClient({ baseUrl: 'http://cache.test' });

    await expect(
      client.searchCards({ q: 'name:sol', page: 2 } as never, {
        headers: { Authorization: 'Bearer token' },
      })
    ).resolves.toEqual(jsonPayload);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://cache.test/cards/search?q=name%3Asol&page=2',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
      })
    );
  });

  it('routes named, id, autocomplete, stats, and health requests to their API paths', async () => {
    const fetchMock = mockFetch({
      ok: true,
      json: vi.fn(async () => ({ ok: true })),
    });
    const client = new ScryfallCacheClient({ baseUrl: 'http://cache.test' });

    await client.getCardByName({ exact: 'Black Lotus' } as never);
    await client.getCard('card-1');
    await client.autocomplete({ q: 'ligh' });
    await client.getStats();
    await client.health();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://cache.test/cards/named?exact=Black+Lotus',
      'http://cache.test/cards/card-1',
      'http://cache.test/cards/autocomplete?q=ligh',
      'http://cache.test/stats',
      'http://cache.test/health',
    ]);
  });

  it('throws an API error when the response is not ok', async () => {
    mockFetch({
      ok: false,
      statusText: 'Bad Gateway',
      json: vi.fn(),
    });
    const client = new ScryfallCacheClient({ baseUrl: 'http://cache.test' });

    await expect(client.getCard('missing')).rejects.toThrow(
      'API request failed: Bad Gateway'
    );
  });

  it('aborts a pending response when the configured timeout expires', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options?: RequestInit) => {
        requestSignal = options?.signal ?? undefined;
        return new Promise<Response>(() => {});
      })
    );
    const client = new ScryfallCacheClient({ baseUrl: 'http://cache.test', timeout: 50 });
    let outcome: unknown;

    void client.getStats().then(
      () => {
        outcome = 'fulfilled';
      },
      (error: unknown) => {
        outcome = error;
      }
    );

    await vi.advanceTimersByTimeAsync(50);

    expect(requestSignal?.aborted).toBe(true);
    expect(outcome).toMatchObject({ name: 'TimeoutError' });
  });

  it('aborts a stalled response body when the configured timeout expires', async () => {
    vi.useFakeTimers();
    const json = vi.fn(() => new Promise<never>(() => {}));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json }) as unknown as Response)
    );
    const client = new ScryfallCacheClient({ baseUrl: 'http://cache.test', timeout: 50 });
    let outcome: unknown;

    void client.getStats().then(
      () => {
        outcome = 'fulfilled';
      },
      (error: unknown) => {
        outcome = error;
      }
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(json).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(50);

    expect(outcome).toMatchObject({ name: 'TimeoutError' });
  });

  it('uses the caller abort reason when it aborts a stalled response body first', async () => {
    vi.useFakeTimers();
    const json = vi.fn(() => new Promise<never>(() => {}));
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options?: RequestInit) => {
        requestSignal = options?.signal ?? undefined;
        return { ok: true, json } as unknown as Response;
      })
    );
    const client = new ScryfallCacheClient({ baseUrl: 'http://cache.test', timeout: 50 });
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, 'removeEventListener');
    const callerReason = new DOMException('The caller cancelled', 'AbortError');
    let outcome: unknown;

    void client.getStats({ signal: caller.signal }).then(
      () => {
        outcome = 'fulfilled';
      },
      (error: unknown) => {
        outcome = error;
      }
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(json).toHaveBeenCalledOnce();

    caller.abort(callerReason);
    await vi.advanceTimersByTimeAsync(0);

    expect(requestSignal?.aborted).toBe(true);
    expect(outcome).toBe(callerReason);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('rejects without starting fetch when the caller signal is already aborted', async () => {
    const caller = new AbortController();
    const callerReason = new DOMException('The caller cancelled', 'AbortError');
    caller.abort(callerReason);
    const fetchMock = mockFetch({ ok: true, json: vi.fn(async () => jsonPayload) });
    const client = new ScryfallCacheClient({ baseUrl: 'http://cache.test', timeout: 50 });

    await expect(client.getStats({ signal: caller.signal })).rejects.toBe(callerReason);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cleans its timer and caller listener after a successful response', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, 'removeEventListener');
    mockFetch({ ok: true, json: vi.fn(async () => jsonPayload) });
    const client = new ScryfallCacheClient({ baseUrl: 'http://cache.test', timeout: 50 });

    await expect(client.getStats({ signal: caller.signal })).resolves.toEqual(jsonPayload);

    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('cleans its timer and caller listener after a fetch failure', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const removeListener = vi.spyOn(caller.signal, 'removeEventListener');
    const failure = new Error('Network failed');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(failure)));
    const client = new ScryfallCacheClient({ baseUrl: 'http://cache.test', timeout: 50 });

    await expect(client.getStats({ signal: caller.signal })).rejects.toBe(failure);

    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
