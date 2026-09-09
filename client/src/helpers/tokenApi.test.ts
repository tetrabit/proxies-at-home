import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchTokenParts } from './tokenApi';

vi.mock('@/constants', () => ({ API_BASE: 'http://api.test' }));

describe('tokenApi', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn();
  });

  it('returns an empty success without fetching for an empty card list', async () => {
    await expect(fetchTokenParts([])).resolves.toEqual({ success: true, data: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('posts cards and returns token part data', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({ ok: true, json: async () => [{ name: 'Card', token_parts: [{ name: 'Token' }] }] } as Response);
    const signal = new AbortController().signal;

    const result = await fetchTokenParts([{ name: 'Card', set: 'abc', number: '1' }], signal);

    expect(global.fetch).toHaveBeenCalledWith('http://api.test/api/cards/images/tokens', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cards: [{ name: 'Card', set: 'abc', number: '1' }] }),
      signal,
    }));
    expect(result).toEqual({ success: true, data: [{ name: 'Card', token_parts: [{ name: 'Token' }] }] });
  });

  it('serially chunks more than 200 token requests at 100 cards and preserves response order and duplicates', async () => {
    const requests: Array<Array<{ name: string; set?: string; number?: string }>> = [];
    let releaseFirstRequest!: () => void;
    const firstRequestStarted = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let activeRequests = 0;
    let maxActiveRequests = 0;

    vi.mocked(global.fetch).mockImplementation(async (_input, init) => {
      activeRequests++;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      const cards = JSON.parse(String(init?.body)).cards as Array<{ name: string; set?: string; number?: string }>;
      requests.push(cards);
      if (requests.length === 1) await firstRequestStarted;
      activeRequests--;
      return {
        ok: true,
        json: async () => cards.map((card) => ({ ...card, token_parts: [{ name: `Token for ${card.name}` }] })),
      } as Response;
    });
    const cards = Array.from({ length: 201 }, (_, index) => ({
      name: index === 200 ? 'Card 0' : `Card ${index}`,
      set: 'MPC',
      number: String(index),
    }));

    const resultPromise = fetchTokenParts(cards);

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual(cards.slice(0, 100));
    releaseFirstRequest();

    await expect(resultPromise).resolves.toEqual({
      success: true,
      data: cards.map((card) => ({ ...card, token_parts: [{ name: `Token for ${card.name}` }] })),
    });
    expect(requests.map((request) => request.length)).toEqual([100, 100, 1]);
    expect(maxActiveRequests).toBe(1);
  });

  it('stops before a later token chunk when the signal is aborted after the first request', async () => {
    const controller = new AbortController();
    const abortError = new Error('cancelled between chunks');
    abortError.name = 'AbortError';
    let requests = 0;

    vi.mocked(global.fetch).mockImplementation(async () => {
      requests++;
      controller.abort(abortError);
      return { ok: true, json: async () => [] } as Response;
    });

    await expect(
      fetchTokenParts(Array.from({ length: 101 }, (_, index) => ({ name: `Card ${index}` })), controller.signal)
    ).rejects.toBe(abortError);
    expect(requests).toBe(1);
  });

  it('returns the later chunk failure and does not start remaining token requests', async () => {
    let requests = 0;
    vi.mocked(global.fetch).mockImplementation(async () => {
      requests++;
      return requests === 2
        ? ({ ok: false, status: 400 } as Response)
        : ({ ok: true, json: async () => [] } as Response);
    });

    const result = await fetchTokenParts(Array.from({ length: 201 }, (_, index) => ({ name: `Card ${index}` })));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toBe('Token fetch failed: 400');
    expect(requests).toBe(2);
  });

  it('does not retry non-429 4xx responses and wraps the error', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    const result = await fetchTokenParts([{ name: 'Missing' }]);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toBe('Token fetch failed: 404');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries retryable 429 failures and then succeeds', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.mocked(global.fetch)
      .mockResolvedValueOnce({ ok: false, status: 429 } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as Response);

    const promise = fetchTokenParts([{ name: 'Retry' }]);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ success: true, data: [] });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('wraps unknown thrown values as errors', async () => {
    vi.mocked(global.fetch).mockRejectedValueOnce('boom');
    const result = await fetchTokenParts([{ name: 'Unknown failure' }]);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toBe('boom');
  });

  it('handles 4xx-looking errors without a parseable status', async () => {
    vi.mocked(global.fetch).mockRejectedValueOnce(new Error('4xx'));
    const result = await fetchTokenParts([{ name: 'Ambiguous 4xx' }]);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toBe('4xx');
  });

  it('propagates AbortError without wrapping', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    vi.mocked(global.fetch).mockRejectedValueOnce(abortError);

    await expect(fetchTokenParts([{ name: 'Abort' }])).rejects.toBe(abortError);
  });
});
