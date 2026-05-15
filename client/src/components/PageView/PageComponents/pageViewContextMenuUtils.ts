import type { ResetToOriginalImagesResult } from "@/helpers/dbUtils";
import type { CardOption } from "@/types";

export function getOriginalArtResetTargetCard(
  cards: CardOption[],
  cardUuid: string,
  flippedCards: Set<string>
): CardOption | undefined {
  const card = cards.find((c) => c.uuid === cardUuid);
  if (!card) return undefined;
  if (!flippedCards.has(card.uuid) || !card.linkedBackId) return card;
  return cards.find((c) => c.uuid === card.linkedBackId) ?? card;
}

export function getOriginalArtResetToastMessage(
  result: ResetToOriginalImagesResult,
  cardName: string
): string {
  if (result.reset > 0) {
    return `Reset "${cardName}" to original import art.`;
  }
  if (result.alreadyOriginal > 0) {
    return `"${cardName}" is already using original import art.`;
  }
  if (result.legacy > 0) {
    return `Cannot reset "${cardName}" because no original import art history is available.`;
  }
  return `No original import art found for "${cardName}".`;
}
