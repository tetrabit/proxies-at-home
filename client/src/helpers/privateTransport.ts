import {
  createPrivateApi,
  getElectronPrivateApiBootstrap,
  PrivateApiIdentityUnavailableError,
  type PrivateApi,
  type PrivateApiBootstrap,
} from './privateApi';

let privateApiPromise: Promise<PrivateApi> | undefined;

async function initializePrivateApi(): Promise<PrivateApi> {
  let bootstrap: PrivateApiBootstrap;

  try {
    bootstrap = await getElectronPrivateApiBootstrap();
  } catch {
    throw new PrivateApiIdentityUnavailableError();
  }

  if (!bootstrap || typeof bootstrap !== 'object' || typeof bootstrap.baseUrl !== 'string') {
    throw new PrivateApiIdentityUnavailableError();
  }

  // Electron's trusted preload bootstrap is the private transport authority. Keep the
  // bootstrap only in this module closure; API_BASE may intentionally use localhost
  // for public calls while the private server binds the exact 127.0.0.1 bootstrap origin.
  return createPrivateApi(bootstrap.baseUrl, async () => bootstrap);
}

function getPrivateApi(): Promise<PrivateApi> {
  if (!privateApiPromise) {
    privateApiPromise = initializePrivateApi().catch((error: unknown) => {
      privateApiPromise = undefined;
      throw error;
    });
  }

  return privateApiPromise;
}

/** Dispatches an allowlisted private request using an in-memory Electron bootstrap. */
export async function privateFetch(privatePath: string, init?: RequestInit): Promise<Response> {
  return (await getPrivateApi()).fetch(privatePath, init);
}
