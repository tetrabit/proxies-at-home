import type { CardInfo } from "../../../shared/types.js";
import type { ScryfallApiCard } from "./getCardImagesPaged.js";
import { batchFetchCards } from "./getCardImagesPaged.js";
import { getScryfallClient, isMicroserviceAvailable } from "../services/scryfallMicroserviceClient.js";
import { trackMicroserviceCall } from "../services/microserviceMetrics.js";
import { debugLog } from "./debug.js";

// Microservice response wrapper types
interface MicroserviceResponse<T> {
  success?: boolean;
  data?: T;
}

interface CardListData {
  data?: ScryfallApiCard[];
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
