import { Button, Checkbox, Label } from "flowbite-react";
import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useArtworkModalStore } from "@/store/artworkModal";
import { useCardEditorModalStore } from "@/store/cardEditorModal";
import { useSettingsStore } from "@/store/settings";
import { useSelectionStore } from "@/store/selection";
import { undoableUpdateCardBleedSettings } from "@/helpers/undoableActions";
import { BleedModeControl } from "./BleedModeControl";
import { getHasBuiltInBleed } from "@/helpers/imageSpecs";
import { AutoTooltip } from "../common";
import { db } from "@/db";
import { Palette } from "lucide-react";

interface ArtworkBleedSettingsProps {
    selectedFace: 'front' | 'back';
    applyToAll?: boolean;
    setApplyToAll?: (val: boolean) => void;
    applyToAllCardName?: string;
}

export function ArtworkBleedSettings({
    selectedFace,
    applyToAll = false,
    setApplyToAll,
    applyToAllCardName,
}: ArtworkBleedSettingsProps) {
    const modalCard = useArtworkModalStore((state) => state.card);
    const closeModal = useArtworkModalStore((state) => state.closeModal);

    // Fetch linked back card if it exists
    const linkedBackCard = useLiveQuery(
        () => (modalCard?.linkedBackId ? db.cards.get(modalCard.linkedBackId) : undefined),
        [modalCard?.linkedBackId]
    );

    // Get the active card based on selected face - back cards have their own settings
    const activeCard = selectedFace === 'back' && linkedBackCard ? linkedBackCard : modalCard;

    const frontImage = useLiveQuery(
        async () => {
            if (!modalCard?.imageId) return undefined;
            return (await db.images.get(modalCard.imageId)) ?? (await db.cardbacks?.get(modalCard.imageId));
        },
        [modalCard?.imageId]
    );

    const backImage = useLiveQuery(
        async () => {
            if (!linkedBackCard?.imageId) return undefined;
            return (await db.images.get(linkedBackCard.imageId)) ?? (await db.cardbacks?.get(linkedBackCard.imageId));
        },
        [linkedBackCard?.imageId]
    );
    const activeImage = selectedFace === 'back' ? backImage : frontImage;

    // Get global settings for display labels
    const globalBleedWidth = useSettingsStore((state) => state.bleedEdgeWidth);
    const sameAsFrontUserEditedRef = useRef(false);

    // --- Local State ---
    // "Same as front" option for back face (default: true)
    const [sameAsFront, setSameAsFront] = useState(true);

    useEffect(() => {
        sameAsFrontUserEditedRef.current = false;
    }, [selectedFace, modalCard?.uuid, linkedBackCard?.uuid]);

    // 1. Source Bleed
    const globalSourceAmount = useSettingsStore((state) => state.withBleedSourceAmount);
    const [hasBleedBuiltIn, setHasBleedBuiltIn] = useState<boolean>(false);
    const [sourceMode, setSourceMode] = useState<'default' | 'manual'>('default');
    const [providedBleedAmount, setProvidedBleedAmount] = useState<number>(3.175);

    // 2. Target Bleed
    // 'default' = inherit from Type Settings
    // 'manual' = override specific amount
    // 'none' = force 0mm
    const [targetMode, setTargetMode] = useState<'default' | 'manual' | 'none'>('default');
    const [manualTargetAmount, setManualTargetAmount] = useState<number>(3.175);

    // Initialize from active card (front or back based on selectedFace)
    useEffect(() => {
        if (activeCard) {
            setHasBleedBuiltIn(getHasBuiltInBleed(activeCard, activeImage) ?? false);

            if (activeCard.existingBleedMm !== undefined) {
                setSourceMode('manual');
                setProvidedBleedAmount(activeCard.existingBleedMm);
            } else {
                setSourceMode('default');
                setProvidedBleedAmount(globalSourceAmount);
            }

            // Determine Target Mode state from card props
            if (activeCard.bleedMode === 'none') {
                setTargetMode('none');
            } else if (activeCard.generateBleedMm !== undefined) {
                setTargetMode('manual');
                setManualTargetAmount(activeCard.generateBleedMm);
            } else {
                setTargetMode('default');
                // Default manual amount to global for convenience if they switch
                setManualTargetAmount(globalBleedWidth);
            }

            // Initialize sameAsFront by comparing back card settings to front card settings
            if (selectedFace === 'back' && modalCard && linkedBackCard) {
                const frontHasBleed = getHasBuiltInBleed(modalCard, frontImage) ?? false;
                const backHasBleed = getHasBuiltInBleed(linkedBackCard, backImage) ?? false;
                const frontBleedMode = modalCard.bleedMode;
                const backBleedMode = linkedBackCard.bleedMode;
                const frontExisting = modalCard.existingBleedMm;
                const backExisting = linkedBackCard.existingBleedMm;
                const frontGenerate = modalCard.generateBleedMm;
                const backGenerate = linkedBackCard.generateBleedMm;

                // Check if settings match
                const settingsMatch = frontHasBleed === backHasBleed &&
                    frontBleedMode === backBleedMode &&
                    frontExisting === backExisting &&
                    frontGenerate === backGenerate;

                if (!sameAsFrontUserEditedRef.current) {
                    setSameAsFront(settingsMatch);
                }
            }
        }
    }, [activeCard, activeImage, globalBleedWidth, globalSourceAmount, selectedFace, modalCard, linkedBackCard, frontImage, backImage]);

    // Check if we're on a back card that doesn't exist yet
    const isBackTab = selectedFace === 'back';
    const hasLinkedBack = !!linkedBackCard;
    const showApplyToAll = !!setApplyToAll && !!activeCard && (!isBackTab || hasLinkedBack);
    const applyToAllLabel = applyToAllCardName ?? activeCard?.name ?? "";
    const activeEditorImage = activeImage
        ? ("refCount" in activeImage
            ? activeImage
            : { ...activeImage, refCount: 0, source: "cardback" as const })
        : null;

    // For back tab without linked back card, show message
    if (isBackTab && !hasLinkedBack) {
        return (
            <div className="p-4 space-y-4">
                <div className="p-3 bg-yellow-50 dark:bg-yellow-900/30 rounded-lg border border-yellow-200 dark:border-yellow-800">
                    <p className="text-sm text-yellow-800 dark:text-yellow-200">
                        <strong>No back card selected.</strong> Please select a cardback from the Artwork tab first to configure bleed settings for the back.
                    </p>
                </div>
            </div>
        );
    }

    const handleSave = async () => {
        let bleedMode: 'generate' | 'none' | undefined;
        let existingBleedMm: number | undefined;
        let generateBleedMm: number | undefined;
        const getNamedCards = async () =>
            applyToAll && activeCard?.name
                ? await db.cards.where('name').equals(activeCard.name).toArray()
                : [];

        // If "same as front" is checked for back card, copy front card settings
        if (isBackTab && sameAsFront && modalCard) {
            const namedCards = await getNamedCards();
            const cardUuids = namedCards.length > 0
                ? namedCards.map((card) => card.uuid)
                : [activeCard!.uuid];
            const frontSettings = {
                hasBuiltInBleed: getHasBuiltInBleed(modalCard, frontImage),
                bleedMode: modalCard.bleedMode,
                existingBleedMm: modalCard.existingBleedMm,
                generateBleedMm: modalCard.generateBleedMm
            };

            await undoableUpdateCardBleedSettings(
                cardUuids,
                frontSettings,
                { scope: 'selected' }
            );
            closeModal();
            return;
        }

        // 1. Source Logic
        if (hasBleedBuiltIn) {
            if (sourceMode === 'manual') {
                existingBleedMm = providedBleedAmount;
            } else {
                existingBleedMm = undefined; // Use global default
            }
        } else {
            existingBleedMm = undefined; // No built in bleed -> no existing amount needed
        }

        // 2. Target Logic
        if (targetMode === 'none') {
            bleedMode = 'none';
            generateBleedMm = undefined;
        } else if (targetMode === 'manual') {
            bleedMode = 'generate'; // Force generate mode when manually overriding
            generateBleedMm = manualTargetAmount;
        } else {
            // Default
            bleedMode = undefined; // Let type settings decide
            generateBleedMm = undefined;
        }

        const selectedCards = useSelectionStore.getState().selectedCards;
        const namedCards = await getNamedCards();

        // For back cards, only save to this specific back card (no multi-select for backs)
        // For front cards, allow multi-select
        const cardUuids = namedCards.length > 0
            ? namedCards.map((card) => card.uuid)
            : (!isBackTab && selectedCards.size > 1 && modalCard && selectedCards.has(modalCard.uuid)
                ? Array.from(selectedCards)
                : [activeCard!.uuid]);

        const settings = {
            hasBuiltInBleed: hasBleedBuiltIn,
            bleedMode,
            existingBleedMm,
            generateBleedMm
        };

        if (isBackTab || applyToAll) {
            await undoableUpdateCardBleedSettings(cardUuids, settings, { scope: 'selected' });
        } else {
            await undoableUpdateCardBleedSettings(cardUuids, settings);
        }

        closeModal();
    };

    return (
        <div className="flex flex-col h-full bg-white dark:bg-gray-700 max-h-full overflow-hidden">
            <div className="flex-1 overflow-y-auto p-4 space-y-6 min-h-0">
                {showApplyToAll && (
                    <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox
                            checked={applyToAll}
                            onChange={(e) => setApplyToAll(e.target.checked)}
                            className="size-5"
                        />
                        <span className="text-base dark:text-white">Apply to all cards named "{applyToAllLabel}"</span>
                    </label>
                )}

                {/* Back Face Toggle - only for back cards */}
                {selectedFace === 'back' && linkedBackCard && (
                    <div className="bg-blue-50 dark:bg-blue-900/30 p-3 rounded-lg border border-blue-100 dark:border-blue-800">
                        <div className="flex items-center gap-2">
                            <Checkbox
                                id="same-as-front"
                                checked={sameAsFront}
                                onChange={(e) => {
                                    sameAsFrontUserEditedRef.current = true;
                                    setSameAsFront(e.target.checked);
                                }}
                                className="mt-0.5"
                            />
                            <div className="flex items-center gap-2 flex-1">
                                <Label htmlFor="same-as-front" className="cursor-pointer font-medium dark:text-white">
                                    Same as front
                                </Label>
                                <AutoTooltip content="Use the same bleed settings as the front face of this card" />
                            </div>
                        </div>
                    </div>
                )}

                {/* Show bleed settings only for front face OR when "same as front" is unchecked */}
                {(selectedFace === 'front' || !sameAsFront) && (
                    <div className="space-y-6">
                        <div className="flex items-center gap-2">
                            <h3 className="text-lg font-medium dark:text-white">Bleed Settings</h3>
                            <AutoTooltip
                                content="Configure how bleed edges are handled for this card."
                                className="w-5 h-5 text-gray-400 hover:text-gray-500 dark:text-gray-500 dark:hover:text-gray-400 cursor-pointer"
                            />
                        </div>

                        {/* 1. Source Settings */}
                        <div className="p-3 bg-gray-100 dark:bg-gray-700 rounded-lg">
                            <div className="flex items-center gap-2">
                                <Checkbox
                                    id="has-bleed-built-in"
                                    checked={hasBleedBuiltIn}
                                    onChange={(e) => setHasBleedBuiltIn(e.target.checked)}
                                    className="mt-0.5"
                                />
                                <div className="flex items-center gap-2 flex-1">
                                    <Label htmlFor="has-bleed-built-in" className="cursor-pointer font-medium dark:text-white">
                                        Built-in Bleed
                                    </Label>
                                    <AutoTooltip content="Check this if the image already includes bleed edges (e.g., from MPC Autofill)" />
                                </div>
                            </div>

                            {hasBleedBuiltIn && (
                                <div className="ml-8 mt-2 space-y-2">
                                    <BleedModeControl
                                        idPrefix="source"
                                        groupName="source-mode"
                                        mode={sourceMode}
                                        onModeChange={setSourceMode}
                                        defaultLabel={`Use Type Default`}
                                        amount={providedBleedAmount}
                                        onAmountChange={setProvidedBleedAmount}
                                        showNone={false}
                                        valueDefault="default"
                                    />
                                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                        <span className="font-medium">Tip:</span> Setting to 0mm will ignore the built-in bleed and allow bleed generation at any desired amount.
                                    </p>
                                </div>
                            )}
                        </div>

                        {/* 2. Target Settings */}
                        <div className="space-y-2">
                            <h4 className="font-medium dark:text-white">Bleed Width</h4>
                            <BleedModeControl
                                idPrefix="target"
                                groupName="target-mode"
                                mode={targetMode}
                                onModeChange={setTargetMode}
                                defaultLabel={`Use ${hasBleedBuiltIn ? "Type Default" : "Global Bleed Width"}`}
                                amount={manualTargetAmount}
                                onAmountChange={setManualTargetAmount}
                                valueDefault="default"
                            />
                        </div>
                    </div>
                )}
            </div>

            {/* Bottom-anchored buttons - Fixed Footer */}
            <div className="flex-none p-4 pt-4 border-t border-gray-200 dark:border-gray-600 space-y-2 bg-white dark:bg-gray-700 z-10">
                {/* Adjust Art button - opens Card Editor Modal */}
                {activeCard && (
                    <Button
                        color="light"
                        className="w-full"
                        onClick={() => {
                            closeModal();
                            useCardEditorModalStore.getState().openModal({
                                card: activeCard,
                                image: activeEditorImage,
                            });
                        }}
                    >
                        <Palette className="w-4 h-4 mr-2" />
                        Adjust Art
                    </Button>
                )}
                <Button color="blue" className="w-full" onClick={handleSave}>
                    Save Settings
                </Button>
            </div>
        </div>
    );
}
