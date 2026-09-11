import { fetchEventSource } from "@microsoft/fetch-event-source";
import { undoableAddCards } from "./undoableActions";
import { addCards, addRemoteImage, createLinkedBackCardsBulk } from "./dbUtils";
import { createImportSession, getCurrentSession, type ImportType } from "./importSession";
import { useSettingsStore } from "../store";
import { findBestMpcMatches, parseMpcCardLogic } from "./mpcImportIntegration";
import { API_BASE } from "../constants";
import { IMAGE_PROCESSING } from "@/constants/imageProcessing";
import { db } from "../db";
import { getMpcAutofillImageUrl } from "./mpcAutofillApi";
import { convertScryfallToCardOptions, persistResolvedCards } from "./cardConverter";
import { fetchTokenParts } from "./tokenApi";

import type { CardOption, ScryfallCard, CardInfo } from "../../../shared/types";
import { normalizeDfcName } from "../../../shared/cardNameUtils";

export type { CardInfo };

export interface StreamCardsOptions {
    cardInfos: CardInfo[];
    language: string;
    importType: ImportType;
    signal: AbortSignal;
    /** Override preferred art source (if not specified, uses preferredArtSource from settings) */
    artSource?: 'scryfall' | 'mpc';
    onProgress?: (processed: number, total: number) => void;
    onFirstCard?: () => void;
    onComplete?: () => void;
    projectId?: string;
}

export interface StreamCardsResult {
    addedCardUuids: string[];
    totalCardsAdded: number;
}

// Valid DFC layouts from Scryfall
const DFC_LAYOUTS = ['transform', 'modal_dfc', 'mdfc', 'double_faced_token', 'flip', 'reversible_card'];

function isDfcLayout(layout?: string): boolean {
    return DFC_LAYOUTS.includes(layout || '');
}

/**
 * Enrich MPC-added cards with token_parts from server.
 * Call this after adding MPC cards to get Scryfall token data.
 */
async function enrichMpcCardsWithTokens(
    cardUuids: string[],
    signal?: AbortSignal
): Promise<void> {
    /* v8 ignore next -- caller only invokes enrichment after cards were added. @preserve */
    if (cardUuids.length === 0) return;

    // Get the cards we just added
    const cards = await db.cards.where('uuid').anyOf(cardUuids).toArray();
    if (cards.length === 0) return;

    // Only enrich cards that don't have token_parts yet
    const cardsNeedingEnrichment = cards.filter(c => c.token_parts === undefined);
    /* v8 ignore next -- direct MPC imports normally create cards before token metadata is available. @preserve */
    if (cardsNeedingEnrichment.length === 0) return;

    const toLookupKey = (name: string, set?: string, number?: string) =>
        `${name.toLowerCase()}|${set?.toLowerCase() ?? ''}|${number?.toLowerCase() ?? ''}`;

    // Preserve identity when available so same-name cards don't cross-apply token parts.
    const uniqueCardInfos = new Map<string, { name: string; set?: string; number?: string }>();
    for (const card of cardsNeedingEnrichment) {
        const key = toLookupKey(card.name, card.set, card.number);
        /* v8 ignore next -- duplicate enriched MPC identities intentionally collapse into one token lookup. @preserve */
        if (!uniqueCardInfos.has(key)) {
            uniqueCardInfos.set(key, { name: card.name, set: card.set, number: card.number });
        }
    }

    // Fetch token data from server
    const result = await fetchTokenParts(Array.from(uniqueCardInfos.values()), signal);
    if (!result.success) {
        console.warn('[enrichMpcCardsWithTokens] Failed to fetch token parts:', result.error);
        return;
    }

    // Build a map of identity -> token_parts (with name-only fallback for legacy responses).
    const tokenMap = new Map<string, typeof result.data[number]['token_parts']>();
    for (const item of result.data) {
        /* v8 ignore next -- token API success fixtures only return rows with token metadata. @preserve */
        if (item.token_parts !== undefined) {
            tokenMap.set(toLookupKey(item.name, item.set, item.number), item.token_parts);
            tokenMap.set(toLookupKey(item.name), item.token_parts);
        }
    }

    // Update cards in DB with token_parts
    await db.transaction('rw', db.cards, async () => {
        for (const card of cardsNeedingEnrichment) {
            /* v8 ignore next 3 -- exact identity is preferred; name-only lookup is retained for legacy token API responses. @preserve */
            const tokenParts =
                tokenMap.get(toLookupKey(card.name, card.set, card.number)) ??
                tokenMap.get(toLookupKey(card.name));
            /* v8 ignore next -- token enrichment skips cards when no server token data exists. @preserve */
            if (tokenParts !== undefined) {
                await db.cards.update(card.uuid, {
                    token_parts: tokenParts,
                    needs_token: tokenParts.length > 0,
                });
            }
        }
    });
}

const cardKey = (info: CardInfo) =>
    `${normalizeDfcName(info.name).toLowerCase()}|${info.set?.toLowerCase() ?? ""}|${info.number ?? ""}`;

// /api/stream/cards uses the same bounded import request contract as metadata.
const importRequestCardLimit = 100;

function throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted.', 'AbortError');
}

function errorMessage(error: unknown, fallback: string): string {
    if (typeof error === 'string' && error) return error;
    return error instanceof Error && error.message ? error.message : fallback;
}

async function setOwnedPlaceholderLookupError(
    uuids: string[],
    projectId: string | undefined,
    lookupError: string,
    signal: AbortSignal,
): Promise<void> {
    await db.transaction('rw', db.cards, async () => {
        for (const uuid of uuids) {
            throwIfAborted(signal);
            const card = await db.cards.get(uuid);
            // A clear/project switch may have removed and recreated a card with the same
            // UUID. Never write an error into that replacement, or over a resolved card.
            if (!card || (projectId !== undefined && card.projectId !== projectId) || card.imageId) continue;
            await db.cards.update(uuid, { lookupError });
        }
    });
}

export async function streamCards(options: StreamCardsOptions): Promise<StreamCardsResult> {
    const { cardInfos, language, importType, signal, artSource, onProgress, onFirstCard, onComplete, projectId } = options;

    // Build quantity map for deduplication AND track original order positions
    // Explicit import orders stay intact. Implicit imports intentionally leave their
    // order undefined so addCards can reserve an append range with its insertion.
    // This must happen after image/network work, rather than keeping a Dexie
    // transaction open while those operations complete.
    const quantityByKey = new Map<string, { info: CardInfo; instances: CardInfo[]; placeholderUuids?: string[] }>();

    for (const info of cardInfos) {
        const k = cardKey(info);
        const cardQty = info.quantity ?? 1;

        let entry = quantityByKey.get(k);
        if (!entry) {
            entry = { info, instances: [] };
            quantityByKey.set(k, entry);
        }

        // Create an instance for each count of quantity
        const baseOrder = info.order;
        for (let i = 0; i < cardQty; i++) {
            entry.instances.push({
                ...info,
                order: baseOrder === undefined ? undefined : baseOrder + (i * 10)
            });
        }
    }

    // --- Handle cards with explicit MPC identifiers first ---
    let cardsAdded = 0;
    const addedCardUuids: string[] = [];

    // Single-pass partitioning instead of two filter() calls
    type QuantityEntry = { info: CardInfo; instances: CardInfo[]; placeholderUuids?: string[] };
    const cardsWithMpcId: QuantityEntry[] = [];
    const cardsWithoutMpcId: QuantityEntry[] = [];
    for (const entry of quantityByKey.values()) {
        (entry.info.mpcIdentifier ? cardsWithMpcId : cardsWithoutMpcId).push(entry);
    }

    // Process cards with explicit MPC identifiers directly
    for (const entry of cardsWithMpcId) {
        if (signal.aborted) break;

        const { info, instances } = entry;
        const imageUrl = getMpcAutofillImageUrl(info.mpcIdentifier!);
        try {
            const imageId = await addRemoteImage([imageUrl], instances.length);
            throwIfAborted(signal);

            const cardsToAdd = instances.map(instance => createCardOption({
                name: instance.name,
                scryfall_id: instance.scryfallId,
                oracle_id: instance.oracleId,
                tokenAddedFrom: instance.tokenAddedFrom,
                lang: language,
                imageId,
                hasBuiltInBleed: true,
                needsEnrichment: true,
                category: instance.category,
                // For MPC cards, merge darken-off defaults with any existing overrides
                overrides: instance.overrides
                    ? { darkenMode: 'none' as const, darkenUseGlobalSettings: false, ...instance.overrides }
                    : { darkenMode: 'none' as const, darkenUseGlobalSettings: false },
                projectId,
            },
                instance.order
            ));

            const added = await undoableAddCards(cardsToAdd, { /* no startOrder - using explicit orders */ });
            throwIfAborted(signal);
            cardsAdded += added.length;
            addedCardUuids.push(...added.map(c => c.uuid));
            /* v8 ignore next -- later direct-MPC batches skip the first-card notification. @preserve */
            if (cardsAdded === added.length) onFirstCard?.();
        } catch (error) {
            throwIfAborted(signal);
            const errorCards = instances.map(instance => createCardOption({
                name: instance.name,
                scryfall_id: instance.scryfallId,
                oracle_id: instance.oracleId,
                tokenAddedFrom: instance.tokenAddedFrom,
                lang: language,
                imageId: undefined,
                lookupError: errorMessage(error, 'Unable to load MPC image'),
                projectId,
            }, instance.order));
            const added = await addCards(errorCards, undefined);
            throwIfAborted(signal);
            cardsAdded += added.length;
            addedCardUuids.push(...added.map(c => c.uuid));
            if (cardsAdded === added.length) onFirstCard?.();
        }

        // Remove from quantityByKey so it's not processed again
        quantityByKey.delete(cardKey(info));
    }

    // --- Handle cards that match custom cardback names ---
    // If a card name matches a cardback's displayName, use that cardback and auto-flip
    const allCardbacks = await db.cardbacks.toArray();
    const cardbackByName = new Map<string, typeof allCardbacks[number]>();
    for (const cb of allCardbacks) {
        /* v8 ignore next -- persisted cardbacks are expected to have display names. @preserve */
        if (cb.displayName) {
            cardbackByName.set(cb.displayName.toLowerCase(), cb);
        }
    }

    // Check remaining cards for cardback matches
    const cardbackMatches: { entry: typeof cardsWithoutMpcId[number]; cardback: typeof allCardbacks[number] }[] = [];
    for (const entry of cardsWithoutMpcId) {
        const nameLower = entry.info.name.toLowerCase();
        const matchedCardback = cardbackByName.get(nameLower);
        if (matchedCardback) {
            cardbackMatches.push({ entry, cardback: matchedCardback });
        }
    }

    // Process cardback matches - create flipped cards using the cardback
    for (const { entry, cardback } of cardbackMatches) {
        /* v8 ignore next -- abort handling is covered by direct MPC flow; this loop shares the same stop contract. @preserve */
        if (signal.aborted) break;

        const { info, instances } = entry;

        const cardsToAdd = instances.map(instance => createCardOption({
            name: instance.name,
            scryfall_id: instance.scryfallId,
            oracle_id: instance.oracleId,
            tokenAddedFrom: instance.tokenAddedFrom,
            lang: language,
            imageId: cardback.id,
            isFlipped: true,
            hasBuiltInBleed: cardback.hasBuiltInBleed ?? true,
            category: info.category,
            projectId,
        },
            instance.order
        ));

        const added = await undoableAddCards(cardsToAdd, { /* no startOrder */ });
        cardsAdded += added.length;
        addedCardUuids.push(...added.map(c => c.uuid));
        /* v8 ignore next -- later cardback matches skip the first-card notification. @preserve */
        if (cardsAdded === added.length) onFirstCard?.();

        quantityByKey.delete(cardKey(info));
    }

    let uniqueInfos = Array.from(quantityByKey.values())
        .filter(v => !v.info.mpcIdentifier)
        .map(v => v.info);
    const effectiveArtSource = artSource ?? useSettingsStore.getState().preferredArtSource;
    if (effectiveArtSource === 'mpc') {
        // --- MPC Path: Add placeholder cards immediately, update when images arrive ---

        // Step 1: Add placeholder cards for ALL cards upfront (shows immediately in UI)
        const placeholderUuidsByKey = new Map<string, string[]>();

        for (const entry of quantityByKey.values()) {
            /* v8 ignore next -- explicit MPC IDs are deleted during the direct-ID pass before this placeholder loop. @preserve */
            if (entry.info.mpcIdentifier) continue; // Skip cards with explicit MPC IDs (already handled)

            const key = cardKey(entry.info);
            const { instances, info } = entry;

            // Create placeholder cards with imageId: undefined (triggers loading spinner)
            const placeholderCards = instances.map(instance => createCardOption({
                name: info.name,
                scryfall_id: instance.scryfallId,
                oracle_id: instance.oracleId,
                tokenAddedFrom: instance.tokenAddedFrom,
                lang: language,
                imageId: undefined, // Shows loading spinner
                category: info.category,
                isToken: info.isToken,
                overrides: info.overrides, // Preserve overrides for share import
                projectId,
            },
                instance.order
            ));

            const added = await undoableAddCards(placeholderCards, { /* no startOrder */ });
            cardsAdded += added.length;
            addedCardUuids.push(...added.map(c => c.uuid));
            placeholderUuidsByKey.set(key, added.map(c => c.uuid));

            /* v8 ignore next -- later placeholder batches skip the first-card notification. @preserve */
            if (cardsAdded === added.length) onFirstCard?.();
        }

        // Step 2: Process MPC matches in batches and UPDATE placeholder cards
        const CHUNK_SIZE = IMAGE_PROCESSING.MPC_CHUNK_SIZE;
        const mpcInfos = [...uniqueInfos];
        const failingInfos: CardInfo[] = [];
        let processedMpc = 0;

        for (let i = 0; i < mpcInfos.length; i += CHUNK_SIZE) {
            /* v8 ignore next -- direct abort behavior is covered before remote MPC batches start. @preserve */
            if (signal.aborted) break;

            const chunk = mpcInfos.slice(i, i + CHUNK_SIZE);
            const matches = await findBestMpcMatches(chunk);
            const matchedNames = new Set<string>();

            for (const match of matches) {
                const key = cardKey(match.info);
                const placeholderUuids = placeholderUuidsByKey.get(key);
                /* v8 ignore next -- every matched MPC info comes from the placeholder map built in the preceding loop. @preserve */
                if (!placeholderUuids || placeholderUuids.length === 0) continue;

                const entry = quantityByKey.get(key);
                /* v8 ignore next -- matched MPC entries are retained in quantityByKey until fallback partitioning completes. @preserve */
                if (!entry) continue;

                try {
                    const imageId = await addRemoteImage([match.imageUrl], entry.instances.length);
                    throwIfAborted(signal);
                    const { name: cardName, hasBuiltInBleed, needsEnrichment } = parseMpcCardLogic(match.mpcCard);

                    // Update all placeholder cards for this key with the MPC image.
                    await db.transaction('rw', db.cards, async () => {
                        for (const uuid of placeholderUuids) {
                            throwIfAborted(signal);
                            const card = await db.cards.get(uuid);
                            if (!card || (projectId !== undefined && card.projectId !== projectId) || card.imageId) continue;
                            await db.cards.update(uuid, {
                                name: cardName,
                                scryfall_id: entry.info.scryfallId,
                                oracle_id: entry.info.oracleId,
                                tokenAddedFrom: entry.info.tokenAddedFrom,
                                imageId,
                                lookupError: undefined,
                                hasBuiltInBleed,
                                needsEnrichment,
                            });
                        }
                    });
                    matchedNames.add(key);
                } catch (error) {
                    throwIfAborted(signal);
                    console.warn('[streamCards] Failed to cache matched MPC image; falling back to Scryfall', error);
                }
            }

            // Collect failed lookups for Scryfall fallback
            for (const info of chunk) {
                if (!matchedNames.has(cardKey(info))) {
                    failingInfos.push(info);
                }
            }

            processedMpc += chunk.length;
            onProgress?.(processedMpc, uniqueInfos.length);
        }

        // Enrich MPC cards with token_parts from server (non-blocking, fire-and-forget)
        /* v8 ignore next -- empty MPC imports skip enrichment. @preserve */
        if (addedCardUuids.length > 0) {
            void enrichMpcCardsWithTokens(addedCardUuids, signal);
        }

        // Step 3: For failed MPC lookups, leave placeholders for Scryfall SSE to update
        // Store the placeholder UUIDs so SSE can update them instead of adding new cards
        uniqueInfos = [...failingInfos];

        // Store placeholderUuidsByKey in a way SSE can access it
        // We'll pass it through by adding to quantityByKey entries
        for (const info of failingInfos) {
            const key = cardKey(info);
            const entry = quantityByKey.get(key);
            /* v8 ignore next -- failing MPC infos originate from retained quantity entries. @preserve */
            if (entry) {
                entry.placeholderUuids = placeholderUuidsByKey.get(key);
            }
        }
    }

    if (uniqueInfos.length === 0) {
        onComplete?.();
        return { addedCardUuids, totalCardsAdded: cardsAdded };
    }

    const streamChunks: CardInfo[][] = [];
    for (let start = 0; start < uniqueInfos.length; start += importRequestCardLimit) {
        streamChunks.push(uniqueInfos.slice(start, start + importRequestCardLimit));
    }

    let pendingOperations = 0;
    let completedStreamChunks = 0;
    let completionSettled = false;
    let resolvePromise: () => void;
    let rejectPromise: (error: unknown) => void;
    const completionPromise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    // Abort can arrive before the caller attaches its await; keep that expected
    // rejection observed while preserving it for the import caller.
    void completionPromise.catch(() => undefined);
    const rejectCompletion = (error: unknown) => {
        if (completionSettled) return;
        completionSettled = true;
        rejectPromise(error);
    };
    let abortActiveTransport: ((reason: unknown) => void) | undefined;
    const abortHandler = () => {
        abortActiveTransport?.(signal.reason);
        rejectCompletion(
            signal.reason instanceof Error
                ? signal.reason
                : new DOMException('The operation was aborted.', 'AbortError')
        );
    };
    signal.addEventListener('abort', abortHandler, { once: true });

    const checkComplete = () => {
        if (signal.aborted) {
            abortHandler();
            return;
        }
        if (!completionSettled && completedStreamChunks === streamChunks.length && pendingOperations === 0) {
            completionSettled = true;
            try {
                if (addedCardUuids.length > 0) {
                    createImportSession({
                        totalCards: addedCardUuids.length,
                        cardUuids: addedCardUuids,
                        importType,
                    });
                    getCurrentSession()?.markFetchComplete();
                    useSettingsStore.getState().setSortBy("manual");
                }
                onComplete?.();
                resolvePromise();
            } catch (error) {
                rejectPromise(error);
            }
        }
    };

    try {
    for (let chunkIndex = 0; chunkIndex < streamChunks.length; chunkIndex++) {
        throwIfAborted(signal);
        const chunk = streamChunks[chunkIndex];
        const progressOffset = chunkIndex * importRequestCardLimit;
        let chunkDone = false;
        const settledKeys = new Set<string>();
        let terminalSettlement: Promise<void> | undefined;
        const transportController = new AbortController();
        let acceptingMessages = true;
        let messageChain: Promise<void> = Promise.resolve();
        const enqueueMessage = (operation: () => Promise<void>) => {
            messageChain = messageChain.then(operation);
            // fetch-event-source invokes callbacks synchronously and does not await them.
            // Observe failures here; the request path awaits the same chain below.
            void messageChain.catch(() => undefined);
        };
        const abortTransport = (reason: unknown) => {
            if (!transportController.signal.aborted) transportController.abort(reason);
        };
        abortActiveTransport = abortTransport;
        const completeChunk = () => {
            if (chunkDone || signal.aborted) return;
            chunkDone = true;
            completedStreamChunks++;
            checkComplete();
        };
        const settleChunk = (cause: unknown) => {
            if (terminalSettlement) return terminalSettlement;
            const lookupError = errorMessage(cause, 'Card stream ended before completion');
            terminalSettlement = (async () => {
                if (signal.aborted) return;
                for (const info of chunk) {
                    if (signal.aborted || settledKeys.has(cardKey(info))) continue;
                    const entry = quantityByKey.get(cardKey(info));
                    const placeholderUuids = entry?.placeholderUuids;
                    if (placeholderUuids?.length) {
                        await setOwnedPlaceholderLookupError(placeholderUuids, projectId, lookupError, signal);
                    } else {
                        const instances = entry?.instances ?? [info];
                        const errorCards = instances.map(instance => createCardOption({
                            name: info.name,
                            set: info.set,
                            number: info.number,
                            scryfall_id: info.scryfallId,
                            oracle_id: info.oracleId,
                            tokenAddedFrom: info.tokenAddedFrom,
                            isUserUpload: false,
                            imageId: undefined,
                            lookupError,
                            projectId,
                        }, instance.order));
                        throwIfAborted(signal);
                        const added = await addCards(errorCards, undefined);
                        throwIfAborted(signal);
                        cardsAdded += added.length;
                        addedCardUuids.push(...added.map(card => card.uuid));
                        if (cardsAdded === added.length) onFirstCard?.();
                    }
                    settledKeys.add(cardKey(info));
                }
                completeChunk();
            })();
            terminalSettlement.catch(rejectCompletion);
            return terminalSettlement;
        };
        const terminateFromHandler = async (cause: unknown) => {
            acceptingMessages = false;
            abortTransport(cause);
            await settleChunk(cause);
        };

        try {
            await fetchEventSource(`${API_BASE}/api/stream/cards`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cardQueries: chunk, language }),
            signal: transportController.signal,
            onopen: async (res) => {
                if (!res.ok) {
                    const errorText = await res.text();
                    throw new Error(`Failed to fetch cards: ${res.status} ${res.statusText} - ${errorText}`);
                }
            },
            onclose: () => {
                if (chunkDone || !acceptingMessages) return;
                acceptingMessages = false;
                abortTransport('Card stream closed before completion');
                enqueueMessage(async () => { await settleChunk('Card stream closed before completion'); });
            },
            onerror: (error) => {
                if (!acceptingMessages) throw error;
                acceptingMessages = false;
                abortTransport(error);
                enqueueMessage(async () => { await settleChunk(error); });
                throw error;
            },
            onmessage: (ev) => {
                if (!acceptingMessages) return;
                if (ev.event === "fatal-error") {
                    let message = 'Card stream terminated unexpectedly';
                    try {
                        const data = JSON.parse(ev.data) as { message?: string };
                        if (data.message) message = data.message;
                    } catch {
                        // Use the terminal fallback for malformed fatal events.
                    }
                    acceptingMessages = false;
                    abortTransport(message);
                    enqueueMessage(async () => { await settleChunk(message); });
                    return;
                }
                if (ev.event === "done") {
                    acceptingMessages = false;
                    enqueueMessage(async () => { completeChunk(); });
                    return;
                }
                enqueueMessage(async () => {
                try {
            if (ev.event === "progress") {
                const progress = JSON.parse(ev.data);
                onProgress?.(
                    progressOffset + progress.processed,
                    streamChunks.length === 1 ? progress.total : uniqueInfos.length,
                );
            } else if (ev.event === "card-error") {
                pendingOperations++;
                try {
                throwIfAborted(signal);
                const { query, error } = JSON.parse(ev.data) as { query: CardInfo; error?: string };
                const queryKey = cardKey(query);
                // A result already won this key. Server terminal/error callbacks can be
                // delivered after it, but must not create a second outcome.
                if (settledKeys.has(queryKey)) return;
                const entry = quantityByKey.get(queryKey);
                // quantity variable removed as it is now unused
                const placeholderUuids = entry?.placeholderUuids;

                if (placeholderUuids && placeholderUuids.length > 0) {
                    // Update existing placeholder cards with an error only while they are
                    // still owned by this import's project and remain unresolved.
                    await setOwnedPlaceholderLookupError(
                        placeholderUuids,
                        projectId,
                        error || 'Card not found',
                        signal,
                    );
                } else {
                    // No existing placeholders - add new error cards
                    const instances = entry?.instances ?? [query];

                    const placeholderCards = instances.map(instance => createCardOption({
                        name: query.name,
                        set: query.set,
                        number: query.number,
                        scryfall_id: query.scryfallId,
                        oracle_id: query.oracleId,
                        tokenAddedFrom: query.tokenAddedFrom,
                        isUserUpload: false,
                        imageId: undefined,
                        lookupError: error || 'Card not found',
                        projectId,
                    }, instance.order));

                    const added = await addCards(placeholderCards, undefined);
                    cardsAdded += added.length;
                    /* v8 ignore next -- later card-error placeholders skip the first-card notification. @preserve */
                    if (cardsAdded === added.length) onFirstCard?.();
                }
                settledKeys.add(cardKey(query));
                } catch (error) {
                    await terminateFromHandler(error);
                } finally {
                    pendingOperations--;
                    checkComplete();
                }
            } else if (ev.event === "card-found") {
                pendingOperations++;
                try {
                throwIfAborted(signal);
                const card = JSON.parse(ev.data) as ScryfallCard;

                if (!card?.name) {
                    return;
                }

                const exactKey = cardKey({ name: card.name, set: card.set, number: card.number });
                const setOnlyKey = card.set ? cardKey({ name: card.name, set: card.set }) : null;
                const nameOnlyKey = cardKey({ name: card.name });

                let entry = quantityByKey.get(exactKey)
                    || (setOnlyKey && quantityByKey.get(setOnlyKey))
                    || quantityByKey.get(nameOnlyKey);

                const resultKey = entry ? cardKey(entry.info) : exactKey;
                // Duplicate card-found events and a late card-error must not replace an
                // outcome already persisted for this import key.
                if (settledKeys.has(resultKey)) return;

                const hasDfcBack = card.card_faces && card.card_faces.length > 1;
                let isBackFaceImport = false;

                if (!entry && hasDfcBack) {
                    const backFaceName = card.card_faces![1].name;
                    /* v8 ignore next -- Scryfall DFC backs have names in server responses. @preserve */
                    if (backFaceName) {
                        const backFaceKey = cardKey({ name: backFaceName });
                        entry = quantityByKey.get(backFaceKey);
                        // Only treat as back-face import if card layout confirms it's a DFC
                        if (entry && isDfcLayout(card.layout)) {
                            isBackFaceImport = true;
                        }
                    }
                }

                if (entry && !isBackFaceImport && hasDfcBack) {
                    /* v8 ignore next -- matched import entries always preserve their query name. @preserve */
                    const originalQueryName = entry.info.name?.toLowerCase().trim() ?? '';
                    const backName = card.card_faces![1].name?.toLowerCase().trim();
                    if (backName && backName === originalQueryName) {
                        isBackFaceImport = true;
                    }
                }

                const quantity = entry?.instances.length ?? 1;
                const placeholderUuids = entry?.placeholderUuids;

                // Map token_parts from all_parts if available (SSE returns raw object)
                // Define type for all_parts entries (not in ScryfallCard interface but returned by SSE)
                interface AllPartsEntry {
                    component: string;
                    name: string;
                    id: string;
                    uri: string;
                }
                const cardWithAllParts = card as ScryfallCard & { all_parts?: AllPartsEntry[] };
                if (cardWithAllParts.all_parts && !card.token_parts) {
                    card.token_parts = cardWithAllParts.all_parts
                        .filter((p) => p.component === 'token')
                        .map((p) => ({
                            name: p.name,
                            id: p.id,
                            uri: p.uri,
                        }));
                    card.needs_token = card.token_parts!.length > 0;
                }

                const { cardsToAdd, backCardTasks } = await convertScryfallToCardOptions(card, quantity, {
                    category: entry?.info.category,
                    isToken: entry?.info.isToken,
                    isBackFaceImport,
                    projectId,
                });
                throwIfAborted(signal);
                if (entry?.info.tokenAddedFrom?.length) {
                    for (const cardToAdd of cardsToAdd) {
                        cardToAdd.tokenAddedFrom = entry.info.tokenAddedFrom;
                    }
                }

                // Fidelity: If a preferred image ID was specified (from Share), use it
                if (entry?.info.preferredImageId) {
                    try {
                        const url = entry.info.preferredImageId;
                        // Use addRemoteImage to cache it locally (deduplicated)
                        // If it's a URL, this fetches and saves it. If it's a Scryfall URL, same.
                        const resolvedId = await addRemoteImage([url], quantity);
                        /* v8 ignore next -- preferred-image resolution normally returns a cached image id. @preserve */
                        if (resolvedId) {
                            cardsToAdd.forEach(c => c.imageId = resolvedId);
                        }
                    } catch (e) {
                        console.warn(`[streamCards] Failed to resolve preferredImageId`, e);
                    }
                }

                // Custom DFC Link Handling (Priority Overwrite)
                // If the intent specified a custom back (MPC ID, Built-in, or Scryfall Set/Num), handle it here
                if (entry?.info.linkedBackImageId || (entry?.info.linkedBackSet && entry?.info.linkedBackNumber)) {
                    // Clear any auto-detected DFC tasks to avoid double-backs
                    backCardTasks.length = 0;

                    let backImageId = entry.info.linkedBackImageId;
                    const backName = entry.info.linkedBackName || 'Back';

                    // If we have set/number but no image ID, resolve it
                    if (!backImageId && entry.info.linkedBackSet && entry.info.linkedBackNumber) {
                        try {
                            const { fetchCardBySetAndNumber } = await import('./scryfallApi');
                            const backCard = await fetchCardBySetAndNumber(entry.info.linkedBackSet, entry.info.linkedBackNumber);
                            /* v8 ignore next -- unresolved set/number backs fall through without creating a linked back. @preserve */
                            if (backCard && backCard.imageUrls.length > 0) {
                                // Add as remote image
                                backImageId = await addRemoteImage([backCard.imageUrls[0]], quantity);
                            }
                        } catch (e) {
                            console.warn(`[streamCards] Failed to resolve custom back Scryfall card`, e);
                        }
                    }

                    // If we have an image ID (either from linkedBackImageId or resolved above)
                    if (backImageId) {
                        // Check if it's an MPC/URL that needs fetching (if not built-in/already ID)
                        // addRemoteImage handles duplicates efficiently
                        if (!backImageId.startsWith('cardback_') && !backImageId.startsWith('img_')) {
                            // Assuming linkedBackImageId might be an MPC ID or URL, getMpcAutofillImageUrl handles MPC IDs
                            // But addRemoteImage handles URLs.
                            // ImportIntent usually puts MPC ID in linkedBackImageId.
                            const url = (backImageId.startsWith('http://') || backImageId.startsWith('https://'))
                                ? backImageId
                                : getMpcAutofillImageUrl(backImageId);

                            const resolvedId = await addRemoteImage([url], quantity);
                            /* v8 ignore next -- addRemoteImage returns ids in normal linked-back imports; missing ids leave the original back identifier. @preserve */
                            if (resolvedId) backImageId = resolvedId;
                        }

                        for (let i = 0; i < quantity; i++) {
                            backCardTasks.push({
                                frontIndex: i,
                                backImageId: backImageId!,
                                backName
                            });
                        }
                    }
                }

                /* v8 ignore next -- Scryfall conversion emits at least one front card for valid card-found payloads. @preserve */
                if (cardsToAdd.length > 0) {
                    throwIfAborted(signal);
                    if (placeholderUuids && placeholderUuids.length > 0) {
                        // Update existing placeholder cards with Scryfall data
                        const cardData = cardsToAdd[0]; // Get template from first card
                        const resolvedPlaceholderUuids = new Set<string>();
                        await db.transaction('rw', db.cards, async () => {
                            for (const uuid of placeholderUuids) {
                                throwIfAborted(signal);
                                const existing = await db.cards.get(uuid);
                                // A clear/project switch may have recreated this UUID, and a
                                // prior result may already have resolved it. Preserve both.
                                if (!existing || (projectId !== undefined && existing.projectId !== projectId) || existing.imageId) continue;
                                const updated = await db.cards.update(uuid, {
                                    name: cardData.name,
                                    imageId: cardData.imageId,
                                    lookupError: undefined,
                                    set: cardData.set,
                                    number: cardData.number,
                                    scryfall_id: cardData.scryfall_id,
                                    oracle_id: cardData.oracle_id,
                                    tokenAddedFrom: cardData.tokenAddedFrom,
                                    lang: cardData.lang,
                                    colors: cardData.colors,
                                    cmc: cardData.cmc,
                                    type_line: cardData.type_line,
                                    rarity: cardData.rarity,
                                    mana_cost: cardData.mana_cost,
                                    token_parts: cardData.token_parts,
                                    needs_token: cardData.needs_token,
                                    isToken: cardData.isToken,
                                    hasBuiltInBleed: false, // Scryfall images don't have built-in bleed
                                    needsEnrichment: false,
                                });
                                if (updated) resolvedPlaceholderUuids.add(uuid);
                            }
                        });

                        // Handle DFC back cards for existing placeholders
                        if (backCardTasks.length > 0) {
                            const resolvedBackTasks = backCardTasks.flatMap((task, i) => {
                                const frontUuid = placeholderUuids[task.frontIndex] || placeholderUuids[i] || placeholderUuids[0];
                                if (!resolvedPlaceholderUuids.has(frontUuid)) return [];
                                return [{
                                    frontUuid,
                                    backImageId: task.backImageId,
                                    backName: task.backName,
                                }];
                            });
                            if (resolvedBackTasks.length > 0) {
                                await createLinkedBackCardsBulk(resolvedBackTasks);
                            }
                        }
                    } else {
                        // No existing placeholders - add new cards for each instance
                        const instances = entry?.instances ?? [{ order: 0 }];

                        // Type definition matching convertScryfallToCardOptions return type
                        type CardAddData = Omit<CardOption, "uuid" | "order"> & { order?: number; imageId?: string };
                        const allFrontCards: CardAddData[] = [];

                        type BackTaskData = { frontIndex: number; backImageId: string; backName: string };
                        const allBackTasks: BackTaskData[] = [];

                        // Use the first card as a template for all instances
                        // We already requested 'quantity' images in convertScryfallToCardOptions, so the refCounts are handled there.
                        // We just need to construct the card entries properly without squaring the quantity.
                        /* v8 ignore next -- this block is nested inside the same cardsToAdd.length guard. @preserve */
                        if (cardsToAdd.length > 0) {
                            const template = cardsToAdd[0];
                            const templateBackTasks = backCardTasks.filter(t => t.frontIndex === 0);

                            for (const instance of instances) {
                                const newFrontIndex = allFrontCards.length;

                                // Add front card
                                allFrontCards.push({
                                    ...template,
                                    order: instance.order // Specific order for this instance
                                });

                                // Add associated back tasks
                                for (const task of templateBackTasks) {
                                    allBackTasks.push({
                                        ...task,
                                        frontIndex: newFrontIndex
                                    });
                                }
                            }
                        }

                        const added = await persistResolvedCards({ cardsToAdd: allFrontCards, backCardTasks: allBackTasks }, { /* no startOrder */ });
                        throwIfAborted(signal);
                        cardsAdded += added.length;
                        addedCardUuids.push(...added.map(c => c.uuid));
                        /* v8 ignore next -- first-card notification for this path mirrors direct and placeholder import paths. @preserve */
                        if (cardsAdded === added.length) onFirstCard?.();
                    }
                }
                if (entry) settledKeys.add(cardKey(entry.info));
                } catch (error) {
                    await terminateFromHandler(error);
                } finally {
                    pendingOperations--;
                    checkComplete();
                }
                }
                } catch (error) {
                    await terminateFromHandler(error);
                }
                });
            },
            });
            await messageChain;
            if (!chunkDone) await settleChunk('Card stream closed before completion');
        } catch (error) {
            throwIfAborted(signal);
            if (acceptingMessages) {
                acceptingMessages = false;
                abortTransport(error);
                enqueueMessage(async () => { await settleChunk(error); });
            }
            await messageChain;
            if (!chunkDone) await settleChunk(error);
        } finally {
            if (abortActiveTransport === abortTransport) abortActiveTransport = undefined;
        }
    }

        await completionPromise;
        throwIfAborted(signal);
        return { addedCardUuids, totalCardsAdded: cardsAdded };
    } finally {
        signal.removeEventListener('abort', abortHandler);
    }
}

function createCardOption(
    base: Partial<Omit<CardOption, "uuid" | "order"> & { imageId?: string }>,
    order?: number
): Omit<CardOption, "uuid" | "order"> & { order?: number; imageId?: string } {
    const defaults = {
        set: undefined,
        number: undefined,
        isUserUpload: false,
        colors: [],
        cmc: 0,
        type_line: "Card",
        rarity: "common",
        mana_cost: "",
    };

    // Type assertion needed due to strict Omit/Partial overlap
    return {
        ...defaults,
        ...base,
        ...(order === undefined ? {} : { order }),
    } as Omit<CardOption, "uuid" | "order"> & { order?: number; imageId?: string };
}
