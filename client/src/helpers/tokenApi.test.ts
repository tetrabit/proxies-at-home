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

  it('does not retry non-429 4xx responses and wraps the error', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    const result = await fetchTokenParts([{ name: 'Missing' }]);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toBe('Token fetch failed: 404');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries retryable failures and wraps unknown thrown values', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.mocked(global.fetch)
      .mockResolvedValueOnce({ ok: false, status: 429 } as Response)
      .mockRejectedValueOnce('boom')
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as Response);

    const promise = fetchTokenParts([{ name: 'Retry' }]);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ success: true, data: [] });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('propagates AbortError without wrapping', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    vi.mocked(global.fetch).mockRejectedValueOnce(abortError);

    await expect(fetchTokenParts([{ name: 'Abort' }])).rejects.toBe(abortError);
  });
});
