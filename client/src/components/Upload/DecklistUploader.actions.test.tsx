import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
    parseDeckList: vi.fn(),
    addRemoteImage: vi.fn().mockResolvedValue('remote-id'),
    moveMultiFaceCardsToEnd: vi.fn(),
    checkMultiFaceCardsHaveCorrectBack: vi.fn(),
    countBasicLandsToRemove: vi.fn().mockResolvedValue(2),
    removeBasicLandsFromProject: vi.fn(),
    handleManualTokenImport: vi.fn(),
    handleManualTwoSidedTokenImport: vi.fn(),
    processCards: vi.fn().mockResolvedValue(undefined),
    cancelCardFetch: vi.fn(),
    clearAllCardsAndImages: vi.fn().mockResolvedValue(undefined),
    setSortBy: vi.fn(),
    setLoadingTask: vi.fn(),
    showInfoToast: vi.fn(),
    showErrorToast: vi.fn(),
    addToast: vi.fn(() => 'toast-id'),
    removeToast: vi.fn(),
    currentProjectId: 'project-1' as string | null,
    preferredArtSource: 'scryfall' as 'scryfall' | 'mpc',
    liveQueryValue: 2,
    cardCount: vi.fn().mockResolvedValue(0),
}));

vi.mock('dexie-react-hooks', () => ({
    useLiveQuery: () => mocks.liveQueryValue,
}));

vi.mock('@/helpers/importParsers', () => ({
    parseDeckList: (...args: [string]) => mocks.parseDeckList(...args),
}));

vi.mock('@/helpers/dbUtils', () => ({
    addRemoteImage: (...args: unknown[]) => mocks.addRemoteImage(...args),
    moveMultiFaceCardsToEnd: (...args: unknown[]) => mocks.moveMultiFaceCardsToEnd(...args),
    checkMultiFaceCardsHaveCorrectBack: (...args: unknown[]) => mocks.checkMultiFaceCardsHaveCorrectBack(...args),
    countBasicLandsToRemove: (...args: unknown[]) => mocks.countBasicLandsToRemove(...args),
    removeBasicLandsFromProject: (...args: unknown[]) => mocks.removeBasicLandsFromProject(...args),
}));

vi.mock('@/helpers/tokenImportHelper', () => ({
    handleManualTokenImport: (...args: unknown[]) => mocks.handleManualTokenImport(...args),
    handleManualTwoSidedTokenImport: (...args: unknown[]) => mocks.handleManualTwoSidedTokenImport(...args),
}));

vi.mock('@/hooks/useCardImport', () => ({
    useCardImport: ({ onComplete }: { onComplete?: () => void }) => ({
        processCards: async (intents: unknown[]) => {
            await mocks.processCards(intents);
            onComplete?.();
        },
        cancel: mocks.cancelCardFetch,
    }),
}));

vi.mock('@/store', () => {
    const useSettingsStore = Object.assign(
        vi.fn((selector?: (state: { preferredArtSource: typeof mocks.preferredArtSource; setSortBy: typeof mocks.setSortBy }) => unknown) => {
            const state = { preferredArtSource: mocks.preferredArtSource, setSortBy: mocks.setSortBy };
            return selector ? selector(state) : state;
        }),
        { getState: () => ({ setSortBy: mocks.setSortBy, preferredArtSource: mocks.preferredArtSource }) }
    );
    const useProjectStore = vi.fn((selector?: (state: { currentProjectId: string | null }) => unknown) => {
        const state = { currentProjectId: mocks.currentProjectId };
        return selector ? selector(state) : state;
    });

    return {
        useSettingsStore,
        useProjectStore,
        useCardsStore: (selector: (state: { clearAllCardsAndImages: typeof mocks.clearAllCardsAndImages }) => unknown) => selector({ clearAllCardsAndImages: mocks.clearAllCardsAndImages }),
    };
});

vi.mock('@/store/loading', () => ({
    useLoadingStore: (selector: (state: { setLoadingTask: typeof mocks.setLoadingTask }) => unknown) => selector({ setLoadingTask: mocks.setLoadingTask }),
}));

vi.mock('@/store/toast', () => {
    const useToastStore = Object.assign(
        vi.fn((selector?: (state: { showInfoToast: typeof mocks.showInfoToast; showErrorToast: typeof mocks.showErrorToast; addToast: typeof mocks.addToast; removeToast: typeof mocks.removeToast }) => unknown) => {
            const state = { showInfoToast: mocks.showInfoToast, showErrorToast: mocks.showErrorToast, addToast: mocks.addToast, removeToast: mocks.removeToast };
            return selector ? selector(state) : state;
        }),
        { getState: () => ({ showErrorToast: mocks.showErrorToast }) }
    );
    return { useToastStore };
});

vi.mock('@/db', () => ({
    db: { cards: { count: () => mocks.cardCount() } },
}));

vi.mock('../ArtworkModal', () => ({
    AdvancedSearch: ({ onSelectCard, onClose }: { onSelectCard: (name: string, img?: string, print?: { set: string; number: string }) => void; onClose: () => void }) => (
        <div data-testid="advanced-search">
            <button onClick={() => onSelectCard('Forest (Ukiyo)', 'https://example.test/forest.jpg')}>Select MPC Card</button>
            <button onClick={() => onSelectCard('Counterspell', undefined, { set: 'mh2', number: '267' })}>Select Scryfall Card</button>
            <button onClick={onClose}>Close Search</button>
        </div>
    ),
}));

vi.mock('../common', () => ({
    AutoTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { DecklistUploader } from './DecklistUploader';

function renderDecklist(cardCount = 1, props: Partial<React.ComponentProps<typeof DecklistUploader>> = {}) {
    return render(<DecklistUploader cardCount={cardCount} {...props} />);
}

function typeDeck(text: string) {
    fireEvent.change(screen.getByPlaceholderText(/1x Sol Ring/), { target: { value: text } });
}

describe('DecklistUploader action branches', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.parseDeckList.mockReturnValue([{ name: 'Island', quantity: 2 }]);
        mocks.addRemoteImage.mockResolvedValue('remote-id');
        mocks.moveMultiFaceCardsToEnd.mockResolvedValue({ multiFaceSlots: 2, updatedSlots: 1 });
        mocks.checkMultiFaceCardsHaveCorrectBack.mockResolvedValue({ multiFace: 2, checked: 2, fixed: 0, skipped: 0, errors: 0, broken: 0 });
        mocks.removeBasicLandsFromProject.mockResolvedValue({ removedBasics: 2 });
        mocks.handleManualTokenImport.mockResolvedValue(undefined);
        mocks.handleManualTwoSidedTokenImport.mockResolvedValue({ importedTokenCount: 2, pairedTokenCount: 2, unpairedTokenCount: 0 });
        mocks.processCards.mockResolvedValue(undefined);
        mocks.clearAllCardsAndImages.mockResolvedValue(undefined);
        mocks.cardCount.mockResolvedValue(0);
        mocks.currentProjectId = 'project-1';
        mocks.preferredArtSource = 'scryfall';
        mocks.liveQueryValue = 2;
    });

    it('submits deck text with preferred art fallback, clears text on completion, and supports Ctrl+Enter', async () => {
        const onUploadComplete = vi.fn();
        renderDecklist(1, { onUploadComplete });

        typeDeck('2 Island');
        fireEvent.click(screen.getByText('Fetch Cards'));

        await waitFor(() => expect(mocks.processCards).toHaveBeenCalledWith([{ name: 'Island', quantity: 2, sourcePreference: 'scryfall' }]));
        expect(onUploadComplete).toHaveBeenCalledTimes(2);
        expect((screen.getByPlaceholderText(/1x Sol Ring/) as HTMLTextAreaElement).value).toBe('');

        mocks.parseDeckList.mockReturnValue([{ name: 'Swamp', quantity: 1, sourcePreference: 'mpc' }]);
        typeDeck('1 Swamp');
        fireEvent.keyDown(screen.getByPlaceholderText(/1x Sol Ring/), { key: 'Enter', ctrlKey: true });
        await waitFor(() => expect(mocks.processCards).toHaveBeenCalledWith([{ name: 'Swamp', quantity: 1, sourcePreference: 'mpc' }]));
    });

    it('ignores blank and unparsable deck submissions', () => {
        renderDecklist(1);
        fireEvent.click(screen.getByText('Fetch Cards'));
        expect(mocks.parseDeckList).not.toHaveBeenCalled();

        mocks.parseDeckList.mockReturnValue([]);
        typeDeck('not a deck');
        fireEvent.click(screen.getByText('Fetch Cards'));
        expect(mocks.processCards).not.toHaveBeenCalled();
    });

    it('adds advanced-search MPC and Scryfall selections with the right import intents', async () => {
        renderDecklist(1);
        fireEvent.click(screen.getByText('Advanced Search'));
        fireEvent.click(screen.getByText('Select MPC Card'));

        await waitFor(() => expect(mocks.addRemoteImage).toHaveBeenCalledWith(['https://example.test/forest.jpg'], 1));
        expect(mocks.processCards).toHaveBeenCalledWith([{ name: 'Forest', quantity: 1, localImageId: 'remote-id', isToken: false, sourcePreference: 'manual' }]);
        expect(mocks.setSortBy).toHaveBeenCalledWith('manual');

        fireEvent.click(screen.getByText('Select Scryfall Card'));
        await waitFor(() => expect(mocks.processCards).toHaveBeenCalledWith([{ name: 'Counterspell', quantity: 1, set: 'mh2', number: '267', isToken: false, sourcePreference: 'scryfall' }]));
    });

    it('reports multi-face move outcomes and failures', async () => {
        renderDecklist(1);
        fireEvent.click(screen.getByText('Move Multi-Face Cards To End'));
        await waitFor(() => expect(mocks.showInfoToast).toHaveBeenCalledWith('Moved 2 multi-face cards to the end.'));
        expect(mocks.setSortBy).toHaveBeenCalledWith('manual');

        mocks.moveMultiFaceCardsToEnd.mockResolvedValueOnce({ multiFaceSlots: 0, updatedSlots: 0 });
        fireEvent.click(screen.getByText('Move Multi-Face Cards To End'));
        await waitFor(() => expect(mocks.showInfoToast).toHaveBeenCalledWith('No multi-face cards found.'));

        mocks.moveMultiFaceCardsToEnd.mockResolvedValueOnce({ multiFaceSlots: 1, updatedSlots: 0 });
        fireEvent.click(screen.getByText('Move Multi-Face Cards To End'));
        await waitFor(() => expect(mocks.showInfoToast).toHaveBeenCalledWith('Multi-face cards are already at the end.'));

        mocks.moveMultiFaceCardsToEnd.mockRejectedValueOnce(new Error('reorder failed'));
        fireEvent.click(screen.getByText('Move Multi-Face Cards To End'));
        await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('reorder failed'));

        mocks.moveMultiFaceCardsToEnd.mockRejectedValueOnce('bad');
        fireEvent.click(screen.getByText('Move Multi-Face Cards To End'));
        await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('Failed to reorder cards.'));
    });

    it('checks multi-face backs and reports clean, fixed, none, and failure states', async () => {
        renderDecklist(1);
        fireEvent.click(screen.getByText('Check Multi-Face Cards Have Correct Back'));
        await waitFor(() => expect(mocks.showInfoToast).toHaveBeenCalledWith('Checked 2 multi-face cards: all backs look OK. (Checked=2, Fixed=0, Skipped=0, Errors=0)'));

        mocks.checkMultiFaceCardsHaveCorrectBack.mockResolvedValueOnce({ multiFace: 1, checked: 1, fixed: 1, skipped: 0, errors: 0, broken: 1 });
        fireEvent.click(screen.getByText('Check Multi-Face Cards Have Correct Back'));
        await waitFor(() => expect(mocks.showInfoToast).toHaveBeenCalledWith('Multi-face back check complete: fixed 1/1 broken card. (Checked=1, Fixed=1, Skipped=0, Errors=0)'));

        mocks.checkMultiFaceCardsHaveCorrectBack.mockResolvedValueOnce({ multiFace: 0, checked: 0, fixed: 0, skipped: 0, errors: 0, broken: 0 });
        fireEvent.click(screen.getByText('Check Multi-Face Cards Have Correct Back'));
        await waitFor(() => expect(mocks.showInfoToast).toHaveBeenCalledWith('No multi-face cards detected.'));

        mocks.checkMultiFaceCardsHaveCorrectBack.mockRejectedValueOnce(new Error('check failed'));
        fireEvent.click(screen.getByText('Check Multi-Face Cards Have Correct Back'));
        await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('check failed'));
    });

    it('removes basics with selected options and handles no-op and failure results', async () => {
        renderDecklist(1);
        fireEvent.click(screen.getByText('Remove All Basic Lands'));
        fireEvent.click(screen.getByLabelText('Include Wastes'));
        fireEvent.click(screen.getByText('Remove'));

        await waitFor(() => expect(mocks.removeBasicLandsFromProject).toHaveBeenCalledWith('project-1', { includeWastes: false, includeSnowCovered: true }));
        expect(mocks.showInfoToast).toHaveBeenCalledWith('Removed 2 basic lands.');

        mocks.removeBasicLandsFromProject.mockResolvedValueOnce({ removedBasics: 0 });
        fireEvent.click(screen.getByText('Remove All Basic Lands'));
        fireEvent.click(screen.getByText('Remove'));
        await waitFor(() => expect(mocks.showInfoToast).toHaveBeenCalledWith('No basic lands found to remove.'));

        mocks.removeBasicLandsFromProject.mockRejectedValueOnce('bad');
        fireEvent.click(screen.getByText('Remove'));
        await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('Failed to remove basic lands.'));
    });

    it('clears cards immediately when empty and through confirmation when populated', async () => {
        renderDecklist(1);
        fireEvent.click(screen.getByText('Clear Cards'));

        await waitFor(() => expect(mocks.clearAllCardsAndImages).toHaveBeenCalledTimes(1));
        expect(mocks.setLoadingTask).toHaveBeenNthCalledWith(1, 'Clearing Images');
        expect(mocks.cancelCardFetch).toHaveBeenCalled();
        expect(mocks.setLoadingTask).toHaveBeenLastCalledWith(null);

        mocks.cardCount.mockResolvedValueOnce(3);
        fireEvent.click(screen.getByText('Clear Cards'));
        expect(await screen.findByText('Confirm Clear Cards')).toBeDefined();
        fireEvent.click(screen.getByText("Yes, I'm sure"));
        await waitFor(() => expect(mocks.clearAllCardsAndImages).toHaveBeenCalledTimes(2));

        mocks.clearAllCardsAndImages.mockRejectedValueOnce(new Error('clear failed'));
        mocks.cardCount.mockResolvedValueOnce(0);
        fireEvent.click(screen.getByText('Clear Cards'));
        await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('clear failed'));
    });

    it('runs token imports, no-token modal, paired summaries, and error fallbacks', async () => {
        renderDecklist(1);
        mocks.handleManualTokenImport.mockImplementationOnce(async (options) => options.onNoTokens());
        fireEvent.click(screen.getByText('Add Associated Tokens'));
        await waitFor(() => expect(screen.getByText('No Tokens Found')).toBeDefined());
        expect(mocks.addToast).toHaveBeenCalledWith({ type: 'processing', message: 'Adding associated tokens...', dismissible: true });
        expect(mocks.removeToast).toHaveBeenCalledWith('toast-id');

        mocks.handleManualTokenImport.mockRejectedValueOnce(new Error('token failed'));
        fireEvent.click(screen.getByText('Add Associated Tokens'));
        await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('token failed'));

        fireEvent.click(screen.getByText('Add two sided associated tokens'));
        await waitFor(() => expect(mocks.showInfoToast).toHaveBeenCalledWith('Added 2 two sided associated tokens.'));

        mocks.handleManualTwoSidedTokenImport.mockResolvedValueOnce({ importedTokenCount: 3, pairedTokenCount: 1, unpairedTokenCount: 2 });
        fireEvent.click(screen.getByText('Add two sided associated tokens'));
        await waitFor(() => expect(mocks.showInfoToast).toHaveBeenCalledWith('Added 1 two sided associated token; 2 could not be paired without matching itself.'));

        mocks.handleManualTwoSidedTokenImport.mockResolvedValueOnce({ importedTokenCount: 2, pairedTokenCount: 0, unpairedTokenCount: 2 });
        fireEvent.click(screen.getByText('Add two sided associated tokens'));
        await waitFor(() => expect(mocks.showInfoToast).toHaveBeenCalledWith('At least two different token arts are needed to make two sided associated tokens.'));

        mocks.handleManualTwoSidedTokenImport.mockRejectedValueOnce(new Error('two-side failed'));
        fireEvent.click(screen.getByText('Add two sided associated tokens'));
        await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('two-side failed'));
    });
});
