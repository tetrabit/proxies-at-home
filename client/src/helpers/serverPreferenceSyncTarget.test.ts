import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MpcPreferenceFixture } from '@/types';
import { serverPreferenceSyncTarget } from './serverPreferenceSyncTarget';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const fixture: MpcPreferenceFixture = {
  version: 1,
  exportedAt: '2026-04-18T12:00:00.000Z',
  cases: [],
};

describe('serverPreferenceSyncTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when the server reports no preference file', async () => {
    mockFetch.mockResolvedValue({
      status: 404,
      ok: false,
      statusText: 'Not Found',
    });

    await expect(serverPreferenceSyncTarget.load()).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledWith('/api/preferences');
  });

  it('loads a fixture from the server', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(fixture),
    });

    await expect(serverPreferenceSyncTarget.load()).resolves.toEqual(fixture);
  });

  it('writes a fixture with PUT', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      statusText: 'OK',
    });

    await expect(serverPreferenceSyncTarget.write(fixture)).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith('/api/preferences', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(fixture),
    });
  });

  it('throws on failed writes', async () => {
    mockFetch.mockResolvedValue({
      status: 500,
      ok: false,
      statusText: 'Server Error',
    });

    await expect(serverPreferenceSyncTarget.write(fixture)).rejects.toThrow(
      'Failed to save preferences: 500 Server Error'
    );
  });

  it('describes the server target', () => {
    expect(serverPreferenceSyncTarget.describe()).toBe('Server');
  });
});
