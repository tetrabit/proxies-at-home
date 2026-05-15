import { describe, it, expect, beforeEach } from 'vitest';
import { useArtworkModalStore } from './artworkModal';
import type { CardOption } from '../../../shared/types';

describe('useArtworkModalStore', () => {
    beforeEach(() => {
        useArtworkModalStore.setState({
            open: false,
            card: null,
            index: null,
            initialTab: 'artwork',
            initialFace: 'front',
        });
    });

    it('should have default state', () => {
        const state = useArtworkModalStore.getState();
        expect(state.open).toBe(false);
        expect(state.card).toBeNull();
        expect(state.index).toBeNull();
        expect(state.initialTab).toBe('artwork');
        expect(state.initialFace).toBe('front');
    });

    it('should open modal', () => {
        const card: CardOption = {
            uuid: '1',
            name: 'Test Card',
            imageId: 'test.jpg',
            order: 0,
            isUserUpload: false
        };

        useArtworkModalStore.getState().openModal({ card, index: 0 });

        const state = useArtworkModalStore.getState();
        expect(state.open).toBe(true);
        expect(state.card).toEqual(card);
        expect(state.index).toBe(0);
    });

    it('should close modal', () => {
        const card: CardOption = {
            uuid: '1',
            name: 'Test Card',
            imageId: 'test.jpg',
            order: 0,
            isUserUpload: false
        };

        useArtworkModalStore.setState({ open: true, card, index: 0 });
        useArtworkModalStore.getState().closeModal();

        const state = useArtworkModalStore.getState();
        expect(state.open).toBe(false);
        expect(state.card).toBeNull();
        expect(state.index).toBeNull();
    });

    it('should update card', () => {
        const card: CardOption = {
            uuid: '1',
            name: 'Test Card',
            imageId: 'test.jpg',
            order: 0,
            isUserUpload: false
        };

        useArtworkModalStore.setState({ open: true, card, index: 0 });

        const updatedCard: CardOption = { ...card, name: 'Updated Card' };
        useArtworkModalStore.getState().updateCard(updatedCard);

        const state = useArtworkModalStore.getState();
        expect(state.card).toEqual(updatedCard);
    });

    it('should not update card if no card is selected', () => {
        useArtworkModalStore.setState({ open: true, card: null, index: 0 });

        const updatedCard: CardOption = {
            uuid: '1',
            name: 'Updated Card',
            imageId: 'test.jpg',
            order: 0,
            isUserUpload: false
        };

        useArtworkModalStore.getState().updateCard(updatedCard);

        const state = useArtworkModalStore.getState();
        expect(state.card).toBeNull();
    });

    it('should open modal with initialFace set to back when specified', () => {
        const card: CardOption = {
            uuid: '1',
            name: 'Test Card',
            imageId: 'test.jpg',
            order: 0,
            isUserUpload: false
        };

        useArtworkModalStore.getState().openModal({ card, index: 0, initialFace: 'back' });

        const state = useArtworkModalStore.getState();
        expect(state.open).toBe(true);
        expect(state.initialFace).toBe('back');
    });

    it('should default initialFace to front when not specified', () => {
        const card: CardOption = {
            uuid: '1',
            name: 'Test Card',
            imageId: 'test.jpg',
            order: 0,
            isUserUpload: false
        };

        useArtworkModalStore.getState().openModal({ card, index: 0 });

        const state = useArtworkModalStore.getState();
        expect(state.initialFace).toBe('front');
    });

    it('should open modal with initialTab set to settings when specified', () => {
        const card: CardOption = {
            uuid: '1',
            name: 'Test Card',
            imageId: 'test.jpg',
            order: 0,
            isUserUpload: false
        };

        useArtworkModalStore.getState().openModal({ card, index: 0, initialTab: 'settings' });

        const state = useArtworkModalStore.getState();
        expect(state.initialTab).toBe('settings');
    });

    it('should reset initialFace and initialTab when modal is closed', () => {
        const card: CardOption = {
            uuid: '1',
            name: 'Test Card',
            imageId: 'test.jpg',
            order: 0,
            isUserUpload: false
        };

        // Open with back face and settings tab
        useArtworkModalStore.getState().openModal({ card, index: 0, initialFace: 'back', initialTab: 'settings' });
        expect(useArtworkModalStore.getState().initialFace).toBe('back');
        expect(useArtworkModalStore.getState().initialTab).toBe('settings');

        // Close modal
        useArtworkModalStore.getState().closeModal();

        // Should reset to defaults
        const state = useArtworkModalStore.getState();
        expect(state.initialFace).toBe('front');
        expect(state.initialTab).toBe('artwork');
    });

    it('should preserve advanced search and art source options when opening', () => {
        const card: CardOption = {
            uuid: '1',
            name: 'Test Card',
            imageId: 'test.jpg',
            order: 0,
            isUserUpload: false
        };

        useArtworkModalStore.getState().openModal({
            card,
            index: 0,
            initialArtSource: 'mpc',
            initialOpenAdvancedSearch: true,
        });

        const state = useArtworkModalStore.getState();
        expect(state.initialArtSource).toBe('mpc');
        expect(state.initialOpenAdvancedSearch).toBe(true);
    });

    it('should navigate to next and previous cards and reset modal context', () => {
        const cards: CardOption[] = [
            { uuid: '1', name: 'Card 1', imageId: '1.jpg', order: 0, isUserUpload: false },
            { uuid: '2', name: 'Card 2', imageId: '2.jpg', order: 1, isUserUpload: false },
            { uuid: '3', name: 'Card 3', imageId: '3.jpg', order: 2, isUserUpload: false }
        ];

        useArtworkModalStore.setState({
            open: true,
            card: cards[1],
            index: 1,
            allCards: cards,
            initialTab: 'settings',
            initialFace: 'back',
            initialArtSource: 'mpc',
            initialOpenAdvancedSearch: true,
        });

        useArtworkModalStore.getState().goToNextCard();
        let state = useArtworkModalStore.getState();
        expect(state.card).toEqual(cards[2]);
        expect(state.index).toBe(2);
        expect(state.initialTab).toBe('artwork');
        expect(state.initialFace).toBe('front');
        expect(state.initialArtSource).toBeNull();

        useArtworkModalStore.getState().goToPrevCard();
        state = useArtworkModalStore.getState();
        expect(state.card).toEqual(cards[1]);
        expect(state.index).toBe(1);
    });

    it('should ignore navigation when no cards are available', () => {
        useArtworkModalStore.setState({
            open: true,
            card: null,
            index: null,
            allCards: [],
        });

        useArtworkModalStore.getState().goToNextCard();
        useArtworkModalStore.getState().goToPrevCard();

        const state = useArtworkModalStore.getState();
        expect(state.card).toBeNull();
        expect(state.index).toBeNull();
    });

    it('should set advanced search zoom directly and via updater', () => {
        useArtworkModalStore.getState().setAdvancedSearchZoom(2);
        expect(useArtworkModalStore.getState().advancedSearchZoom).toBe(2);

        useArtworkModalStore.getState().setAdvancedSearchZoom((prev) => prev + 0.5);
        expect(useArtworkModalStore.getState().advancedSearchZoom).toBe(2.5);
    });
});
