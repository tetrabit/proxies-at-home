import { type AxiosRequestConfig, type AxiosResponse } from "axios";
import { Readable } from "node:stream";

export interface ImageHttpClient {
  get(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse>;
}

export type RedirectTargetAdmission = (value: string) => string | undefined;

export class ImageRedirectPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRedirectPolicyError";
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

function locationFrom(headers: AxiosResponse["headers"]): unknown {
  const headerMap = headers as unknown as Record<string, unknown>;
  if (typeof headerMap.location === "string") return headerMap.location;

  const get = (headers as unknown as { get?: (name: string) => unknown }).get;
  return typeof get === "function" ? get.call(headers, "location") : undefined;
}

async function disposeRedirectBody(value: unknown): Promise<void> {
  if (!(value instanceof Readable) || value.destroyed || value.readableEnded) return;
  await new Promise<void>(resolve => {
    const settled = () => {
      value.off("close", settled);
      value.off("end", settled);
      value.off("error", settled);
      resolve();
    };
    value.once("close", settled);
    value.once("end", settled);
    value.once("error", settled);
    value.destroy();
  });
}

/**
 * Issues one request per URL with automatic redirects disabled. Each redirect
 * target is resolved, admitted, and restricted to the initial origin before it
 * can be passed to the supplied HTTP client.
 */
export async function fetchWithPolicyCheckedRedirects(
  initialUrl: string,
  client: ImageHttpClient,
  admitRedirectTarget: RedirectTargetAdmission,
  requestOptions: () => AxiosRequestConfig,
): Promise<AxiosResponse> {
  const initialOrigin = new URL(initialUrl).origin;
  let currentUrl = initialUrl;
  let redirectCount = 0;
  const visited = new Set([initialUrl]);

  while (true) {
    const response = await client.get(currentUrl, requestOptions());
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await disposeRedirectBody(response.data);

    if (redirectCount >= MAX_REDIRECTS) {
      throw new ImageRedirectPolicyError("Redirect maximum exceeded");
    }

    const location = locationFrom(response.headers);
    if (typeof location !== "string" || location.length === 0 || location !== location.trim()) {
      throw new ImageRedirectPolicyError("Redirect response has no valid Location");
    }

    let resolved: string;
    try {
      resolved = new URL(location, currentUrl).href;
    } catch {
      throw new ImageRedirectPolicyError("Redirect response has an invalid Location");
    }

    const nextUrl = admitRedirectTarget(resolved);
    if (!nextUrl) {
      throw new ImageRedirectPolicyError("Redirect target is not admitted");
    }
    if (new URL(nextUrl).origin !== initialOrigin) {
      throw new ImageRedirectPolicyError("Cross-origin redirect is not allowed");
    }
    if (visited.has(nextUrl)) {
      throw new ImageRedirectPolicyError("Redirect loop detected");
    }

    visited.add(nextUrl);
    currentUrl = nextUrl;
    redirectCount++;
  }
}
