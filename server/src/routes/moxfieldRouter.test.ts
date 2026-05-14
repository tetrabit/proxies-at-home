import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { moxfieldRouter } from './moxfieldRouter.js';

const app = express();
app.use('/api/moxfield', moxfieldRouter);

describe('moxfieldRouter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('rejects deck IDs outside the supported format', async () => {
    const response = await request(app).get('/api/moxfield/decks/bad.id');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid deck ID' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches and caches a deck response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'abc_123' }) } as Response);

    const first = await request(app).get('/api/moxfield/decks/abc_123');
    const second = await request(app).get('/api/moxfield/decks/abc_123');

    expect(first.status).toBe(200);
    expect(second.body).toEqual({ id: 'abc_123' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://api2.moxfield.com/v2/decks/all/abc_123', expect.objectContaining({
      headers: expect.objectContaining({ 'User-Agent': 'PostmanRuntime/7.31.1' }),
    }));
  });

  it('refreshes expired cache entries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ version: 1 }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ version: 2 }) } as Response);

    await request(app).get('/api/moxfield/decks/cache-test');
    vi.setSystemTime(5 * 60 * 1000 + 1);
    const response = await request(app).get('/api/moxfield/decks/cache-test');

    expect(response.body).toEqual({ version: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('forwards 404 and non-404 upstream statuses', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 429 } as Response);

    const notFound = await request(app).get('/api/moxfield/decks/missing');
    const rateLimited = await request(app).get('/api/moxfield/decks/rate-limited');

    expect(notFound.status).toBe(404);
    expect(notFound.body.error).toBe('Deck not found. It may be private or deleted.');
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.body.error).toBe('Moxfield API error: 429');
  });

  it('returns 500 when fetch throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network'));

    const response = await request(app).get('/api/moxfield/decks/network');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to fetch deck from Moxfield' });
  });
});
