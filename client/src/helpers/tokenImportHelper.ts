import { ImportOrchestrator } from "./ImportOrchestrator";
import { db } from "@/db";
import type { CardOption } from "@/types";
import { isCardbackId } from "./cardbackLibrary";
import type { ImportIntent } from "./importParsers";
import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settings";

export interface AutoTokenOptions {
    signal?: AbortSignal;
    onComplete?: () => void;
    onNoTokens?: () => void;
    silent?: boolean;
    /**
     * If true, bypasses the autoImportTokens setting check.
     * Use for explicit user-triggered actions.
     */
    force?: boolean;
}

export interface TwoSidedTokenImportResult {
    importedTokenCount: number;
    pairedTokenCount: number;
    unpairedTokenCount: number;
}

export type PairableTokenCard = CardOption & { imageId: string };

export type TwoSidedTokenPair = {
    front: PairableTokenCard;
    back: PairableTokenCard;
};

/**
 * Triggers import of missing tokens for cards that need them.
 * Checks autoImportTokens setting and returns early if disabled.
 */
export async function handleAutoImportTokens(options: AutoTokenOptions = {}) {
    const { silent = false } = options;

    // Check global setting - return early if disabled
    if (!options.force && !useSettingsStore.getState().autoImportTokens) {
        return;
    }

    try {
        await ImportOrchestrator.importMissingTokens({
            skipExisting: silent,
            signal: options.signal,
            onComplete: options.onComplete,
            onNoTokens: options.onNoTokens,
        });
    } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
            // Ignore aborts
            return;
        }
        console.error("Failed to auto-import tokens:", err);
        if (!silent) {
            // Re-throw or alert if not silent?
            // The original code in DecklistUploader alert()ed non-aborts.
            // MpcImportSection just console.error'd.
            // We'll let the caller decide or just throw non-aborts.
            throw err;
        }
    }
}

/**
 * Manual token import triggered by user action.
 * Always performs a full project scan (refreshes token_parts for all cards)
 * and skips existing tokens to prevent duplicates.
 */
export async function handleManualTokenImport(options: Omit<AutoTokenOptions, 'force'> = {}) {
    const { silent = false } = options;

    try {
        await ImportOrchestrator.importMissingTokens({
            skipExisting: true, // Always skip existing to prevent duplicates
            forceRefresh: true, // Always refresh all cards for full project scan
            signal: options.signal,
            onComplete: options.onComplete,
            onNoTokens: options.onNoTokens,
        });
    } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
            // Ignore aborts
            return;
        }
        console.error("Failed to import tokens:", err);
        if (!silent) {
            throw err;
        }
    }
}

/**
 * Manual token import that turns the newly imported tokens into shuffled two-sided cards.
 * The front and back are never the same token identity or the same image/art.
 */
export async function handleManualTwoSidedTokenImport(options: Omit<AutoTokenOptions, 'force'> = {}): Promise<TwoSidedTokenImportResult> {
    const { silent = false } = options;

    try {
        const projectId = useProjectStore.getState().currentProjectId;
        if (!projectId) {
            options.onNoTokens?.();
            return emptyTwoSidedResult();
        }

        const beforeCards = await db.cards
            .where('projectId').equals(projectId)
            .toArray();
        const beforeUuids = new Set(beforeCards.map((card) => card.uuid));

        let importFoundNoTokens = false;
        const tokenIntents = await ImportOrchestrator.importMissingTokens({
            skipExisting: true,
            forceRefresh: true,
            signal: options.signal,
            onNoTokens: () => {
                importFoundNoTokens = true;
            },
        });

        const afterCards = await db.cards
            .where('projectId').equals(projectId)
            .toArray();
        const importedTokens = getImportedTokenCards(afterCards, tokenIntents, beforeUuids);
        const tokensToPair = importedTokens.length > 0
            ? importedTokens
            : getExistingAssociatedTokenCards(afterCards);

        if (tokensToPair.length === 0) {
            if (importFoundNoTokens || tokenIntents.length === 0) {
                options.onNoTokens?.();
            }
            return emptyTwoSidedResult();
        }

        const pairs = createShuffledTwoSidedTokenPairs(tokensToPair);

        if (pairs.length > 0) {
            await applyTwoSidedTokenBacks(pairs);
        }

        options.onComplete?.();

        return {
            importedTokenCount: tokensToPair.length,
            pairedTokenCount: pairs.length,
            unpairedTokenCount: Math.max(0, tokensToPair.length - pairs.length),
        };
    } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
            return emptyTwoSidedResult();
        }
        console.error("Failed to import two-sided tokens:", err);
        if (!silent) {
            throw err;
        }
        return emptyTwoSidedResult();
    }
}

function emptyTwoSidedResult(): TwoSidedTokenImportResult {
    return {
        importedTokenCount: 0,
        pairedTokenCount: 0,
        unpairedTokenCount: 0,
    };
}

function getImportedTokenCards(
    cards: CardOption[],
    tokenIntents: ImportIntent[],
    beforeUuids: Set<string>
): PairableTokenCard[] {
    const intentIdentityKeys = new Set(tokenIntents.map(getIntentIdentityKey));

    return cards
        .filter((card): card is PairableTokenCard => {
            if (beforeUuids.has(card.uuid)) return false;
            if (card.linkedFrontId) return false;
            if (!card.imageId) return false;
            if (!isTokenCard(card)) return false;
            return intentIdentityKeys.has(getCardIdentityKey(card));
        })
        .sort((a, b) => a.order - b.order);
}

function getExistingAssociatedTokenCards(cards: CardOption[]): PairableTokenCard[] {
    const associatedTokenKeys = new Set<string>();

    for (const card of cards) {
        if (card.linkedFrontId) continue;
        if (isTokenCard(card)) continue;
        for (const token of card.token_parts ?? []) {
            if (!token.name) continue;
            associatedTokenKeys.add(getTokenPartIdentityKey(token));
        }
    }

    return cards
        .filter((card): card is PairableTokenCard => {
            if (card.linkedFrontId) return false;
            if (!card.imageId) return false;
            if (!isTokenCard(card)) return false;
            if (card.tokenAddedFrom && card.tokenAddedFrom.length > 0) return true;
            return associatedTokenKeys.has(getCardIdentityKey(card));
        })
        .sort((a, b) => a.order - b.order);
}

function isTokenCard(card: Pick<CardOption, "isToken" | "type_line">): boolean {
    return card.isToken === true || card.type_line?.toLowerCase().includes("token") === true;
}

async function applyTwoSidedTokenBacks(pairs: TwoSidedTokenPair[]): Promise<void> {
    const frontUuidSet = new Set(pairs.map(({ front }) => front.uuid));
    const frontUuids = Array.from(frontUuidSet);

    await db.transaction("rw", db.cards, db.images, async () => {
        const currentFronts = await db.cards.bulkGet(frontUuids);
        const currentFrontByUuid = new Map(
            currentFronts
                .filter((card): card is CardOption => card !== undefined)
                .map((card) => [card.uuid, card])
        );

        const projectIds = Array.from(
            new Set(currentFronts.map((card) => card?.projectId).filter(Boolean))
        ) as string[];
        const projectCards = projectIds.length === 1
            ? await db.cards.where("projectId").equals(projectIds[0]).toArray()
            : await db.cards.toArray();

        const cardByUuid = new Map(projectCards.map((card) => [card.uuid, card]));
        const backsByFrontUuid = new Map<string, CardOption[]>();

        for (const card of projectCards) {
            if (!card.linkedFrontId || !frontUuidSet.has(card.linkedFrontId)) continue;
            const backs = backsByFrontUuid.get(card.linkedFrontId) ?? [];
            backs.push(card);
            backsByFrontUuid.set(card.linkedFrontId, backs);
        }

        const cardUpdates: { key: string; changes: Partial<CardOption> }[] = [];
        const newBackCards: CardOption[] = [];
        const imageRefDeltas = new Map<string, number>();

        for (const { front, back } of pairs) {
            const currentFront = currentFrontByUuid.get(front.uuid);
            if (!currentFront) continue;

            const existingBacks = [...(backsByFrontUuid.get(front.uuid) ?? [])];
            if (currentFront.linkedBackId) {
                const linkedBack = cardByUuid.get(currentFront.linkedBackId);
                if (linkedBack && !existingBacks.some((candidate) => candidate.uuid === linkedBack.uuid)) {
                    existingBacks.unshift(linkedBack);
                }
            }

            if (existingBacks.length === 0) {
                const backUuid = crypto.randomUUID();
                newBackCards.push({
                    uuid: backUuid,
                    name: back.name,
                    order: currentFront.order,
                    isUserUpload: currentFront.isUserUpload,
                    imageId: back.imageId,
                    linkedFrontId: currentFront.uuid,
                    needsEnrichment: false,
                    hasBuiltInBleed: back.hasBuiltInBleed,
                    usesDefaultCardback: false,
                    projectId: currentFront.projectId,
                });
                cardUpdates.push({
                    key: currentFront.uuid,
                    changes: { linkedBackId: backUuid },
                });
                addImageRefDelta(imageRefDeltas, back.imageId, 1);
                continue;
            }

            const primaryBack = existingBacks[0];
            if (currentFront.linkedBackId !== primaryBack.uuid) {
                cardUpdates.push({
                    key: currentFront.uuid,
                    changes: { linkedBackId: primaryBack.uuid },
                });
            }

            for (const existingBack of existingBacks) {
                if (existingBack.imageId !== back.imageId) {
                    addImageRefDelta(imageRefDeltas, existingBack.imageId, -1);
                    addImageRefDelta(imageRefDeltas, back.imageId, 1);
                }

                cardUpdates.push({
                    key: existingBack.uuid,
                    changes: {
                        name: back.name,
                        order: currentFront.order,
                        imageId: back.imageId,
                        linkedFrontId: currentFront.uuid,
                        needsEnrichment: false,
                        hasBuiltInBleed: back.hasBuiltInBleed,
                        usesDefaultCardback: false,
                        projectId: currentFront.projectId,
                    },
                });
            }
        }

        if (newBackCards.length > 0) {
            await db.cards.bulkAdd(newBackCards);
        }
        if (cardUpdates.length > 0) {
            await db.cards.bulkUpdate(cardUpdates);
        }
        await applyImageRefDeltas(imageRefDeltas);
    });
}

function addImageRefDelta(deltas: Map<string, number>, imageId: string | undefined, delta: number): void {
    if (!imageId || isCardbackId(imageId)) return;
    deltas.set(imageId, (deltas.get(imageId) ?? 0) + delta);
}

async function applyImageRefDeltas(deltas: Map<string, number>): Promise<void> {
    const imageIds = Array.from(deltas.keys()).filter((imageId) => deltas.get(imageId) !== 0);
    if (imageIds.length === 0) return;

    const images = await db.images.bulkGet(imageIds);
    const imageUpdates: { key: string; changes: { refCount: number } }[] = [];
    const imageDeletes: string[] = [];

    for (let i = 0; i < imageIds.length; i++) {
        const image = images[i];
        if (!image) continue;

        const nextRefCount = image.refCount + (deltas.get(imageIds[i]) ?? 0);
        if (nextRefCount > 0) {
            imageUpdates.push({
                key: imageIds[i],
                changes: { refCount: nextRefCount },
            });
        } else {
            imageDeletes.push(imageIds[i]);
        }
    }

    if (imageUpdates.length > 0) {
        await db.images.bulkUpdate(imageUpdates);
    }
    if (imageDeletes.length > 0) {
        await db.images.bulkDelete(imageDeletes);
    }
}

export function createShuffledTwoSidedTokenPairs(cards: PairableTokenCard[]): TwoSidedTokenPair[] {
    if (cards.length < 2) return [];

    for (let attempt = 0; attempt < 500; attempt++) {
        const shuffled = shuffle(cards);
        if (cards.every((front, index) => canUseTokenAsBack(front, shuffled[index]))) {
            return cards.map((front, index) => ({ front, back: shuffled[index] }));
        }
    }

    return findTwoSidedTokenPairs(cards, shuffle(cards));
}

function findTwoSidedTokenPairs(fronts: PairableTokenCard[], backs: PairableTokenCard[]): TwoSidedTokenPair[] {
    const usedBackIndexes = new Set<number>();
    const pairs: TwoSidedTokenPair[] = [];

    const assign = (frontIndex: number): boolean => {
        if (frontIndex >= fronts.length) return true;

        const front = fronts[frontIndex];
        for (let backIndex = 0; backIndex < backs.length; backIndex++) {
            if (usedBackIndexes.has(backIndex)) continue;

            const back = backs[backIndex];
            if (!canUseTokenAsBack(front, back)) continue;

            usedBackIndexes.add(backIndex);
            pairs.push({ front, back });

            if (assign(frontIndex + 1)) return true;

            pairs.pop();
            usedBackIndexes.delete(backIndex);
        }

        return false;
    };

    return assign(0) ? pairs : [];
}

function canUseTokenAsBack(front: PairableTokenCard, back: PairableTokenCard): boolean {
    return (
        front.uuid !== back.uuid &&
        front.imageId !== back.imageId &&
        normalizeTokenName(front.name) !== normalizeTokenName(back.name) &&
        getCardIdentityKey(front) !== getCardIdentityKey(back)
    );
}

function shuffle<T>(items: readonly T[]): T[] {
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function getIntentIdentityKey(intent: ImportIntent): string {
    return intent.scryfallId ? `id:${intent.scryfallId}` : `name:${normalizeTokenName(intent.name)}`;
}

function getTokenPartIdentityKey(token: { name: string; id?: string }): string {
    return token.id ? `id:${token.id}` : `name:${normalizeTokenName(token.name)}`;
}

function getCardIdentityKey(card: Pick<CardOption, "name" | "scryfall_id">): string {
    return card.scryfall_id ? `id:${card.scryfall_id}` : `name:${normalizeTokenName(card.name)}`;
}

function normalizeTokenName(name: string): string {
    return name
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}
