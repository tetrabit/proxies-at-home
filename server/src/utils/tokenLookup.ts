import type { CardInfo } from "../../../shared/types.js";
import type { TokenPart } from "../../../shared/types.js";
import type { ScryfallApiCard } from "./getCardImagesPaged.js";
import { batchFetchCards, getCardDataForCardInfo, getCardsWithImagesForCardInfo } from "./getCardImagesPaged.js";
import { getScryfallClient, isMicroserviceAvailable } from "../services/scryfallMicroserviceClient.js";
import { trackMicroserviceCall } from "../services/microserviceMetrics.js";
import { debugLog } from "./debug.js";
import axios from "axios";

// Microservice response wrapper types
interface MicroserviceResponse<T> {
  success?: boolean;
  data?: T;
}

interface CardListData {
  data?: ScryfallApiCard[];
}

interface ParsedTokenUri {
  id?: string;
  set?: string;
  number?: string;
}

const tokenIdLookupAxios = axios.create({
  headers: { "User-Agent": "Proxxied/1.0 (token-lookup)" },
  timeout: 10_000,
});

let lastTokenIdLookupAt = 0;

function parseTokenUri(uri?: string): ParsedTokenUri {
  if (!uri) return {};
  try {
    const parsed = new URL(uri);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const cardsIdx = parts.findIndex((p) => p === "cards");
    if (cardsIdx < 0) return {};
    const first = parts[cardsIdx + 1];
    const second = parts[cardsIdx + 2];
    if (!first) return {};
    if (!second) return { id: first };
    return { set: first.toLowerCase(), number: second };
  } catch {
    return {};
  }
}

async function delayTokenIdLookup(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastTokenIdLookupAt;
  if (elapsed < 100) {
    await new Promise((resolve) => setTimeout(resolve, 100 - elapsed));
  }
  lastTokenIdLookupAt = Date.now();
}

async function fetchCardByScryfallId(id: string): Promise<ScryfallApiCard | undefined> {
  if (!id) return undefined;
  await delayTokenIdLookup();
  try {
    const response = await tokenIdLookupAxios.get<ScryfallApiCard>(
      `https://api.scryfall.com/cards/${encodeURIComponent(id)}`
    );
    return response.data;
  } catch {
    return undefined;
  }
}

function sortByMostRecentPrint(a: ScryfallApiCard, b: ScryfallApiCard): number {
  const aTime = Date.parse(a.released_at ?? "") || 0;
  const bTime = Date.parse(b.released_at ?? "") || 0;
  if (aTime !== bTime) return bTime - aTime;

  const setCompare = String(b.set ?? "").localeCompare(String(a.set ?? ""));
  if (setCompare !== 0) return setCompare;

  return String(b.collector_number ?? "").localeCompare(String(a.collector_number ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function toResolvedTokenPart(card: ScryfallApiCard, fallback: TokenPart): TokenPart {
  const uri =
    card.set && card.collector_number
      ? `https://api.scryfall.com/cards/${card.set}/${card.collector_number}`
      : fallback.uri;

  const resolved: TokenPart = {
    id: card.id ?? fallback.id,
    name: card.name ?? fallback.name,
    ...(uri ? { uri } : {}),
  };
  const typeLine = card.type_line ?? fallback.type_line;
  if (typeLine) {
    resolved.type_line = typeLine;
  }
  return resolved;
}

async function resolveLinkedTokenCard(token: TokenPart, language: string): Promise<ScryfallApiCard | undefined> {
  if (token.id) {
    const byId = await fetchCardByScryfallId(token.id);
    if (byId) return byId;
  }

  const parsedUri = parseTokenUri(token.uri);
  if (parsedUri.id && parsedUri.id !== token.id) {
    const byUriId = await fetchCardByScryfallId(parsedUri.id);
    if (byUriId) return byUriId;
  }

  if (token.name && parsedUri.set && parsedUri.number) {
    const exactPrint = await getCardDataForCardInfo(
      { name: token.name, set: parsedUri.set, number: parsedUri.number, isToken: true },
      language,
      true
    );
    if (exactPrint) return exactPrint;
  }

  if (!token.name) return undefined;
  return (await getCardDataForCardInfo({ name: token.name, isToken: true }, language, true)) ?? undefined;
}

async function resolveMostRecentTokenPrint(linkedToken: ScryfallApiCard, language: string): Promise<ScryfallApiCard> {
  if (!linkedToken.oracle_id || !linkedToken.name) {
    return linkedToken;
  }

  const candidates = await getCardsWithImagesForCardInfo(
    { name: linkedToken.name, isToken: true },
    "prints",
    language,
    true
  );

  const oracleMatches = candidates.filter((card) => card.oracle_id === linkedToken.oracle_id);
  if (oracleMatches.length === 0) {
    return linkedToken;
  }

  oracleMatches.sort(sortByMostRecentPrint);
  return oracleMatches[0] ?? linkedToken;
}

// Small p-limit implementation to cap microservice concurrency.
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
    } catch (e) {
      reject(e);
    } finally {
      active--;
      if (q.length) {
        const next = q.shift();
        if (next) {
          const [nextFn, nextRes, nextRej] = next;
          run(nextFn, nextRes, nextRej);
        }
      }
    }
  };
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const wrappedResolve = resolve as Resolver;
      const wrappedReject = reject as Rejector;
      if (active < concurrency) run(fn, wrappedResolve, wrappedReject);
      else q.push([fn, wrappedResolve, wrappedReject]);
    });
}

export type TokenLookupResult = {
  cards: Map<string, ScryfallApiCard>;
  usedMicroservice: boolean;
};

function storeCardInResults(results: Map<string, ScryfallApiCard>, card: ScryfallApiCard | undefined): void {
  if (!card?.name) return;
  results.set(card.name.toLowerCase(), card);
  if (card.set && card.collector_number) {
    results.set(`${card.set.toLowerCase()}:${card.collector_number}`, card);
  }
  // Store by face names for DFCs (useful for name lookups that target a face)
  if (card.card_faces && Array.isArray(card.card_faces)) {
    for (const face of card.card_faces) {
      if (face?.name) {
        const faceKey = face.name.toLowerCase();
        if (!results.has(faceKey)) results.set(faceKey, card);
      }
    }
  }
}

async function fetchOneViaMicroservice(ci: CardInfo): Promise<ScryfallApiCard | undefined> {
  const client = getScryfallClient();

  if (ci.set && ci.number) {
    const q = `set:${ci.set} number:${ci.number}`;
    const resp = await trackMicroserviceCall('/search', () => client.searchCards({ q, page_size: 1 })) as MicroserviceResponse<CardListData>;
    const first = resp?.success ? resp.data?.data?.[0] : undefined;
    return first as ScryfallApiCard | undefined;
  }

  // Prefer exact name match; fall back to fuzzy.
  const exactResp = await trackMicroserviceCall('/cards/named', () => client.getCardByName({ exact: ci.name })) as MicroserviceResponse<ScryfallApiCard>;
  if (exactResp?.success && exactResp.data) {
    return exactResp.data as ScryfallApiCard;
  }

  const fuzzyResp = await trackMicroserviceCall('/cards/named', () => client.getCardByName({ fuzzy: ci.name })) as MicroserviceResponse<ScryfallApiCard>;
  if (fuzzyResp?.success && fuzzyResp.data) {
    return fuzzyResp.data as ScryfallApiCard;
  }

  return undefined;
}

/**
 * Fetch Scryfall card JSON for token lookup.
 *
 * If `SCRYFALL_CACHE_URL` is configured and the microservice health check passes,
 * prefer the microservice for lookups and fall back to the existing local cache
 * + direct Scryfall API only for misses/errors.
 */
export async function fetchCardsForTokenLookup(cardInfos: CardInfo[], language: string = "en"): Promise<TokenLookupResult> {
  const results = new Map<string, ScryfallApiCard>();
  if (!cardInfos || cardInfos.length === 0) return { cards: results, usedMicroservice: false };

  const hasExplicitUrl = !!process.env.SCRYFALL_CACHE_URL;
  const microserviceOk = hasExplicitUrl ? await isMicroserviceAvailable() : false;
  if (!microserviceOk) {
    return { cards: await batchFetchCards(cardInfos, language), usedMicroservice: false };
  }

  // Deduplicate queries to avoid spamming the microservice.
  const unique = new Map<string, CardInfo>();
  for (const ci of cardInfos) {
    const key = ci.set && ci.number ? `sn:${ci.set.toLowerCase()}:${ci.number}` : `n:${ci.name.toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, ci);
  }

  const limit = pLimit(8);
  const fetched = new Map<string, ScryfallApiCard | undefined>();
  const misses: CardInfo[] = [];

  await Promise.all(
    Array.from(unique.entries()).map(([key, ci]) =>
      limit(async () => {
        try {
          const card = await fetchOneViaMicroservice(ci);
          fetched.set(key, card);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          debugLog(`[tokenLookup] Microservice error for ${key}: ${msg}`);
          fetched.set(key, undefined);
        }
      })
    )
  );

  for (const ci of cardInfos) {
    const key = ci.set && ci.number ? `sn:${ci.set.toLowerCase()}:${ci.number}` : `n:${ci.name.toLowerCase()}`;
    const card = fetched.get(key);
    if (card) {
      storeCardInResults(results, card);
    } else {
      // Preserve the original inputs for the fallback path.
      misses.push(ci);
    }
  }

  if (misses.length > 0) {
    debugLog(`[tokenLookup] Microservice misses: ${misses.length}/${cardInfos.length}; falling back to batchFetchCards`);
    const fallback = await batchFetchCards(misses, language);
    for (const [k, v] of fallback.entries()) {
      if (!results.has(k)) results.set(k, v);
    }
  }

  return { cards: results, usedMicroservice: true };
}

/**
 * Resolve token parts to the newest print while preserving Scryfall-linked token identity.
 *
 * Rules:
 * 1) Resolve linked token identity from token part id/uri (exact print when possible).
 * 2) Expand by linked token oracle_id and pick most recent print.
 * 3) Fallback to original token part when lookup data is unavailable.
 */
export async function resolveLatestTokenParts(
  tokenParts: TokenPart[] | undefined,
  language: string = "en"
): Promise<TokenPart[]> {
  if (!tokenParts || tokenParts.length === 0) return [];

  const seenSourceKeys = new Set<string>();
  const seenResolvedKeys = new Set<string>();
  const resolved: TokenPart[] = [];

  for (const token of tokenParts) {
    if (!token.name) continue;
    const sourceKey = token.id ? `id:${token.id}` : `name:${token.name.toLowerCase()}`;
    if (seenSourceKeys.has(sourceKey)) continue;
    seenSourceKeys.add(sourceKey);

    const linkedToken = await resolveLinkedTokenCard(token, language);
    const latestToken = linkedToken ? await resolveMostRecentTokenPrint(linkedToken, language) : undefined;
    const nextToken = latestToken ? toResolvedTokenPart(latestToken, token) : token;
    const identityKey = nextToken.id ? `id:${nextToken.id}` : `name:${nextToken.name.toLowerCase()}`;

    if (seenResolvedKeys.has(identityKey)) continue;
    seenResolvedKeys.add(identityKey);
    resolved.push(nextToken);
  }

  return resolved;
}
