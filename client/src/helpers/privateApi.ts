export interface PrivateApiBootstrap {
  baseUrl: string;
  bearer: string;
}

export type PrivateApiIdentityProvider = () => Promise<PrivateApiBootstrap>;

export interface PrivateApi {
  fetch(privatePath: string, init?: RequestInit): Promise<Response>;
}

/** Thrown locally when no valid private credential can be obtained. */
export class PrivateApiIdentityUnavailableError extends Error {
  constructor() {
    super('Private API identity is unavailable');
    this.name = 'PrivateApiIdentityUnavailableError';
  }
}

/** Thrown locally when a caller tries to use the private adapter for a non-private target. */
export class PrivateApiTargetRejectedError extends Error {
  constructor() {
    super('Private API target is not allowed');
    this.name = 'PrivateApiTargetRejectedError';
  }
}

const privateRouteRoots = new Set(['backup', 'preferences', 'printer-calibration', 'metrics']);

function parsePrivateBaseUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;

  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.pathname !== '/'
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function isValidBearer(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9\-._~+/]+={0,}$/.test(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isAllowedPrivatePath(privatePath: string): boolean {
  if (
    !privatePath.startsWith('/')
    || privatePath.startsWith('//')
    || privatePath.includes('#')
    || hasControlCharacter(privatePath)
  ) {
    return false;
  }

  const queryIndex = privatePath.indexOf('?');
  const pathname = queryIndex === -1 ? privatePath : privatePath.slice(0, queryIndex);
  if (pathname.includes('\\')) return false;

  const segments = pathname.split('/');
  if (segments[0] !== '' || segments.length < 3 || segments.some((segment, index) => index > 0 && segment === '')) {
    return false;
  }

  for (const segment of segments.slice(1)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (
      decoded === '.'
      || decoded === '..'
      || decoded.includes('/')
      || decoded.includes('\\')
      || hasControlCharacter(decoded)
    ) {
      return false;
    }
  }

  if (segments[1] !== 'api' || !privateRouteRoots.has(segments[2])) return false;
  if (segments[2] === 'preferences') return segments.length === 3;
  return true;
}

async function resolveIdentity(
  fixedPrivateBase: URL,
  identityProvider?: PrivateApiIdentityProvider
): Promise<PrivateApiBootstrap> {
  if (!identityProvider) throw new PrivateApiIdentityUnavailableError();

  let bootstrap: PrivateApiBootstrap;
  try {
    bootstrap = await identityProvider();
  } catch {
    throw new PrivateApiIdentityUnavailableError();
  }

  if (!bootstrap || typeof bootstrap !== 'object') {
    throw new PrivateApiIdentityUnavailableError();
  }

  const bootstrapBase = parsePrivateBaseUrl(bootstrap.baseUrl);
  if (!bootstrapBase || bootstrapBase.origin !== fixedPrivateBase.origin || !isValidBearer(bootstrap.bearer)) {
    throw new PrivateApiIdentityUnavailableError();
  }

  return bootstrap;
}

/**
 * Creates an adapter that forwards a private bearer only to a fixed, allowlisted API origin.
 * The provider is intentionally supplied by the caller so web deployments fail closed unless
 * they configure an interactive identity flow.
 */
export function createPrivateApi(
  fixedPrivateBaseUrl: string,
  identityProvider?: PrivateApiIdentityProvider
): PrivateApi {
  return {
    async fetch(privatePath: string, init: RequestInit = {}): Promise<Response> {
      if (!isAllowedPrivatePath(privatePath)) throw new PrivateApiTargetRejectedError();

      const fixedPrivateBase = parsePrivateBaseUrl(fixedPrivateBaseUrl);
      if (!fixedPrivateBase) throw new PrivateApiIdentityUnavailableError();

      const target = new URL(privatePath, fixedPrivateBase);
      if (target.origin !== fixedPrivateBase.origin || !isAllowedPrivatePath(target.pathname)) {
        throw new PrivateApiTargetRejectedError();
      }

      const identity = await resolveIdentity(fixedPrivateBase, identityProvider);

      const headers = new Headers(init.headers);
      headers.delete('authorization');
      headers.set('Authorization', `Bearer ${identity.bearer}`);

      return globalThis.fetch(target.href, {
        ...init,
        headers,
        credentials: 'omit',
        redirect: 'error',
      });
    },
  };
}

/**
 * Reads only the narrow Electron preload bootstrap seam. It is optional so browsers without an
 * explicitly configured web provider fail closed through createPrivateApi.
 */
export const getElectronPrivateApiBootstrap: PrivateApiIdentityProvider = async () => {
  const provider = globalThis.window?.electronAPI?.getPrivateApiBootstrap;
  if (!provider) throw new PrivateApiIdentityUnavailableError();
  return provider();
};
