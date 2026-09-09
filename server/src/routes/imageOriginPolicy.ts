export type ProxyTargetValidation =
  | { ok: true; url: string }
  | { ok: false };

export type MpcRequestValidation =
  | { ok: true; id: string; size: "full" | "small" | "large" }
  | { ok: false };

const SCRYFALL_HOST = "cards.scryfall.io";
const DRIVE_HOST = "drive.google.com";
const SCRYFALL_PATH = /^\/(png|large|normal|small|border_crop|art_crop)\/(front|back)\/([0-9a-f])\/([0-9a-f])\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg)$/;
const DRIVE_THUMBNAIL_QUERY = /^\?(?:id=[A-Za-z0-9_-]{1,200}&sz=(?:w400-h400|w800-h800)|sz=(?:w400-h400|w800-h800)&id=[A-Za-z0-9_-]{1,200})$/;
const MPC_ID = /^[A-Za-z0-9_-]{1,200}$/;

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

  if (hasAllowedOrigin(url, DRIVE_HOST)
    && url.pathname === "/thumbnail"
    && DRIVE_THUMBNAIL_QUERY.test(url.search)) {
    return { ok: true, url: url.href };
  }

  return { ok: false };
}

export function validateMpcRequest(idValue: unknown, sizeValue: unknown): MpcRequestValidation {
  if (typeof idValue !== "string" || !MPC_ID.test(idValue)) return { ok: false };

  const size = sizeValue === undefined ? "full" : sizeValue;
  if (size !== "full" && size !== "small" && size !== "large") return { ok: false };

  return { ok: true, id: idValue, size };
}
