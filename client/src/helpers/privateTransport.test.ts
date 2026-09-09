import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mockFetch = vi.fn();

type PrivateTransportModule = typeof import('./privateTransport');
type PrivateApiModule = typeof import('./privateApi');

async function loadPrivateTransport(): Promise<{
  privateTransport: PrivateTransportModule;
  privateApi: PrivateApiModule;
}> {
  vi.resetModules();
  const [privateTransport, privateApi] = await Promise.all([
    import('./privateTransport'),
    import('./privateApi'),
  ]);
  return { privateTransport, privateApi };
}

describe('privateTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lazily binds the Electron bootstrap origin and retains the memory-only bootstrap for subsequent private calls', async () => {
    const bootstrap = vi.fn().mockResolvedValue({
      baseUrl: 'http://127.0.0.1:4555',
      bearer: 'synthetic-private-bearer',
    });
    vi.stubGlobal('electronAPI', { getPrivateApiBootstrap: bootstrap });
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const { privateTransport: { privateFetch } } = await loadPrivateTransport();

    await privateFetch('/api/preferences');
    await privateFetch('/api/printer-calibration/profiles');

    expect(bootstrap).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4555/api/preferences');
    expect(mockFetch.mock.calls[1]?.[0]).toBe('http://127.0.0.1:4555/api/printer-calibration/profiles');
    expect(mockFetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
    });
    expect(new Headers(mockFetch.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer synthetic-private-bearer'
    );
  });

  it('fails with the typed identity error before fetching when no browser identity is configured', async () => {
    const {
      privateTransport: { privateFetch },
      privateApi: { PrivateApiIdentityUnavailableError },
    } = await loadPrivateTransport();

    await expect(privateFetch('/api/preferences')).rejects.toBeInstanceOf(
      PrivateApiIdentityUnavailableError
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
