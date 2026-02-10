import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { Button, Checkbox, Label, Modal, ModalBody, ModalHeader, Textarea } from "flowbite-react";
import { ExternalLink, Search, Sparkles } from "lucide-react";
import { parseDeckList } from "@/helpers/importParsers";
import type { ImportIntent } from "@/helpers/importParsers";
import { addRemoteImage, checkMultiFaceCardsHaveCorrectBack, countBasicLandsToRemove, moveMultiFaceCardsToEnd, removeBasicLandsFromProject } from "@/helpers/dbUtils";
import { db } from "@/db";
import { useCardsStore, useSettingsStore, useProjectStore } from "@/store";
import { useLoadingStore } from "@/store/loading";
import { AdvancedSearch } from "../ArtworkModal";
import { handleManualTokenImport } from "@/helpers/tokenImportHelper";
import { useToastStore } from "@/store/toast";
import { useCardImport } from "@/hooks/useCardImport";

type Props = {
    mobile?: boolean;
    cardCount: number;
    onUploadComplete?: () => void;
};

export function DecklistUploader({ mobile, cardCount, onUploadComplete }: Props) {
    const [deckText, setDeckText] = useState("");
    const tokenFetchController = useRef<AbortController | null>(null);

    const setLoadingTask = useLoadingStore((state) => state.setLoadingTask);
    const preferredArtSource = useSettingsStore((s) => s.preferredArtSource);
    const setSortBy = useSettingsStore((s) => s.setSortBy);
    const clearAllCardsAndImages = useCardsStore((state) => state.clearAllCardsAndImages);
    const showInfoToast = useToastStore((s) => s.showInfoToast);
    const showErrorToast = useToastStore((s) => s.showErrorToast);
    const { processCards, cancel: cancelCardFetch } = useCardImport({
        onComplete: () => {
            setDeckText("");
            onUploadComplete?.();
        }
    });

    const [showClearConfirmModal, setShowClearConfirmModal] = useState(false);
    const [showNoTokensModal, setShowNoTokensModal] = useState(false);
    const [isAdvancedSearchOpen, setIsAdvancedSearchOpen] = useState(false);
    const [showRemoveBasicsModal, setShowRemoveBasicsModal] = useState(false);
    const [removeBasicsIncludeWastes, setRemoveBasicsIncludeWastes] = useState(true);
    const [removeBasicsIncludeSnow, setRemoveBasicsIncludeSnow] = useState(true);
    const [isRemovingBasics, setIsRemovingBasics] = useState(false);
    const [isCheckingMultiFaceBacks, setIsCheckingMultiFaceBacks] = useState(false);

    const currentProjectId = useProjectStore((state) => state.currentProjectId);

    const removeBasicsWillRemove = useLiveQuery(async () => {
        if (!currentProjectId) return 0;
        if (!showRemoveBasicsModal) return 0;
        return await countBasicLandsToRemove(currentProjectId, {
            includeWastes: removeBasicsIncludeWastes,
            includeSnowCovered: removeBasicsIncludeSnow,
        });
    }, [currentProjectId, showRemoveBasicsModal, removeBasicsIncludeWastes, removeBasicsIncludeSnow]);

    const handleMoveMultiFaceToEnd = async () => {
        if (!currentProjectId) return;
        try {
            // Ensure the user sees the effect immediately (manual ordering is what this action edits).
            setSortBy("manual");

            const result = await moveMultiFaceCardsToEnd(currentProjectId);
            if (result.multiFaceSlots === 0) {
                showInfoToast("No multi-face cards found.");
            } else if (result.updatedSlots === 0) {
                showInfoToast("Multi-face cards are already at the end.");
            } else {
                showInfoToast(`Moved ${result.multiFaceSlots} multi-face card${result.multiFaceSlots === 1 ? "" : "s"} to the end.`);
            }
        } catch (err: unknown) {
            if (err instanceof Error) {
                showErrorToast(err.message || "Failed to reorder cards.");
            } else {
                showErrorToast("Failed to reorder cards.");
            }
        }
    };

    const handleCheckMultiFaceBacks = async () => {
        if (!currentProjectId) return;
        try {
            setIsCheckingMultiFaceBacks(true);

            const result = await checkMultiFaceCardsHaveCorrectBack(currentProjectId);
            if (result.multiFace === 0) {
                showInfoToast("No multi-face cards detected.");
                return;
            }
            const summary = `Checked=${result.checked}, Fixed=${result.fixed}, Skipped=${result.skipped}, Errors=${result.errors}`;
            if (result.broken === 0) {
                showInfoToast(`Checked ${result.multiFace} multi-face card${result.multiFace === 1 ? "" : "s"}: all backs look OK. (${summary})`);
            } else {
                showInfoToast(
                    `Multi-face back check complete: fixed ${result.fixed}/${result.broken} broken card${result.broken === 1 ? "" : "s"}. (${summary})`
                );
            }
        } catch (err: unknown) {
            if (err instanceof Error) {
                showErrorToast(err.message || "Failed to check multi-face backs.");
            } else {
                showErrorToast("Failed to check multi-face backs.");
            }
        } finally {
            setIsCheckingMultiFaceBacks(false);
        }
    };

    const handleConfirmRemoveBasics = async () => {
        if (!currentProjectId) return;
        try {
            setIsRemovingBasics(true);

            const result = await removeBasicLandsFromProject(currentProjectId, {
                includeWastes: removeBasicsIncludeWastes,
                includeSnowCovered: removeBasicsIncludeSnow,
            });

            if (result.removedBasics === 0) {
                showInfoToast("No basic lands found to remove.");
                return;
            }

            showInfoToast(`Removed ${result.removedBasics} basic land${result.removedBasics === 1 ? "" : "s"}.`);
            setShowRemoveBasicsModal(false);
        } catch (err: unknown) {
            if (err instanceof Error) {
                showErrorToast(err.message || "Failed to remove basic lands.");
            } else {
                showErrorToast("Failed to remove basic lands.");
            }
        } finally {
            setIsRemovingBasics(false);
        }
    };

    const handleSubmit = async () => {
        const text = deckText.trim();
        if (!text) return;

        const intents = parseDeckList(text);

        const enrichedIntents = intents.map(i => ({
            ...i,
            sourcePreference: i.sourcePreference || preferredArtSource
        }));

        if (!enrichedIntents.length) return;
        onUploadComplete?.();
        await processCards(enrichedIntents);
    };

    const handleAddCard = async (cardName: string, mpcImageUrl?: string, specificPrint?: { set: string; number: string }) => {
        // If MPC image URL is provided, add the card directly without Scryfall lookup
        if (mpcImageUrl) {
            onUploadComplete?.();

            // Extract base card name from MPC name (e.g., "Forest (Ukiyo)" -> "Forest")
            const baseNameMatch = cardName.match(/^([^(]+)/);
            const baseName = baseNameMatch ? baseNameMatch[1].trim() : cardName;

            // Add the image directly
            const imageId = await addRemoteImage([mpcImageUrl], 1);

            // Add the card with the image and mark for enrichment
            const intent: ImportIntent = {
                name: baseName,
                quantity: 1,
                localImageId: imageId,
                isToken: false,
                sourcePreference: 'manual'
            };

            await processCards([intent]);
            useSettingsStore.getState().setSortBy("manual");
            return;
        }

        const intent: ImportIntent = {
            name: cardName,
            quantity: 1,
            set: specificPrint?.set,
            number: specificPrint?.number,
            isToken: false,
            sourcePreference: 'scryfall' // Force Scryfall
        };

        await processCards([intent]);
    };

    // --- Token Import Logic ---

    const handleAddTokens = async (silent: boolean = false) => {
        // Prevent overlapping token fetches
        if (tokenFetchController.current) {
            tokenFetchController.current.abort();
        }
        tokenFetchController.current = new AbortController();

        try {
            await handleManualTokenImport({
                silent,
                signal: tokenFetchController.current.signal,
                onComplete: () => {
                    onUploadComplete?.();
                },
                onNoTokens: () => {
                    if (!silent) {
                        setShowNoTokensModal(true);
                    }
                }
            });
        } catch (err: unknown) {
            if (err instanceof Error && err.name !== "AbortError") {
                useToastStore.getState().showErrorToast(err.message || "Something went wrong while fetching tokens.");
            }
        } finally{
            tokenFetchController.current = null;
        }
    };

    // --- Clear Logic ---

    const handleClear = async () => {
        const count = await db.cards.count();
        if (count === 0) {
            await confirmClear();
            setShowClearConfirmModal(false);
        } else {
            setShowClearConfirmModal(true);
        }
    };

    const confirmClear = async () => {
        setLoadingTask("Clearing Images");

        // Cancel any active card fetching
        cancelCardFetch();

        if (tokenFetchController.current) {
            tokenFetchController.current.abort();
            tokenFetchController.current = null;
        }

        try {
            await clearAllCardsAndImages();
        } catch (err: unknown) {
            if (err instanceof Error) {
                useToastStore.getState().showErrorToast(err.message || "Failed to clear images.");
            } else {
                useToastStore.getState().showErrorToast("An unknown error occurred while clearing images.");
            }
        } finally {
            setLoadingTask(null);
            setShowClearConfirmModal(false);
        }
    };

    return (
        <div className={`space-y-4 ${mobile ? 'landscape:flex landscape:flex-col landscape:h-full landscape:space-y-0 landscape:gap-4' : ''}`}>
            <div className={`space-y-1 ${mobile ? 'landscape:flex-1 landscape:flex landscape:flex-col' : ''}`}>
                <h6 className="font-medium dark:text-white">
                    Add Cards (
                    {preferredArtSource === 'mpc' ? (
                        <a
                            href="https://mpcfill.com"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline hover:text-blue-600 dark:hover:text-blue-400"
                        >
                            MPC Autofill
                            <ExternalLink className="inline-block size-4 ml-1" />
                        </a>
                    ) : (
                        <a
                            href="https://scryfall.com"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline hover:text-blue-600 dark:hover:text-blue-400"
                        >
                            Scryfall
                            <ExternalLink className="inline-block size-4 ml-1" />
                        </a>
                    )}
                    )
                </h6>

                <Textarea
                    className={`h-64 ${mobile ? 'landscape:flex-1 landscape:[&::-webkit-scrollbar]:hidden landscape:[-ms-overflow-style:none] landscape:[scrollbar-width:none]' : ''} resize-none text-base p-3`}
                    placeholder={`1x Sol Ring\n2x Counterspell\nFor specific art include set / CN\neg. Strionic Resonator (lcc)\nor Repurposing Bay (dft) 380`}
                    value={deckText}
                    onChange={(e) => setDeckText(e.target.value)}
                    onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && deckText.trim()) {
                            e.preventDefault();
                            handleSubmit();
                        }
                    }}
                />
            </div>


            <div className="flex flex-col gap-3">
                <Button color="blue" size="lg" onClick={handleSubmit} disabled={!deckText.trim()}>
                    Fetch Cards
                </Button>
                <Button
                    color="red"
                    size="lg"
                    onClick={handleClear}
                    disabled={cardCount === 0}
                >
                    Clear Cards
                </Button>
                <Button
                    color="indigo"
                    size="lg"
                    onClick={() => setIsAdvancedSearchOpen(true)}
                >
                    <Search className="w-5 h-5 mr-2" />
                    Advanced Search
                </Button>
                <Button
                    color="purple"
                    size="lg"
                    onClick={() => handleAddTokens()}
                    disabled={cardCount === 0 || !currentProjectId}
                >
                    <Sparkles className="w-5 h-5 mr-2" />
                    Add Associated Tokens
                </Button>
                <Button
                    color="gray"
                    size="lg"
                    onClick={handleMoveMultiFaceToEnd}
                    disabled={cardCount === 0}
                >
                    Move Multi-Face Cards To End
                </Button>
                <Button
                    color="gray"
                    size="lg"
                    onClick={handleCheckMultiFaceBacks}
                    disabled={cardCount === 0 || isCheckingMultiFaceBacks}
                >
                    {isCheckingMultiFaceBacks ? "Checking..." : "Check Multi-Face Cards Have Correct Back"}
                </Button>
                <Button
                    color="failure"
                    size="lg"
                    onClick={() => setShowRemoveBasicsModal(true)}
                    disabled={cardCount === 0}
                    className="bg-red-600 hover:bg-red-700 text-white"
                >
                    Remove All Basic Lands
                </Button>
            </div>

            {/* Advanced Search Modal */}
            {isAdvancedSearchOpen && (
                <AdvancedSearch
                    isOpen={isAdvancedSearchOpen}
                    onClose={() => setIsAdvancedSearchOpen(false)}
                    onSelectCard={handleAddCard}
                    keepOpenOnAdd={true}
                    initialSource={preferredArtSource}
                />
            )}

            {/* No Tokens Found Modal */}
            <Modal
                show={showNoTokensModal}
                onClose={() => setShowNoTokensModal(false)}
                size="md"
                dismissible
            >
                <ModalHeader>No Tokens Found</ModalHeader>
                <ModalBody>
                    <p className="text-base text-gray-500 dark:text-gray-400">
                        No new tokens were found. Either your cards don&apos;t have associated tokens, or all tokens are already in your collection.
                    </p>
                    <div className="flex justify-end mt-4">
                        <Button
                            color="gray"
                            onClick={() => setShowNoTokensModal(false)}
                        >
                            OK
                        </Button>
                    </div>
                </ModalBody>
            </Modal>

            {/* Remove Basic Lands Modal */}
            <Modal
                show={showRemoveBasicsModal}
                onClose={() => {
                    setShowRemoveBasicsModal(false);
                }}
                size="lg"
                dismissible
            >
                <ModalHeader>Remove Basic Lands</ModalHeader>
                <ModalBody>
                    <div className="space-y-4">
                        <p className="text-base text-gray-600 dark:text-gray-300">
                            This will remove basic lands from the saved project card list. This does not edit your decklist text.
                        </p>

                        <div className="space-y-2">
                            <div className="flex items-center gap-2">
                                <Checkbox
                                    id="remove-basics-include-wastes"
                                    checked={removeBasicsIncludeWastes}
                                    onChange={(e) => setRemoveBasicsIncludeWastes(e.target.checked)}
                                />
                                <Label htmlFor="remove-basics-include-wastes">Include Wastes</Label>
                            </div>
                            <div className="flex items-center gap-2">
                                <Checkbox
                                    id="remove-basics-include-snow"
                                    checked={removeBasicsIncludeSnow}
                                    onChange={(e) => setRemoveBasicsIncludeSnow(e.target.checked)}
                                />
                                <Label htmlFor="remove-basics-include-snow">Include Snow-Covered basics</Label>
                            </div>
                        </div>

                        <div className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:bg-gray-800 dark:text-gray-200">
                            Will remove: <span className="font-semibold">{removeBasicsWillRemove ?? 0}</span> card{(removeBasicsWillRemove ?? 0) === 1 ? "" : "s"}
                        </div>

                        <div className="flex justify-end gap-3">
                            <Button
                                color="gray"
                                onClick={() => {
                                    setShowRemoveBasicsModal(false);
                                }}
                                disabled={isRemovingBasics}
                            >
                                Cancel
                            </Button>
                            <Button
                                color="failure"
                                onClick={handleConfirmRemoveBasics}
                                className="bg-red-600 hover:bg-red-700 text-white"
                                disabled={
                                    isRemovingBasics ||
                                    (removeBasicsWillRemove ?? 0) === 0
                                }
                            >
                                Remove
                            </Button>
                        </div>
                    </div>
                </ModalBody>
            </Modal>

            {/* Clear Confirm Modal */}
            {showClearConfirmModal && createPortal(
                <div className="fixed inset-0 z-100 bg-gray-900/50 flex items-center justify-center">
                    <div className="bg-white dark:bg-gray-800 p-6 rounded shadow-md w-96 text-center">
                        <div className="mb-4 text-lg font-semibold text-gray-800 dark:text-white">
                            Confirm Clear Cards
                        </div>
                        <div className="mb-5 text-lg font-normal text-gray-500 dark:text-gray-400">
                            Are you sure you want to clear all cards? This action cannot be
                            undone.
                        </div>
                        <div className="flex justify-center gap-4">
                            <Button
                                color="failure"
                                className="bg-red-600 hover:bg-red-700 text-white"
                                onClick={confirmClear}
                            >
                                Yes, I'm sure
                            </Button>
                            <Button
                                color="gray"
                                onClick={() => setShowClearConfirmModal(false)}
                            >
                                No, cancel
                            </Button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}
