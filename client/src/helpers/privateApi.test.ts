import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPrivateApi,
  PrivateApiIdentityUnavailableError,
  PrivateApiTargetRejectedError,
  type PrivateApiBootstrap,
  type PrivateApiIdentityProvider,
} from './privateApi';

const fixedBaseUrl = 'http://127.0.0.1:4555';
const syntheticBearer = 'test-private-bearer';
const mockFetch = vi.fn();
global.fetch = mockFetch;

function providerFor(bootstrap: PrivateApiBootstrap): PrivateApiIdentityProvider {
  return vi.fn(async () => bootstrap);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requestOptions(callIndex = 0): RequestInit {
  return mockFetch.mock.calls[callIndex]?.[1] as RequestInit;
}

function authorization(options: RequestInit): string | null {
  return new Headers(options.headers).get('Authorization');
}

describe('privateApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
  });

  it.each([
    '/api/backup',
    '/api/backup/project-1?fresh=true',
    '/api/backup/project%20one?fresh=%2Btrue',
    '/api/preferences',
    '/api/printer-calibration/profiles',
    '/api/metrics/health',
  ])('sends an allowed private path to the configured exact origin: %s', async (path) => {
    const api = createPrivateApi(
      fixedBaseUrl,
      providerFor({ baseUrl: fixedBaseUrl, bearer: syntheticBearer })
    );

    await api.fetch(path);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0]?.[0]).toBe(`${fixedBaseUrl}${path}`);
    expect(requestOptions()).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(authorization(requestOptions())).toBe(`Bearer ${syntheticBearer}`);
  });

  it.each([
    '/api/backupish',
    '/api/preferences-extra',
    '/api/preferences/extra',
    '/api/printer-calibrationish/x',
    '/api/metricsish',
    '/api//backup',
  ])('rejects lookalike route segments before resolving credentials or fetching: %s', async (path) => {
    const provider = providerFor({ baseUrl: fixedBaseUrl, bearer: syntheticBearer });
    const api = createPrivateApi(fixedBaseUrl, provider);

    await expect(api.fetch(path)).rejects.toBeInstanceOf(PrivateApiTargetRejectedError);
    expect(provider).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    'http://127.0.0.1:4555/api/backup',
    'https://127.0.0.1:4555/api/backup',
    'https://attacker.test/api/backup',
    '//attacker.test/api/backup',
    '/api/backup/../share',
    '/api/backup/%2e%2e/share',
    '/api/backup%2f..%2fshare',
    '/api%2fbackup',
    '/%61pi/backup',
    '/api/backup/%5c..%5cshare',
  ])('rejects alternate URL forms and route-normalizing escapes before fetching: %s', async (path) => {
    const provider = providerFor({ baseUrl: fixedBaseUrl, bearer: syntheticBearer });
    const api = createPrivateApi(fixedBaseUrl, provider);

    await expect(api.fetch(path)).rejects.toBeInstanceOf(PrivateApiTargetRejectedError);
    expect(provider).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    '/api/backup/\t../share',
    '/api/backup/\n../share',
    '/api/backup/\r../share',
    '/api/backup/%09../share',
    '/api/backup/%0a../share',
    '/api/backup/%0D../share',
  ])('rejects control-character normalization traversal before resolving credentials: %j', async (path) => {
    const provider = providerFor({ baseUrl: fixedBaseUrl, bearer: syntheticBearer });
    const api = createPrivateApi(fixedBaseUrl, provider);

    await expect(api.fetch(path)).rejects.toBeInstanceOf(PrivateApiTargetRejectedError);
    expect(provider).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('overrides caller authorization and credentials while retaining ordinary headers, body, and abort signal', async () => {
    const api = createPrivateApi(
      fixedBaseUrl,
      providerFor({ baseUrl: fixedBaseUrl, bearer: syntheticBearer })
    );
    const controller = new AbortController();
    const body = new FormData();
    body.append('fixture', 'value');

    await api.fetch('/api/printer-calibration/apply', {
      method: 'POST',
      body,
      signal: controller.signal,
      credentials: 'include',
      redirect: 'follow',
      headers: new Headers({
        authorization: 'Bearer untrusted-caller-value',
        'Content-Type': 'application/fixture',
        'X-Trace': 'fixture',
      }),
    });

    const options = requestOptions();
    expect(options.credentials).toBe('omit');
    expect(options.redirect).toBe('error');
    expect(options.body).toBe(body);
    expect(options.signal).toBe(controller.signal);
    expect(authorization(options)).toBe(`Bearer ${syntheticBearer}`);
    expect(new Headers(options.headers).get('Content-Type')).toBe('application/fixture');
    expect(new Headers(options.headers).get('X-Trace')).toBe('fixture');
  });

  it('does not dispatch before each concurrent provider resolution or mix their identities', async () => {
    const first = deferred<PrivateApiBootstrap>();
    const second = deferred<PrivateApiBootstrap>();
    const provider = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const api = createPrivateApi(fixedBaseUrl, provider);

    const firstRequest = api.fetch('/api/backup/one');
    const secondRequest = api.fetch('/api/metrics/health');
    expect(mockFetch).not.toHaveBeenCalled();

    second.resolve({ baseUrl: fixedBaseUrl, bearer: 'test-bearer-two' });
    await secondRequest;
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(authorization(requestOptions(0))).toBe('Bearer test-bearer-two');

    first.resolve({ baseUrl: fixedBaseUrl, bearer: 'test-bearer-one' });
    await firstRequest;
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(authorization(requestOptions(1))).toBe('Bearer test-bearer-one');
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      `${fixedBaseUrl}/api/metrics/health`,
      `${fixedBaseUrl}/api/backup/one`,
    ]);
  });

  it.each([
    undefined,
    () => Promise.reject(new Error('unavailable')),
    () => Promise.resolve(null as unknown as PrivateApiBootstrap),
    () => Promise.resolve({ baseUrl: '', bearer: syntheticBearer }),
    () => Promise.resolve({ baseUrl: fixedBaseUrl, bearer: '' }),
    () => Promise.resolve({ baseUrl: 42, bearer: syntheticBearer } as unknown as PrivateApiBootstrap),
    () => Promise.resolve({ baseUrl: fixedBaseUrl, bearer: 42 } as unknown as PrivateApiBootstrap),
    () => Promise.resolve({ baseUrl: 'not a URL', bearer: syntheticBearer }),
    () => Promise.resolve({ baseUrl: 'https://127.0.0.1:4555', bearer: syntheticBearer }),
  ])('fails closed with a typed identity error for unavailable or malformed identity providers', async (provider) => {
    const api = createPrivateApi(fixedBaseUrl, provider);

    await expect(api.fetch('/api/backup')).rejects.toBeInstanceOf(PrivateApiIdentityUnavailableError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    'test bearer',
    'test:bearer',
    'test\tbearer',
    'test\nbearer',
    'test=bearer',
  ])('rejects bearer values outside the server grammar before fetching: %j', async (bearer) => {
    const provider = providerFor({ baseUrl: fixedBaseUrl, bearer });
    const api = createPrivateApi(fixedBaseUrl, provider);

    await expect(api.fetch('/api/backup')).rejects.toBeInstanceOf(PrivateApiIdentityUnavailableError);
    expect(provider).toHaveBeenCalledOnce();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    '/api/share',
    '/api/share/id',
    '/api/scryfall/cards/search',
    '/api/mpcfill/search',
    '/api/moxfield/decks/id',
    '/api/archidekt/decks/id',
    '/api/cards/images/id',
    'https://api.scryfall.com/cards/id',
    'https://attacker.test/image.png',
  ])('never invokes the provider or forwards an identity to public or external targets: %s', async (path) => {
    const provider = providerFor({ baseUrl: fixedBaseUrl, bearer: syntheticBearer });
    const api = createPrivateApi(fixedBaseUrl, provider);

    await expect(api.fetch(path)).rejects.toBeInstanceOf(PrivateApiTargetRejectedError);
    expect(provider).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('keeps a concurrent rejected provider local while another private request resolves', async () => {
    const rejected = deferred<PrivateApiBootstrap>();
    const resolved = deferred<PrivateApiBootstrap>();
    const provider = vi.fn()
      .mockReturnValueOnce(rejected.promise)
      .mockReturnValueOnce(resolved.promise);
    const api = createPrivateApi(fixedBaseUrl, provider);

    const rejectedRequest = api.fetch('/api/preferences');
    const resolvedRequest = api.fetch('/api/backup');
    rejected.reject(new Error('fixture failure'));
    await expect(rejectedRequest).rejects.toBeInstanceOf(PrivateApiIdentityUnavailableError);
    expect(mockFetch).not.toHaveBeenCalled();

    resolved.resolve({ baseUrl: fixedBaseUrl, bearer: syntheticBearer });
    await resolvedRequest;
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(authorization(requestOptions())).toBe(`Bearer ${syntheticBearer}`);
  });
});
