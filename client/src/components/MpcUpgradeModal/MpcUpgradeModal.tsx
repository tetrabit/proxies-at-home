import { Modal, ModalHeader, ModalBody, Spinner } from "flowbite-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMpcUpgradeModalStore, useProjectStore } from "@/store";
import {
  searchMpcAutofill,
  getMpcAutofillImageUrl,
} from "@/helpers/mpcAutofillApi";
import type { MpcAutofillCard } from "@/helpers/mpcAutofillApi";
import {
  filterByExactName,
  rankCandidates,
  createSsimCompare,
} from "@/helpers/mpcBulkUpgradeMatcher";
import type { RankedRecommendations } from "@/helpers/mpcBulkUpgradeMatcher";
import { buildLayerTabs } from "@/helpers/mpcUpgradeLayerAdapter";
import type { LayerKey, LayerTab } from "@/helpers/mpcUpgradeLayerAdapter";
import { toProxied } from "@/helpers/imageHelper";
import { ImportOrchestrator } from "@/helpers/ImportOrchestrator";
import type { ImportIntent } from "@/helpers/importParsers";
import { changeCardArtwork, createLinkedBackCard } from "@/helpers/dbUtils";
import { useToastStore } from "@/store/toast";
import { TabBar } from "@/components/common/TabBar";
import type { TabItem } from "@/components/common/TabBar";
import { CardGrid } from "@/components/common/CardGrid";
import { CardImageSvg } from "@/components/common/CardImageSvg";
import { db } from "@/db";

type ModalPhase =
  | "idle"
  | "searching"
  | "ranking"
  | "ready"
  | "applying"
  | "error";

export function MpcUpgradeModal() {
  const open = useMpcUpgradeModalStore((s) => s.open);
  const card = useMpcUpgradeModalStore((s) => s.card);
  const cardUuid = useMpcUpgradeModalStore((s) => s.cardUuid);
  const closeModal = useMpcUpgradeModalStore((s) => s.closeModal);

  const [phase, setPhase] = useState<ModalPhase>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [recommendations, setRecommendations] =
    useState<RankedRecommendations | null>(null);
  const [activeTab, setActiveTab] = useState<LayerKey>("fullProcess");
  const [selectedIdentifier, setSelectedIdentifier] = useState<string | null>(
    null
  );

  const abortRef = useRef<AbortController | null>(null);
  const applyingRef = useRef(false);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
      applyingRef.current = false;
      setPhase("idle");
      setErrorMsg(null);
      setRecommendations(null);
      setActiveTab("fullProcess");
      setSelectedIdentifier(null);
      return;
    }

    if (!card) return;

    const controller = new AbortController();
    abortRef.current = controller;

    void runPipeline(
      card.name,
      card.set,
      card.number,
      card.imageId,
      controller.signal
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cardUuid]);

  async function runPipeline(
    cardName: string,
    set: string | undefined,
    collectorNumber: string | undefined,
    imageId: string | undefined,
    signal: AbortSignal
  ) {
    try {
      setPhase("searching");
      const results = await searchMpcAutofill(cardName, "CARD", false);
      if (signal.aborted) return;

      const exactMatches = filterByExactName(results, cardName);
      if (exactMatches.length === 0) {
        setRecommendations(null);
        setPhase("ready");
        return;
      }

      setPhase("ranking");

      let sourceImageUrl: string | undefined;
      if (imageId) {
        const imageRecord = await db.images.get(imageId);
        if (!signal.aborted) {
          sourceImageUrl =
            imageRecord?.sourceUrl || imageRecord?.imageUrls?.[0] || undefined;
          if (sourceImageUrl) {
            sourceImageUrl = toProxied(sourceImageUrl);
          }
        }
      }
      if (signal.aborted) return;

      const ssimCompare = createSsimCompare();
      const ranked = await rankCandidates({
        candidates: exactMatches,
        set,
        collectorNumber,
        sourceImageUrl,
        signal,
        ssimCompare,
        getMpcImageUrl: (id: string) => getMpcAutofillImageUrl(id, "small"),
      });
      if (signal.aborted) return;

      setRecommendations(ranked);
      setPhase("ready");

      const tabs = buildLayerTabs(ranked);
      const firstNonEmpty = tabs.find((t) => t.count > 0);
      if (firstNonEmpty) {
        setActiveTab(firstNonEmpty.key);
      }
    } catch (err) {
      if (signal.aborted) return;
      console.error("[MpcUpgradeModal] pipeline error:", err);
      setErrorMsg(err instanceof Error ? err.message : "Search failed");
      setPhase("error");
    }
  }

  const layerTabs: LayerTab[] = useMemo(
    () => (recommendations ? buildLayerTabs(recommendations) : []),
    [recommendations]
  );

  const tabItems: TabItem<LayerKey>[] = useMemo(
    () =>
      layerTabs.map((t) => ({
        id: t.key,
        label: `${t.label} (${t.count})`,
        dataTestId: `mpc-upgrade-tab-${t.key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      })),
    [layerTabs]
  );

  const activeCandidates = useMemo(() => {
    const tab = layerTabs.find((t) => t.key === activeTab);
    return tab?.candidates ?? [];
  }, [layerTabs, activeTab]);

  const activeLayerExplanation = useMemo(() => {
    const top = activeCandidates[0];
    if (!top) return null;

    if (activeTab === "fullCard") {
      if (top.reason === "name_dpi_fallback") {
        return "Full Card is currently showing DPI fallback ordering because the visual full-card comparison was unavailable or inconclusive.";
      }

      return "Full Card is currently using the preserved full-card visual comparison path.";
    }

    if (activeTab === "fullProcess") {
      if (top.reason === "set_collector_only") {
        return "Full Process is currently led by an exact-printing metadata match.";
      }
      if (top.reason === "set_only") {
        return "Full Process is currently led by a same-set metadata fallback.";
      }
      if (top.reason.endsWith("_dpi_fallback")) {
        return "Full Process is currently using DPI fallback ordering because visual comparison was unavailable or inconclusive.";
      }
      if (top.reason.endsWith("_ssim")) {
        return "Full Process is currently using visual comparison within the highest-priority bucket.";
      }
    }

    return null;
  }, [activeCandidates, activeTab]);

  const handleCardClick = useCallback(
    async (mpcCard: MpcAutofillCard) => {
      // Snapshot store values at click time to avoid stale closures
      const clickedCard = useMpcUpgradeModalStore.getState().card;
      const clickedCardUuid = useMpcUpgradeModalStore.getState().cardUuid;

      if (!clickedCard || applyingRef.current) return;

      applyingRef.current = true;
      setSelectedIdentifier(mpcCard.identifier);
      setPhase("applying");
      setErrorMsg(null);

      try {
        const intent: ImportIntent = {
          name: mpcCard.name,
          mpcId: mpcCard.identifier,
          sourcePreference: "mpc",
          quantity: 1,
          isToken: clickedCard.isToken || false,
        };

        const projectId =
          clickedCard.projectId || useProjectStore.getState().currentProjectId!;
        const { cardsToAdd, backCardTasks } = await ImportOrchestrator.resolve(
          intent,
          projectId
        );
        const resolved = cardsToAdd[0];

        if (!resolved?.imageId) {
          throw new Error("Failed to resolve MPC card image");
        }

        await changeCardArtwork(
          clickedCard.imageId,
          resolved.imageId,
          clickedCard,
          false, // applyToAll — single card only
          resolved.name,
          undefined, // previewImageUrls
          {
            isToken: resolved.isToken,
            token_parts: resolved.token_parts,
            needs_token: resolved.needs_token,
            set: resolved.set,
            number: resolved.number,
            rarity: resolved.rarity,
            lang: resolved.lang,
            colors: resolved.colors,
            cmc: resolved.cmc,
            type_line: resolved.type_line,
            mana_cost: resolved.mana_cost,
          },
          resolved.hasBuiltInBleed
        );

        if (resolved.needsEnrichment && clickedCardUuid) {
          await db.cards.update(clickedCardUuid, { needsEnrichment: true });
        }

        if (backCardTasks && backCardTasks.length > 0 && clickedCardUuid) {
          const backTask = backCardTasks[0];
          const currentCard = await db.cards.get(clickedCardUuid);

          if (currentCard?.linkedBackId) {
            await db.cards.update(currentCard.linkedBackId, {
              imageId: backTask.backImageId,
              name: backTask.backName,
              hasBuiltInBleed:
                (backTask as { hasBleed?: boolean }).hasBleed ?? false,
              usesDefaultCardback: false,
            });
          } else {
            await createLinkedBackCard(
              clickedCardUuid,
              backTask.backImageId,
              backTask.backName,
              {
                hasBuiltInBleed:
                  (backTask as { hasBleed?: boolean }).hasBleed ?? false,
              }
            );
          }
        }

        const toastId = useToastStore.getState().addToast({
          type: "success",
          message: "MPC art applied successfully",
          dismissible: false,
        });
        setTimeout(() => useToastStore.getState().removeToast(toastId), 2000);

        applyingRef.current = false;
        closeModal();
      } catch (err) {
        applyingRef.current = false;
        console.error("[MpcUpgradeModal] apply error:", err);
        setErrorMsg(
          err instanceof Error ? err.message : "Failed to apply MPC art"
        );
        // Stay on ready phase so user can try another recommendation
        setPhase("ready");
      }
    },
    [closeModal]
  );

  const hasResults = layerTabs.some((t) => t.count > 0);

  return (
    <Modal
      show={open}
      onClose={closeModal}
      size="4xl"
      data-testid="mpc-upgrade-modal"
    >
      <ModalHeader>MPC Upgrade{card ? ` — ${card.name}` : ""}</ModalHeader>
      <ModalBody>
        <div data-testid="mpc-upgrade-modal-body" className="min-h-[300px]">
          {(phase === "searching" || phase === "ranking") && (
            <div className="flex flex-col items-center justify-center gap-3 py-12">
              <Spinner size="lg" />
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {phase === "searching"
                  ? "Searching MPC Autofill…"
                  : "Ranking candidates…"}
              </p>
            </div>
          )}

          {phase === "error" && !hasResults && (
            <div className="flex flex-col items-center justify-center gap-2 py-12">
              <p className="text-sm text-red-500">
                {errorMsg || "Something went wrong."}
              </p>
            </div>
          )}

          {phase === "ready" && !hasResults && (
            <div className="flex flex-col items-center justify-center gap-2 py-12">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No MPC matches found for &ldquo;{card?.name}&rdquo;.
              </p>
            </div>
          )}

          {(phase === "ready" ||
            phase === "applying" ||
            (phase === "error" && hasResults)) &&
            hasResults && (
              <div className="flex flex-col gap-4">
                {errorMsg && (
                  <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-600 dark:text-red-400">
                    {errorMsg}
                  </div>
                )}

                <TabBar<LayerKey>
                  tabs={tabItems}
                  activeTab={activeTab}
                  onTabChange={setActiveTab}
                  variant="secondary"
                />

                {activeCandidates.length > 0 ? (
                  <div
                    className={
                      phase === "applying"
                        ? "pointer-events-none opacity-60"
                        : ""
                    }
                  >
                    {activeLayerExplanation && (
                      <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                        {activeLayerExplanation}
                      </p>
                    )}
                    <CardGrid cardSize={0.65}>
                      {activeCandidates.map((rc, idx) => (
                        <MpcCandidateCard
                          key={`${rc.card.identifier}-${idx}`}
                          card={rc.card}
                          rank={idx + 1}
                          score={rc.score}
                          isSelected={selectedIdentifier === rc.card.identifier}
                          onClick={handleCardClick}
                        />
                      ))}
                    </CardGrid>
                    {phase === "applying" && (
                      <div className="flex items-center justify-center gap-2 py-3">
                        <Spinner size="sm" />
                        <span className="text-sm text-gray-500 dark:text-gray-400">
                          Applying…
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-6">
                    No candidates in this layer.
                  </p>
                )}
              </div>
            )}
        </div>
      </ModalBody>
    </Modal>
  );
}

interface MpcCandidateCardProps {
  card: MpcAutofillCard;
  rank: number;
  score?: number;
  isSelected: boolean;
  onClick: (card: MpcAutofillCard) => void;
}

function MpcCandidateCard({
  card,
  rank,
  score,
  isSelected,
  onClick,
}: MpcCandidateCardProps) {
  const primaryUrl = getMpcAutofillImageUrl(card.identifier, "small");
  const fallbackUrl = card.smallThumbnailUrl || "";

  return (
    <div
      className="relative group cursor-pointer"
      data-testid="mpc-upgrade-recommendation-card"
      onClick={() => onClick(card)}
    >
      <div
        className="relative w-full overflow-hidden"
        style={{ aspectRatio: "63 / 88" }}
      >
        <CardImageSvg
          url={primaryUrl}
          fallbackUrl={fallbackUrl}
          id={`upgrade-${card.identifier}`}
          bleed={{
            amountMm: 3.175,
            sourceWidthMm: 69.35,
            sourceHeightMm: 94.35,
          }}
          rounded={true}
        />
      </div>

      {isSelected && (
        <div className="absolute inset-0 rounded-[2.5mm] ring-4 ring-green-500 pointer-events-none" />
      )}

      <div className="absolute top-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded z-30">
        {card.dpi} DPI
      </div>

      {score != null && (
        <div className="absolute top-2 left-2 bg-purple-600/80 text-white text-xs px-2 py-1 rounded z-30">
          {rank === 1 ? "Top rank" : `Rank #${rank}`}
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0 bg-linear-to-t from-black/80 to-transparent p-2 rounded-b-[2.5mm] z-30 transition-opacity opacity-0 group-hover:opacity-100">
        <div className="text-[10px] truncate max-w-full px-2 py-0.5 rounded bg-black/60 text-white inline-block mb-1">
          {card.sourceName}
        </div>
        {card.tags && card.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {card.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="text-white text-[10px] px-1.5 py-0.5 rounded bg-white/20"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
