export type ProxyTargetValidation =
  | { ok: true; url: string }
  | { ok: false };

export interface ProxyRedirectPolicy {
  admitRedirectTarget: (value: string) => string | undefined;
  allowsCrossOriginRedirect: (initialUrl: string, nextUrl: string) => boolean;
}

export type MpcRequestValidation =
  | { ok: true; id: string; size: "full" | "small" | "large" }
  | { ok: false };

const SCRYFALL_HOST = "cards.scryfall.io";
const DRIVE_HOST = "drive.google.com";
const DRIVE_THUMBNAIL_CDN_HOST = "lh3.googleusercontent.com";
const SCRYFALL_PATH = /^\/(png|large|normal|small|border_crop|art_crop)\/(front|back)\/([0-9a-f])\/([0-9a-f])\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg)$/;
const DRIVE_THUMBNAIL_QUERY = /^\?(?:id=([A-Za-z0-9_-]{1,200})&sz=(w400-h400|w800-h800)|sz=(w400-h400|w800-h800)&id=([A-Za-z0-9_-]{1,200}))$/;
const MPC_ID = /^[A-Za-z0-9_-]{1,200}$/;

interface DriveThumbnailIdentity {
  id: string;
  size: "w400-h400" | "w800-h800";
}

function hasAllowedOrigin(url: URL, hostname: string): boolean {
  return url.protocol === "https:"
    && url.hostname === hostname
    && url.port === ""
    && url.username === ""
    && url.password === ""
    && url.hash === "";
}

function isValidScryfallPath(url: URL): boolean {
  const match = SCRYFALL_PATH.exec(url.pathname);
  if (!match) return false;

  const [, rendition, , firstDirectory, secondDirectory, uuid, extension] = match;
  return firstDirectory === uuid[0]
    && secondDirectory === uuid[1]
    && ((rendition === "png" && extension === "png") || (rendition !== "png" && extension === "jpg"));
}

function isValidScryfallQuery(url: URL): boolean {
  return url.search === "" && !url.href.endsWith("?")
    || /^\?[0-9]{1,20}$/.test(url.search);
}

function driveThumbnailIdentity(url: URL): DriveThumbnailIdentity | undefined {
  if (!hasAllowedOrigin(url, DRIVE_HOST) || url.pathname !== "/thumbnail") return undefined;

  const match = DRIVE_THUMBNAIL_QUERY.exec(url.search);
  if (!match) return undefined;

  return {
    id: match[1] ?? match[4],
    size: (match[2] ?? match[3]) as DriveThumbnailIdentity["size"],
  };
}

function admitIdentityBoundDriveThumbnailCdnRedirect(
  initialUrl: string,
  value: string,
): string | undefined {
  if (value.length === 0
    || value !== value.trim()
    || value.includes("%")
    || value.includes("\\")
    || value.includes("/./")
    || value.includes("/../")) return undefined;

  let initial: URL;
  let next: URL;
  try {
    initial = new URL(initialUrl);
    next = new URL(value);
  } catch {
    return undefined;
  }

  const identity = driveThumbnailIdentity(initial);
  if (!identity
    || !hasAllowedOrigin(next, DRIVE_THUMBNAIL_CDN_HOST)
    || next.search !== ""
    || next.href.endsWith("?")
    || next.pathname !== `/d/${identity.id}=${identity.size}`) return undefined;

  return next.href;
}

export function validateProxyTarget(value: unknown): ProxyTargetValidation {
  if (typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.includes("%")
    || value.includes("\\")
    || value.includes("/./")
    || value.includes("/../")) return { ok: false };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false };
  }

  if (hasAllowedOrigin(url, SCRYFALL_HOST)
    && isValidScryfallPath(url)
    && isValidScryfallQuery(url)) {
    return { ok: true, url: url.href };
  }

  if (driveThumbnailIdentity(url)) {
    return { ok: true, url: url.href };
  }

  return { ok: false };
}

/**
 * Binds redirects to an already validated client target. Drive thumbnails may
 * transition exactly once to their corresponding lh3 image path; other proxy
 * targets retain the existing same-origin admission contract.
 */
export function createProxyRedirectPolicy(initialUrl: string): ProxyRedirectPolicy | undefined {
  const initial = validateProxyTarget(initialUrl);
  if (!initial.ok) return undefined;

  let parsedInitial: URL;
  try {
    parsedInitial = new URL(initial.url);
  } catch {
    return undefined;
  }

  if (driveThumbnailIdentity(parsedInitial)) {
    return {
      admitRedirectTarget: value => admitIdentityBoundDriveThumbnailCdnRedirect(initial.url, value),
      allowsCrossOriginRedirect: (requestInitialUrl, nextUrl) =>
        requestInitialUrl === initial.url
        && admitIdentityBoundDriveThumbnailCdnRedirect(initial.url, nextUrl) === nextUrl,
    };
  }

  return {
    admitRedirectTarget: value => {
      const admission = validateProxyTarget(value);
      return admission.ok ? admission.url : undefined;
    },
    allowsCrossOriginRedirect: () => false,
  };
}

export function validateMpcRequest(idValue: unknown, sizeValue: unknown): MpcRequestValidation {
  if (typeof idValue !== "string" || !MPC_ID.test(idValue)) return { ok: false };

  const size = sizeValue === undefined ? "full" : sizeValue;
  if (size !== "full" && size !== "small" && size !== "large") return { ok: false };

  return { ok: true, id: idValue, size };
}
