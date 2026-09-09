import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MpcPreferenceFixture } from '@/types';
import { PrivateApiIdentityUnavailableError } from './privateApi';
import { serverPreferenceSyncTarget } from './serverPreferenceSyncTarget';

const mockFetch = vi.fn();

const fixture: MpcPreferenceFixture = {
  version: 1,
  exportedAt: '2026-04-18T12:00:00.000Z',
  cases: [],
};

describe('serverPreferenceSyncTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal('electronAPI', {
      getPrivateApiBootstrap: vi.fn().mockResolvedValue({
        baseUrl: 'http://127.0.0.1:4555',
        bearer: 'preference-test-bearer',
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails locally with a typed identity error when no private identity is configured', async () => {
    vi.stubGlobal('electronAPI', undefined);

    await expect(serverPreferenceSyncTarget.load()).rejects.toBeInstanceOf(
      PrivateApiIdentityUnavailableError
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null when the server reports no preference file', async () => {
    mockFetch.mockResolvedValue({
      status: 404,
      ok: false,
      statusText: 'Not Found',
    });

    await expect(serverPreferenceSyncTarget.load()).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4555/api/preferences');
    const options = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(options).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(new Headers(options.headers).get('Authorization')).toBe('Bearer preference-test-bearer');
  });

  it('loads a fixture from the server', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(fixture),
    });

    await expect(serverPreferenceSyncTarget.load()).resolves.toEqual(fixture);
  });

  it('throws on invalid fixture shapes from the server', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ version: '1', exportedAt: 123, cases: null }),
    });

    await expect(serverPreferenceSyncTarget.load()).rejects.toThrow(
      'Invalid preference fixture response'
    );
  });

  it('throws on non-record fixture payloads', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(null),
    });

    await expect(serverPreferenceSyncTarget.load()).rejects.toThrow(
      'Invalid preference fixture response'
    );
  });

  it('throws on load failures that are not 404s', async () => {
    mockFetch.mockResolvedValue({
      status: 500,
      ok: false,
      statusText: 'Server Error',
    });

    await expect(serverPreferenceSyncTarget.load()).rejects.toThrow(
      'Failed to load preferences: 500 Server Error'
    );
  });

  it('writes a fixture with PUT', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      statusText: 'OK',
    });

    await expect(serverPreferenceSyncTarget.write(fixture)).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4555/api/preferences');
    const options = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(options).toMatchObject({
      method: 'PUT',
      body: JSON.stringify(fixture),
      credentials: 'omit',
      redirect: 'error',
    });
    expect(new Headers(options.headers).get('Content-Type')).toBe('application/json');
    expect(new Headers(options.headers).get('Authorization')).toBe('Bearer preference-test-bearer');
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
