import express, { type Request, type Response } from "express";
import path from "path";
import fs from "fs";
import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getCardDataForCardInfo, batchFetchCards } from "../utils/getCardImagesPaged.js";
import { extractTokenParts } from "../utils/tokenUtils.js";
import { fetchCardsForTokenLookup, resolveLatestTokenParts } from "../utils/tokenLookup.js";
import { validateImportCardRequest } from "../utils/importRequestValidation.js";
import { validateMpcRequest, validateProxyTarget } from "./imageOriginPolicy.js";
import { createPinnedHttpsAgent, type ResolveAll } from "./imageConnectionPolicy.js";
import {
  fetchWithPolicyCheckedRedirects,
  ImageRedirectPolicyError,
  type ImageHttpClient,
  type RedirectTargetAdmission,
} from "./imageRedirectPolicy.js";
import {
  ProxyDownloadQuotaError,
  createProxyDownloadAdmission,
  createProxyDownloadCleanupReconciler,
  type ProxyDownloadReservation,
} from "./proxyDownloadAdmission.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function acceptsSurfaceableStatus(s: number): boolean {
  return s >= 200 && s < 500;
}

const AX = axios.create({
  timeout: 6000, // 6s per outbound request (reduced from 12s)
  headers: { "User-Agent": "Proxxied/1.0 (+contact@example.com)" },
  validateStatus: acceptsSurfaceableStatus, // surface 4xx/429 to logic
});

// Separate axios instance for Google Drive/MPC images with longer timeout
const AX_GDRIVE = axios.create({
  timeout: 30000, // 30s for large Google Drive files
  headers: { "User-Agent": "Proxxied/1.0 (+contact@example.com)" },
  validateStatus: acceptsSurfaceableStatus,
});

const MAX_PROXY_CONCURRENT_DOWNLOADS = 10;
const MAX_PROXY_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_PROXY_DOWNLOAD_RESERVED_BYTES =
  MAX_PROXY_CONCURRENT_DOWNLOADS * MAX_PROXY_RESPONSE_BYTES;

let proxyDownloadAdmission = createProxyDownloadAdmission({
  maxBytes: MAX_PROXY_DOWNLOAD_RESERVED_BYTES,
});
const proxyDownloadCleanup = createProxyDownloadCleanupReconciler({
  unlink: filePath => fs.promises.unlink(filePath),
  log: (message, error) => console.warn(message, error),
  onSettled: filePath => writeInProgress.delete(filePath),
});

class ImageDownloadError extends Error {
  readonly status: number | undefined;
  readonly contentType: string | undefined;

  constructor(message: string, status?: number, contentType?: string) {
    super(message);
    this.name = "ImageDownloadError";
    this.status = status;
    this.contentType = contentType;
  }
}

let imageResolveAllForTests: ResolveAll | undefined;

function connectionTimeRequestOptions(options: AxiosRequestConfig = {}): AxiosRequestConfig {
  return {
    ...options,
    httpsAgent: createPinnedHttpsAgent({ resolveAll: imageResolveAllForTests }),
    maxRedirects: 0,
    proxy: false,
  };
}

function admitProxyRedirect(value: string): string | undefined {
  const admission = validateProxyTarget(value);
  return admission.ok ? admission.url : undefined;
}

function admitMpcRedirect(value: string): string | undefined {
  if (value.includes("%") || value.includes("\\")) return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "" || url.hash !== "") {
    return undefined;
  }

  if (url.hostname === "drive.google.com" && url.pathname === "/uc") {
    const entries = [...url.searchParams.entries()];
    const keys = new Set(entries.map(([key]) => key));
    const id = url.searchParams.get("id");
    const exportMode = url.searchParams.get("export");
    const confirm = url.searchParams.get("confirm");
    if ((entries.length === 2 || entries.length === 3)
      && keys.size === entries.length
      && keys.has("id")
      && keys.has("export")
      && (entries.length === 2 || (keys.has("confirm") && confirm === "t"))
      && /^[A-Za-z0-9_-]{1,200}$/.test(id ?? "")
      && (exportMode === "download" || exportMode === "view")) {
      return url.href;
    }
  }

  if (url.hostname === "img.mpcautofill.com"
    && url.search === ""
    && !url.href.endsWith("?")
    && /^\/[A-Za-z0-9_-]{1,200}-(?:small|large)-google_drive$/.test(url.pathname)) {
    return url.href;
  }

  return undefined;
}

// Improved retry with exponential backoff (reduced retries for faster failure)
async function getWithRetry(
  url: string,
  opts: AxiosRequestConfig = {},
  tries = 2,
  client: ImageHttpClient = AX,
  admitRedirectTarget: RedirectTargetAdmission = admitProxyRedirect,
  acceptResponse: (response: AxiosResponse) => boolean = response => response.status >= 200 && response.status < 300,
): Promise<AxiosResponse> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetchWithPolicyCheckedRedirects(
        url,
        client,
        admitRedirectTarget,
        () => connectionTimeRequestOptions(opts),
      );
      if (acceptResponse(res)) return res;
      await disposeReadable(res.data);
      if (res.status === 429) {
        const wait = Number(res.headers["retry-after"] || 5);
        console.log(`[429] Rate limited. Waiting ${wait}s before retry...`);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (e instanceof ImageRedirectPolicyError) throw e;
      lastErr = e;
      // Exponential backoff: 500ms, 1s (reduced from 1s, 2s, 4s...)
      const backoffMs = Math.min(500 * Math.pow(2, i), 2000);
      const jitter = Math.random() * 250;
      await new Promise(r => setTimeout(r, backoffMs + jitter));
    }
  }
  throw lastErr;
}



// Tiny p-limit (cap parallel Scryfall calls)
function pLimit(concurrency: number) {
  type Task = () => Promise<unknown>;
  type Resolver = (value: unknown) => void;
  type Rejector = (reason?: unknown) => void;

  const q: [Task, Resolver, Rejector][] = [];
  let active = 0;

  const run = async (fn: Task, resolve: Resolver, reject: Rejector) => {
    active++;
    try {
      resolve(await fn());
    }
    catch (e) {
      reject(e);
    }
    finally {
      active--;
      if (q.length) {
        const next = q.shift();
        /* v8 ignore next -- q.length guarantees shift returns a task tuple; the guard remains defensive for queue mutation. @preserve */
        if (next) {
          const [nextFn, nextRes, nextRej] = next;
          run(nextFn, nextRes, nextRej);
        }
      }
    }
  };
  return <T>(fn: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    const wrappedResolve = resolve as Resolver;
    const wrappedReject = reject as Rejector;
    if (active < concurrency) run(fn, wrappedResolve, wrappedReject);
    else q.push([fn, wrappedResolve, wrappedReject]);
  });
}
// Concurrency limiters:
// - scryfallApiLimit: For Scryfall JSON API calls (card search, collection lookups)
// - imageFetchLimit: For outbound image fetches (Scryfall CDN, Google Drive)
const scryfallApiLimit = pLimit(6);
const imageFetchLimit = pLimit(MAX_PROXY_CONCURRENT_DOWNLOADS);
let enrichLookupTimeoutMs = 20_000;

// -------------------- cache helpers --------------------

const imageRouter = express.Router();

const dataDirectory = path.resolve(process.env.SERVER_DATA_DIR ?? path.join(process.cwd(), "data"));
const cacheDir = path.join(dataDirectory, "cached-images");
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

// Cache size management with LRU eviction (12GB limit for Koyeb eLarge 20GB disk)
const MAX_CACHE_SIZE_BYTES = 12 * 1024 * 1024 * 1024; // 12GB (leaves 8GB for system/logs)
let lastCacheCleanup = 0;

// Track the exact temporary paths currently owned by active publishers. Cache
// eviction must not unlink one between createWriteStream() and rename().
const writeInProgress = new Set<string>();

interface ProxyDownloadResult {
  contentType: string;
}

interface ProxyDownloadEntry {
  abortController: AbortController;
  promise: Promise<ProxyDownloadResult>;
  settled: boolean;
  subscribers: number;
}

// Each cache destination has at most one physical download. Subscribers await the
// same promise, then independently read the atomically published final file.
const proxyDownloadsInFlight = new Map<string, ProxyDownloadEntry>();

// In-memory cache of URL→path mappings to avoid fs.existsSync syscalls
import { LRUCache } from "../utils/lruCache.js";
const urlPathCache = new LRUCache<string, string>(5000); // Cache 5000 hot URLs

async function checkAndCleanCache() {
  const now = Date.now();
  // Only check every 5 minutes to avoid excessive disk I/O
  if (now - lastCacheCleanup < 5 * 60 * 1000) return;
  lastCacheCleanup = now;

  try {
    // Use async filesystem operations to avoid blocking event loop
    const files = await fs.promises.readdir(cacheDir);
    const fileStats: { path: string; atime: number; size: number }[] = [];
    let totalSize = 0;

    for (const file of files) {
      const filePath = path.join(cacheDir, file);
      try {
        const stats = await fs.promises.stat(filePath);
        if (stats.isFile()) {
          fileStats.push({ path: filePath, atime: stats.atimeMs, size: stats.size });
          totalSize += stats.size;
        }
      } catch {
        // File might have been deleted, skip it
        continue;
      }
    }

    if (totalSize > MAX_CACHE_SIZE_BYTES) {
      console.log(`[CACHE] Size ${(totalSize / 1024 / 1024 / 1024).toFixed(2)}GB exceeds 12GB limit. Cleaning...`);

      fileStats.sort((a, b) => a.atime - b.atime);

      let removedSize = 0;
      let removedCount = 0;
      // Remove oldest files until we're under 10GB (leave 2GB buffer)
      const targetSize = 10 * 1024 * 1024 * 1024;

      for (const file of fileStats) {
        if (totalSize - removedSize < targetSize) break;
        if (writeInProgress.has(file.path)) continue;
        try {
          await fs.promises.unlink(file.path);
          removedSize += file.size;
          removedCount++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[CACHE] Failed to delete ${file.path}:`, msg);
        }
      }

      console.log(`[CACHE] Removed ${removedCount} files (${(removedSize / 1024 / 1024 / 1024).toFixed(2)}GB)`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CACHE] Cleanup error:", msg);
  }
}

// Make a stable cache filename from the FULL raw URL (path + query)
function cachePathFromUrl(originalUrl: string) {
  const hash = crypto.createHash("sha1").update(originalUrl).digest("hex");

  // try to preserve the real extension; default to .png
  let ext = ".png";
  try {
    const u = new URL(originalUrl);
    const m = u.pathname.match(/\.(png|jpg|jpeg|webp)$/i);
    if (m) ext = m[0].toLowerCase();
  } catch {
    // ignore; keep .png
  }
  return path.join(cacheDir, `${hash}${ext}`);
}

async function disposeReadable(value: unknown): Promise<void> {
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

async function streamImageResponseToFile(
  response: AxiosResponse,
  finalPath: string,
  signal: AbortSignal,
  reservation?: ProxyDownloadReservation,
): Promise<{ contentType: string }> {
  const source = response.data;
  if (!(source instanceof Readable)) {
    throw new ImageDownloadError("Upstream error", response.status);
  }

  const contentType = String(response.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("image/")) {
    await disposeReadable(source);
    throw new ImageDownloadError("Upstream not image", response.status, contentType);
  }

  const tempPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let published = false;
  writeInProgress.add(tempPath);
  try {
    let seen = 0;
    const byteCap = new Transform({
      writableHighWaterMark: 1,
      readableHighWaterMark: 1,
      transform(chunk: Buffer | string, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (seen + bytes.length > MAX_PROXY_RESPONSE_BYTES) {
          const error = new Error("Upstream image exceeds 25 MiB response limit");
          source.destroy(error);
          callback(error);
          return;
        }
        seen += bytes.length;
        callback(null, bytes);
      },
    });
    const output = fs.createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
    await pipeline(source, byteCap, output, { signal });
    if (seen === 0) throw new ImageDownloadError("Upstream is a 0-byte image", response.status);

    await fs.promises.rename(tempPath, finalPath);
    published = true;
    return { contentType };
  } finally {
    if (published) {
      reservation?.release();
      writeInProgress.delete(tempPath);
    } else if (reservation) {
      await proxyDownloadCleanup.reconcile(tempPath, reservation);
      if (reservation.isReleased()) writeInProgress.delete(tempPath);
    } else {
      try {
        await fs.promises.unlink(tempPath);
        writeInProgress.delete(tempPath);
      } catch (cleanupError: unknown) {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        console.warn("[Proxy] Failed to remove owned temporary image file:", message);
      }
    }
  }
}

function getOrStartProxyDownload(originalUrl: string, localPath: string): ProxyDownloadEntry {
  const existing = proxyDownloadsInFlight.get(localPath);
  if (existing) return existing;

  // This controller belongs to the shared physical download, not any one HTTP
  // subscriber. A disconnected subscriber must not abort other waiters.
  const sharedAbortController = new AbortController();
  const physicalDownload = imageFetchLimit(async () => {
    const reservation = proxyDownloadAdmission.reserve(MAX_PROXY_RESPONSE_BYTES);
    let responseReceived = false;
    try {
      const response = await getWithRetry(originalUrl, {
        responseType: "stream",
        signal: sharedAbortController.signal,
      });
      responseReceived = true;
      return await streamImageResponseToFile(
        response,
        localPath,
        sharedAbortController.signal,
        reservation,
      );
    } catch (error) {
      if (!responseReceived || !reservation.isCleanupPending()) reservation.release();
      throw error;
    }
  });

  const settle = () => {
    entry.settled = true;
    // Delete only the entry owned by this settled download. A later retry may
    // already have installed a new entry for the same cache path.
    if (proxyDownloadsInFlight.get(localPath) === entry) {
      proxyDownloadsInFlight.delete(localPath);
    }
  };
  const promise = physicalDownload.then(
    result => {
      settle();
      return result;
    },
    error => {
      settle();
      throw error;
    },
  );
  const entry: ProxyDownloadEntry = {
    abortController: sharedAbortController,
    promise,
    settled: false,
    subscribers: 0,
  };
  proxyDownloadsInFlight.set(localPath, entry);

  return entry;
}

function subscribeToProxyDownload(
  originalUrl: string,
  localPath: string,
  req: Request,
  res: Response,
): { promise: Promise<ProxyDownloadResult>; release: () => void } {
  const entry = getOrStartProxyDownload(originalUrl, localPath);
  entry.subscribers++;
  let subscribed = true;

  const release = () => {
    if (!subscribed) return;
    subscribed = false;
    req.off("aborted", release);
    res.off("close", release);
    entry.subscribers--;
    if (entry.subscribers === 0 && !entry.settled && !entry.abortController.signal.aborted) {
      entry.abortController.abort(new Error("All inbound image requests disconnected"));
    }
  };

  req.once("aborted", release);
  res.once("close", release);
  return { promise: entry.promise, release };
}

// -------------------- API: batch enrich cards --------------------
interface EnrichRequestBody {
  cards: Array<{ name: string; set?: string; number?: string; isToken?: boolean }>;
}

interface EnrichedCard {
  name: string;
  set?: string;
  number?: string;
  colors?: string[];
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  rarity?: string;
  lang?: string;
  layout?: string;
  card_faces?: Array<{
    name: string;
    type_line?: string;
    mana_cost?: string;
    colors?: string[];
    image_uris?: {
      large?: string;
      normal?: string;
      png?: string;
    };
  }>;
  token_parts?: Array<{
    id?: string;
    name: string;
    type_line?: string;
    uri?: string;
  }>;
}

/**
 * Extract enriched metadata from a Scryfall API card
 */
function extractEnrichedCard(
  card: { name: string; set?: string; number?: string },
  data: import("../utils/getCardImagesPaged.js").ScryfallApiCard
): EnrichedCard {
  // Extract colors from card_faces for DFCs
  let colors = data.colors;
  let mana_cost = data.mana_cost;

  if ((!colors || !mana_cost) && data.card_faces && data.card_faces.length > 0) {
    /* v8 ignore else -- top-level Scryfall colors are preserved when present; missing fallback is covered. @preserve */
    if (!colors) colors = data.card_faces[0].colors;
    /* v8 ignore else -- top-level Scryfall mana_cost is preserved when present; missing fallback is covered. @preserve */
    if (!mana_cost) mana_cost = data.card_faces[0].mana_cost;
  }

  // Extract token parts
  const token_parts = extractTokenParts(data);

  return {
    name: data.name ?? card.name, // Use canonical Scryfall name, fall back to query name
    set: data.set || card.set,
    number: data.collector_number || card.number,
    colors,
    mana_cost,
    cmc: data.cmc,
    type_line: data.type_line,
    rarity: data.rarity,
    lang: data.lang,
    layout: data.layout,
    card_faces: data.card_faces?.map(f => ({
      name: f.name || "",
      type_line: f.type_line,
      mana_cost: f.mana_cost,
      colors: f.colors,
      image_uris: f.image_uris,
    })),
    token_parts, // Include token parts in enrichment response
  };
}

imageRouter.post("/enrich", async (req: Request<unknown, unknown, EnrichRequestBody>, res: Response) => {
  const validation = validateImportCardRequest(req.body, "cards");
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }

  const cards = req.body.cards;

  if (cards.length === 0) {
    return res.json([]);
  }

  try {
    // Step 1: Use Collection API for fast batch lookup
    const cardInfos = cards.map(c => ({
      name: c.name,
      set: c.set,
      number: c.number,
    }));

    const batchResults = await batchFetchCards(cardInfos, "en");

    // Step 2: Map results back to original cards
    const results: (EnrichedCard | null)[] = [];
    const notFoundCards: Array<{ index: number; card: { name: string; set?: string; number?: string; isToken?: boolean } }> = [];

    // Helper to normalize names for loose matching (remove punctuation, lowercase)
    const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];

      // Try to find in batch results
      let found: import("../utils/getCardImagesPaged.js").ScryfallApiCard | undefined;

      // Try set+number first
      if (card.set && card.number) {
        const setNumKey = `${card.set.toLowerCase()}:${card.number}`;
        found = batchResults.get(setNumKey);
      }

      // Fall back to name lookup
      if (!found) {
        found = batchResults.get(card.name.toLowerCase());
      }

      // Validate that found card name loosely matches query name
      // This catches cases where MPC names differ from Scryfall (e.g., "Conjurers Closet" vs "Conjurer's Closet")
      if (found && found.name) {
        const queryNorm = normalizeName(card.name);
        const foundNorm = normalizeName(found.name);
        // Also check DFC face names
        const faceNames = found.card_faces?.map(f =>
          /* v8 ignore next -- Scryfall faces carry names; empty fallback remains defensive for malformed payloads. @preserve */
          normalizeName(f.name || '')
        ) || [];
        if (foundNorm !== queryNorm && !faceNames.includes(queryNorm)) {
          // Name doesn't match - treat as not found to trigger individual search
          found = undefined;
        }
      }

      if (found) {
        results[i] = extractEnrichedCard(card, found);
      } else {
        results[i] = null; // Placeholder
        notFoundCards.push({ index: i, card });
      }
    }

    // Step 3: Fallback to search API for not_found cards
    if (notFoundCards.length > 0) {
      await Promise.all(
        notFoundCards.map(({ index, card }) =>
          scryfallApiLimit(async () => {
            const timeout = new Promise<null>((_, rej) =>
              setTimeout(() => rej(new Error("scryfall-timeout")), enrichLookupTimeoutMs)
            );
            const task = (async (): Promise<EnrichedCard | null> => {
              const data = await getCardDataForCardInfo({
                name: card.name,
                set: card.set,
                number: card.number,
                isToken: card.isToken,
              });
              if (data) {
                return extractEnrichedCard(card, data);
              }
              return null;
            })();

            try {
              const result = await Promise.race([task, timeout]);
              results[index] = result;
            } catch {
              console.warn(`[Enrich] Timeout for card: ${card.name}`);
              results[index] = null;
            }
          })
        )
      );
    }

    return res.json(results);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Enrich] Error:", msg);
    return res.status(500).json({ error: "Failed to enrich cards." });
  }
});

// -------------------- API: fetch token parts for cards --------------------
interface TokensRequestBody {
  cards: Array<{ name: string; set?: string; number?: string }>;
}

interface TokenPart {
  id?: string;
  name: string;
  type_line?: string;
  uri?: string;
}

interface CardTokenResponse {
  name: string;
  set?: string;
  number?: string;
  token_parts?: TokenPart[];
}

imageRouter.post("/tokens", async (req: Request<unknown, unknown, TokensRequestBody>, res: Response) => {
  const validation = validateImportCardRequest(req.body, "cards");
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }

  const cards = req.body.cards;

  if (cards.length === 0) {
    return res.json([]);
  }

  try {
    // Prefer the scryfall-cache-microservice (if configured + healthy), with fallback
    // to the existing local Proxxied cache + direct Scryfall API.
    const cardInfos = cards.map(c => ({
      name: c.name,
      set: c.set,
      number: c.number,
    }));

    const { cards: lookupResults } = await fetchCardsForTokenLookup(cardInfos, "en");

    // Map results back with token_parts
    const results: CardTokenResponse[] = [];

    for (const card of cards) {
      // Try to find in batch results
      let found: import("../utils/getCardImagesPaged.js").ScryfallApiCard | undefined;

      // Try set+number first
      if (card.set && card.number) {
        const setNumKey = `${card.set.toLowerCase()}:${card.number}`;
        found = lookupResults.get(setNumKey);
      }

      // Fall back to name lookup
      if (!found) {
        found = lookupResults.get(card.name.toLowerCase());
      }

      if (found) {
        const tokenParts = await resolveLatestTokenParts(extractTokenParts(found), "en");
        results.push({
          // Preserve request identity so client can reliably map updates
          // even when Scryfall normalizes punctuation/spacing in canonical names.
          name: card.name,
          set: card.set,
          number: card.number,
          token_parts: tokenParts, // Return [] if empty
        });
      } else {
        results.push({ name: card.name, set: card.set, number: card.number });
      }
    }

    return res.json(results);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Tokens] Error:", msg);
    return res.status(500).json({ error: "Failed to fetch token data." });
  }
});

// -------------------- proxy (cached) --------------------
imageRouter.get("/proxy", async (req: Request, res: Response) => {
  const admission = validateProxyTarget(req.query.url);
  if (!admission.ok) {
    return res.status(400).json({ error: "Missing or invalid ?url" });
  }

  const originalUrl = admission.url;

  const localPath = cachePathFromUrl(originalUrl);

  // Check cache size periodically
  /* v8 ignore next -- checkAndCleanCache catches its own filesystem failures; this is a defensive promise guard. @preserve */
  checkAndCleanCache().catch((err: unknown) => console.error("[CACHE] Cleanup failed:", err));

  let subscription: ReturnType<typeof subscribeToProxyDownload> | undefined;
  try {
    // Fast path: check in-memory cache first to avoid fs.existsSync syscall
    const cachedPath = urlPathCache.get(originalUrl);
    if (cachedPath && fs.existsSync(cachedPath)) {
      const now = new Date();
      /* v8 ignore next -- fire-and-forget access-time refresh failures do not affect cached image serving. @preserve */
      fs.promises.utimes(cachedPath, now, now).catch(() => { /* ignore */ });
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return res.sendFile(cachedPath);
    }

    // Fallback to disk check
    if (fs.existsSync(localPath)) {
      // Update access time for LRU (fire-and-forget, don't block response)
      const now = new Date();
      /* v8 ignore next -- fire-and-forget access-time refresh failures do not affect cached image serving. @preserve */
      fs.promises.utimes(localPath, now, now).catch(() => { /* ignore */ });
      urlPathCache.set(originalUrl, localPath); // Add to in-memory cache
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return res.sendFile(localPath);
    }

    // Same-key misses share one physical download. The promise resolves only
    // after streamImageResponseToFile atomically publishes the final file.
    subscription = subscribeToProxyDownload(originalUrl, localPath, req, res);
    const result = await subscription.promise;
    subscription.release();
    urlPathCache.set(originalUrl, localPath);

    // A disconnected subscriber is not allowed to affect the shared owner.
    if (req.aborted || res.destroyed) return;
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.sendFile(localPath);
  } catch (err: unknown) {
    if (req.aborted || res.destroyed) return;
    if (err instanceof ProxyDownloadQuotaError) {
      return res.status(503).json({ error: "Image download service is temporarily unavailable." });
    }
    if (err instanceof ImageDownloadError) {
      if (err.contentType !== undefined) {
        return res.status(502).json({ error: err.message, ct: err.contentType });
      }
      if (err.message === "Upstream error") {
        return res.status(502).json({ error: err.message, status: err.status });
      }
      return res.status(502).json({ error: err.message });
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Proxy error:", { message: msg, from: originalUrl });
    return res.status(502).json({ error: "Failed to download image", from: originalUrl });
  } finally {
    subscription?.release();
  }
});

// -------------------- MPC Google Drive proxy (cached) --------------------

imageRouter.get("/mpc", async (req: Request, res: Response) => {
  const admission = validateMpcRequest(req.query.id, req.query.size);
  if (!admission.ok) return res.status(400).send("Missing or invalid MPC image request");

  const { id, size } = admission;

  // Use same cache infrastructure as /proxy
  const cacheKey = `gdrive_${id}_${size}`;
  let localPath = path.join(cacheDir, cacheKey);

  // Check cache first
  try {
    if (fs.existsSync(localPath)) {
      const now = new Date();
      /* v8 ignore next -- fire-and-forget access-time refresh failures do not affect cached image serving. @preserve */
      fs.promises.utimes(localPath, now, now).catch(() => { /* ignore */ });
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return res.sendFile(localPath);
    }
  } catch {
    // Cache check failed, proceed to fetch
  }

  // URL candidates to try (in order of preference)
  // Google Drive direct download is preferred but often fails due to:
  // - Access restrictions
  // - Virus scan interstitials for large files
  // - Rate limiting
  // MPC Autofill CDN is more reliable as a fallback
  const candidates: string[] = [];

  if (size === "full") {
    // Try Google Drive URLs - include confirm=t to bypass virus scan interstitials
    // Order: confirm URL first (bypasses interstitial), then regular URLs as fallback
    candidates.push(`https://drive.google.com/uc?export=download&confirm=t&id=${encodeURIComponent(id)}`);
    candidates.push(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`);
    candidates.push(`https://drive.google.com/uc?export=view&id=${encodeURIComponent(id)}`);
    // Fallback to MPC Autofill CDN large size (lower quality but more reliable)
    candidates.push(`https://img.mpcautofill.com/${id}-large-google_drive`);
  } else {
    // For thumbnails (small, large), use MPC Autofill CDN (more reliable)
    candidates.push(`https://img.mpcautofill.com/${id}-${size}-google_drive`);
  }

  const abortController = new AbortController();
  const abortActiveDownload = () => abortController.abort(new Error("Inbound image request aborted"));
  req.once("aborted", abortActiveDownload);
  // Use imageFetchLimit to prevent overwhelming server with concurrent fetches
  let lastError: string | undefined;
  try {
    const result = await imageFetchLimit(async () => {
      let reservation = proxyDownloadAdmission.reserve(MAX_PROXY_RESPONSE_BYTES);
      try {
        for (const url of candidates) {
          try {
            // Use AX_GDRIVE with longer timeout for large Google Drive files
            const r = await getWithRetry(
              url,
              { responseType: "stream", signal: abortController.signal },
              1,
              AX_GDRIVE,
              admitMpcRedirect,
              () => true,
            );

            const ct = (r.headers["content-type"] || "").toLowerCase();
            if (r.status < 200 || r.status >= 300) {
              await disposeReadable(r.data);
              lastError = `HTTP ${r.status} from ${url}`;
              continue;
            }
            if (!ct.startsWith("image/")) {
              await disposeReadable(r.data);
              lastError = `Non-image response from ${url}: ${ct}`;
              continue; // Not an image (HTML interstitial), try next candidate
            }

            // If we fell back to the MPC CDN "large" image while requesting "full",
            // save it as "large" so we don't pollute the "full" cache slot with lower res.
            if (size === "full" && url.includes("-large-google_drive")) {
              localPath = path.join(cacheDir, `gdrive_${id}_large`);
            }

            return await streamImageResponseToFile(r, localPath, abortController.signal, reservation);
          } catch (err) {
            // A failed owned-temp cleanup retains its lease and must not continue
            // candidate work under an unproven aggregate-spool capacity claim.
            if (reservation.isCleanupPending()) throw err;
            // A settled failed candidate may fall through to the next URL. Its
            // next physical stream gets a new lease inside this limiter slot.
            if (reservation.isReleased()) {
              reservation = proxyDownloadAdmission.reserve(MAX_PROXY_RESPONSE_BYTES);
            }
            const msg = err instanceof Error ? err.message : String(err);
            lastError = `Failed to fetch ${url}: ${msg}`;
          }
        }
        return null;
      } finally {
        if (!reservation.isReleased() && !reservation.isCleanupPending()) reservation.release();
      }
    });

    if (result) {
      res.setHeader("Content-Type", result.contentType);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return res.sendFile(localPath);
    }
  /* v8 ignore start -- imageFetchLimit only rejects for defensive limiter failures; candidate fetch failures are handled inside the limiter callback. @preserve */
  } catch (err: unknown) {
    if (err instanceof ProxyDownloadQuotaError) {
      return res.status(503).send("Image download service is temporarily unavailable.");
    }
    /* v8 ignore next -- defensive limiter rejection path is not reachable through candidate fetch handling. @preserve */
    const msg = err instanceof Error ? err.message : String(err);
    /* v8 ignore next -- defensive limiter rejection path is not reachable through candidate fetch handling. @preserve */
    console.error("Google Drive fetch error:", { message: msg, id, lastError });
  } finally {
    req.off("aborted", abortActiveDownload);
  }
  /* v8 ignore stop */

  // Log the final failure reason if we have one
  /* v8 ignore else -- candidate loops always set lastError before a null result; this remains defensive for future candidate changes. @preserve */
  if (lastError) {
    console.error("MPC image proxy failed:", { id, size, lastError });
  }

  return res.status(502).send("Could not fetch MPC image");
});

// -------------------- Builtin cardback images --------------------
// Serves cardback images from the server to reduce client bundle size

const CARDBACK_MAP: Record<string, string> = {
  'mtg': 'mtg.png',
  'proxxied': 'proxxied.png',
  'classic-dots': 'classic-dots.png',
};

const cardbacksDir = resolveCardbacksDir();

export function resolveCardbacksDir(): string {
  const candidates = [
    // 1. Standard structure (src/routes -> src -> server -> cardbacks)
    path.join(__dirname, "..", "..", "cardbacks"),
    // 2. Deeper nesting (if dist structure varies)
    path.join(__dirname, "..", "..", "..", "cardbacks"),
    // 3. Process root fallback (often reliable in Docker)
    path.join(process.cwd(), "cardbacks"),
    // 4. Production build specific fallback
    path.join(process.cwd(), "dist", "server", "cardbacks"),
    // 5. Monorepo root fallback
    path.join(process.cwd(), "server", "cardbacks"),
  ];

  console.log("[Cardbacks] Resolving directory...");
  console.log(`[Cardbacks] __dirname: ${__dirname}`);
  console.log(`[Cardbacks] CWD: ${process.cwd()}`);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      console.log(`[Cardbacks] Found valid directory: ${candidate}`);
      // Verify it actually has images
      try {
        const files = fs.readdirSync(candidate);
        if (files.some(f => f.endsWith(".png"))) {
          return candidate;
        }
        console.warn(`[Cardbacks] Directory exists but has no PNGs: ${candidate}`);
      } catch (e) {
        console.warn(`[Cardbacks] Error reading directory ${candidate}:`, e);
      }
    }
  }

  console.error("[Cardbacks] FATAL: Could not find cardbacks directory in candidates:", candidates);
  // Fallback to strict relative path even if check failed, so we see the original error behavior
  return path.join(__dirname, "..", "..", "cardbacks");
}

imageRouter.get("/cardback/:id", (req: Request, res: Response) => {
  const rawId = req.params.id;
  /* v8 ignore next -- Express route params are strings for /cardback/:id; array form is a defensive type guard. @preserve */
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  /* v8 ignore next 3 -- Express cannot match /cardback/:id without a non-empty route parameter. @preserve */
  if (!id) {
    return res.status(400).send("Missing cardback ID");
  }
  const filename = CARDBACK_MAP[id];

  if (!filename) {
    return res.status(404).send("Unknown cardback ID");
  }

  const filePath = path.join(cardbacksDir, filename);

  if (!fs.existsSync(filePath)) {
    console.error(`Cardback file not found: ${filePath}`);
    return res.status(404).send("Cardback image not found");
  }

  // Set aggressive cache headers - these images never change
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Content-Type", "image/png");
  return res.sendFile(filePath);
});

export const __imageRouterTestInternals = {
  MAX_PROXY_CONCURRENT_DOWNLOADS,
  MAX_PROXY_RESPONSE_BYTES,
  MAX_PROXY_DOWNLOAD_RESERVED_BYTES,
  get proxyDownloadAdmission() {
    return proxyDownloadAdmission;
  },
  acceptsSurfaceableStatus,
  pLimit,
  checkAndCleanCache,
  cachePathFromUrl,
  disposeReadable,
  streamImageResponseToFile,
  getWithRetry,
  writeInProgress,
  setEnrichLookupTimeoutForTests: (timeoutMs: number) => {
    enrichLookupTimeoutMs = timeoutMs;
  },
  resetCacheCleanupForTests: () => {
    lastCacheCleanup = 0;
    enrichLookupTimeoutMs = 20_000;
    imageResolveAllForTests = undefined;
    proxyDownloadAdmission = createProxyDownloadAdmission({
      maxBytes: MAX_PROXY_DOWNLOAD_RESERVED_BYTES,
    });
  },
  setImageResolveAllForTests: (resolveAll: ResolveAll | undefined) => {
    imageResolveAllForTests = resolveAll;
  },
};

export { imageRouter };
