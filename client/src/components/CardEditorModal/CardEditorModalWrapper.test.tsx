import 'fake-indexeddb/auto';
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CardEditorModalWrapper } from './CardEditorModalWrapper';
import { useCardEditorModalStore } from '@/store';
import { useSettingsStore } from '@/store/settings';
import { db } from '@/db';
import { useLiveQuery } from 'dexie-react-hooks';
import * as effectCache from '@/helpers/effectCache';
import type { CardOption } from '../../../../shared/types';

type MockModalProps = {
    onApply: (uuid: string, overrides: unknown) => Promise<void>;
    onApplyToAll: (overrides: unknown) => Promise<void>;
    onApplyToSelected: (uuids: string[], overrides: unknown) => Promise<void>;
    onClose: () => void;
    card: { uuid: string };
};

let latestModalProps: MockModalProps | undefined;

// Mocks
vi.mock('@/store', () => ({
    useCardEditorModalStore: vi.fn(),
}));

vi.mock('@/store/settings', () => ({
    useSettingsStore: vi.fn(),
}));

vi.mock('dexie-react-hooks', () => ({
    useLiveQuery: vi.fn(),
}));

vi.mock('@/db', () => ({
    db: {
        cards: {
            get: vi.fn(),
            update: vi.fn(),
            toArray: vi.fn(),
            bulkPut: vi.fn(),
            where: vi.fn(() => ({
                equals: vi.fn(() => ({
                    toArray: vi.fn(),
                })),
                anyOf: vi.fn(() => ({
                    toArray: vi.fn(),
                })),
            })),
        },
        images: {
            get: vi.fn(),
            bulkGet: vi.fn(),
        },
        cardbacks: {
            get: vi.fn(),
        },
        transaction: vi.fn((_mode, _tables, cb) => cb()),
    },
}));

vi.mock('./CardEditorModal', () => ({
    CardEditorModal: (props: MockModalProps) => {
        latestModalProps = props;
        return (
            <div data-testid="card-editor-modal">
                <button onClick={() => void props.onApply(props.card.uuid, { brightness: 1.5 })}>Apply</button>
                <button onClick={() => props.onApplyToAll({ brightness: 1.5 })}>Apply All</button>
                <button onClick={() => void props.onApplyToSelected(['uuid1', 'uuid2'], { brightness: 1.5 })}>Apply Selected</button>
                <button onClick={props.onClose}>Close</button>
            </div>
        );
    },
}));

vi.mock('@/helpers/effectCache', () => ({
    preRenderEffect: vi.fn().mockResolvedValue(undefined),
    queueBulkPreRender: vi.fn(),
}));

vi.mock('@/helpers/adjustmentUtils', () => ({
    hasActiveAdjustments: vi.fn().mockReturnValue(true),
}));

describe('CardEditorModalWrapper', () => {
    const mockStoreData = {
        open: true,
        card: { uuid: 'test-uuid', imageId: 'test-img', projectId: 'project-a' },
        image: { id: 'test-img' },
        backCard: { uuid: 'back-uuid', imageId: 'back-img' },
        backImage: null,
        selectedCardUuids: ['test-uuid'],
        initialFace: 'front',
        closeModal: vi.fn(),
        openModal: vi.fn(),
    };

    const mockModalStore = vi.mocked(useCardEditorModalStore);
    const mockSettingsStore = vi.mocked(useSettingsStore);
    const mockLiveQuery = vi.mocked(useLiveQuery);

    beforeEach(() => {
        vi.clearAllMocks();
        latestModalProps = undefined;
        mockModalStore.mockImplementation((selector: (state: typeof mockStoreData) => unknown) => selector(mockStoreData));
        mockSettingsStore.mockImplementation((selector: (state: { dpi: number }) => unknown) => selector({ dpi: 300 }));
    });

    const renderWithActualDexie = (actualDb: typeof db) => {
        const mockCards = db.cards;
        const mockTransaction = db.transaction;
        db.cards = actualDb.cards;
        db.transaction = actualDb.transaction.bind(actualDb) as typeof db.transaction;
        mockLiveQuery
            .mockReturnValueOnce({ uuid: 'editor-card', imageId: 'editor-image', projectId: 'project-a' })
            .mockReturnValueOnce(undefined)
            .mockReturnValueOnce(undefined)
            .mockReturnValueOnce(undefined);
        render(<CardEditorModalWrapper />);
        const applySelected = latestModalProps?.onApplyToSelected;
        if (!applySelected) throw new Error('Expected selected-apply callback');

        return {
            applySelected,
            restore: () => {
                db.cards = mockCards;
                db.transaction = mockTransaction;
            },
        };
    };

    it('should render nothing if card is missing (loading state)', () => {
        // Ensure store has no card so fallback doesn't happen
        mockModalStore.mockImplementation((selector: (state: typeof mockStoreData) => unknown) => selector({
            ...mockStoreData,
            card: null
        }));
        mockLiveQuery.mockReturnValue(undefined); // Simulate loading
        const { container } = render(<CardEditorModalWrapper />);
        expect(container).toBeEmptyDOMElement();
    });

    it('should render modal when data is loaded', () => {
        // Mock live queries returning data in order:
        mockLiveQuery
            .mockReturnValueOnce({ uuid: 'test-uuid', imageId: 'test-img' })
            .mockReturnValueOnce({ id: 'test-img' })
            .mockReturnValueOnce({ uuid: 'back-uuid', imageId: 'back-img' })
            .mockReturnValueOnce({ id: 'back-img' });

        render(<CardEditorModalWrapper />);
        expect(screen.getByTestId('card-editor-modal')).toBeInTheDocument();
    });

    it('should handle apply actions', async () => {
        mockLiveQuery
            .mockReturnValueOnce({ uuid: 'test-uuid', imageId: 'test-img' })
            .mockReturnValueOnce({ id: 'test-img', exportBlob: new Blob([]) })
            .mockReturnValueOnce(undefined)
            .mockReturnValueOnce(undefined);

        (db.cards.get as Mock).mockResolvedValue({ uuid: 'test-uuid', imageId: 'test-img' });
        (db.images.get as Mock).mockResolvedValue({ id: 'test-img', exportBlob: new Blob([]) });

        render(<CardEditorModalWrapper />);

        const applyBtn = screen.getByText('Apply');
        await act(async () => {
            applyBtn.click();
        });

        expect(db.cards.update).toHaveBeenCalledWith('test-uuid', { overrides: { brightness: 1.5 } });
        expect(effectCache.preRenderEffect).toHaveBeenCalled();
    });

    it('should handle apply all', async () => {
        mockLiveQuery
            .mockReturnValueOnce({ uuid: 'test-uuid', imageId: 'test-img', projectId: 'project-a' })
            .mockReturnValueOnce({ id: 'test-img' })
            .mockReturnValueOnce(undefined)
            .mockReturnValueOnce(undefined);

        const mockCards = [
            { uuid: '1', imageId: 'img1', projectId: 'project-a' },
            { uuid: '2', imageId: 'img2', projectId: 'project-a' }
        ];
        (db.cards.where as Mock).mockReturnValue({
            equals: vi.fn().mockReturnValue({
                toArray: vi.fn().mockResolvedValue(mockCards),
            }),
        });
        (db.images.bulkGet as Mock).mockResolvedValue([{ id: 'img1', exportBlob: {} }, { id: 'img2', exportBlob: {} }]);

        render(<CardEditorModalWrapper />);

        const applyAllBtn = screen.getByText('Apply All');
        await act(async () => {
            applyAllBtn.click();
        });

        expect(db.cards.bulkPut).toHaveBeenCalledWith([
            { uuid: '1', imageId: 'img1', projectId: 'project-a', overrides: { brightness: 1.5 } },
            { uuid: '2', imageId: 'img2', projectId: 'project-a', overrides: { brightness: 1.5 } }
        ]);

        // Wait for setTimeout
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(effectCache.queueBulkPreRender).toHaveBeenCalled();
    });

    it('rejects apply-all without an editor project before any project query', async () => {
        mockLiveQuery
            .mockReturnValueOnce({ uuid: 'test-uuid', imageId: 'test-img' })
            .mockReturnValueOnce({ id: 'test-img' })
            .mockReturnValueOnce(undefined)
            .mockReturnValueOnce(undefined);

        render(<CardEditorModalWrapper />);

        const applyToAll = latestModalProps?.onApplyToAll;
        if (!applyToAll) throw new Error('Expected apply-all callback');

        await expect(applyToAll({ brightness: 1.5 }))
            .rejects.toThrow('Cannot apply overrides without an editor project');
        expect(db.cards.where).not.toHaveBeenCalled();
        expect(db.cards.bulkPut).not.toHaveBeenCalled();
        expect(effectCache.queueBulkPreRender).not.toHaveBeenCalled();
    });

    it('applies all overrides and queues pre-renders only for the captured card project', async () => {
        vi.useFakeTimers();
        try {
            mockLiveQuery
                .mockReturnValueOnce({ uuid: 'a1', imageId: 'img-a1', projectId: 'project-a' })
                .mockReturnValueOnce({ id: 'img-a1' })
                .mockReturnValueOnce(undefined)
                .mockReturnValueOnce(undefined);

            const projectACards = [
                { uuid: 'a1', imageId: 'img-a1', projectId: 'project-a' },
                { uuid: 'a2', imageId: 'img-a2', projectId: 'project-a' },
            ];
            const projectBCard = {
                uuid: 'b1',
                imageId: 'img-b1',
                projectId: 'project-b',
                overrides: { brightness: 0.25 },
            };
            let persistedCards = [...projectACards, projectBCard];
            const capturedProjectCards = vi.fn().mockResolvedValue(projectACards);
            const equalsCapturedProject = vi.fn().mockReturnValue({
                toArray: capturedProjectCards,
            });

            (db.cards.where as Mock).mockReturnValue({
                equals: equalsCapturedProject,
            });
            (db.cards.bulkPut as Mock).mockImplementation(async (updates) => {
                persistedCards = persistedCards.map(card =>
                    updates.find((update: { uuid: string }) => update.uuid === card.uuid) ?? card
                );
            });
            (db.images.bulkGet as Mock).mockResolvedValue([
                { id: 'img-a1', exportBlob: 'export-a1' },
                { id: 'img-a2', exportBlob: 'export-a2' },
            ]);

            render(<CardEditorModalWrapper />);

            await act(async () => {
                screen.getByText('Apply All').click();
                await Promise.resolve();
            });

            expect(db.cards.where).toHaveBeenCalledWith('projectId');
            expect(equalsCapturedProject).toHaveBeenCalledWith('project-a');
            expect(capturedProjectCards).toHaveBeenCalledTimes(1);
            expect(db.cards.bulkPut).toHaveBeenCalledWith([
                { uuid: 'a1', imageId: 'img-a1', projectId: 'project-a', overrides: { brightness: 1.5 } },
                { uuid: 'a2', imageId: 'img-a2', projectId: 'project-a', overrides: { brightness: 1.5 } },
            ]);
            expect(persistedCards.find(card => card.uuid === 'b1')).toEqual(projectBCard);

            await act(async () => {
                await vi.runAllTimersAsync();
            });

            expect(effectCache.queueBulkPreRender).toHaveBeenCalledWith([
                {
                    card: { uuid: 'a1', imageId: 'img-a1', projectId: 'project-a', overrides: { brightness: 1.5 } },
                    exportBlob: 'export-a1',
                },
                {
                    card: { uuid: 'a2', imageId: 'img-a2', projectId: 'project-a', overrides: { brightness: 1.5 } },
                    exportBlob: 'export-a2',
                },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('should handle apply selected', async () => {
        mockLiveQuery
            .mockReturnValueOnce({ uuid: 'test-uuid', imageId: 'test-img', projectId: 'project-a' })
            .mockReturnValueOnce({ id: 'test-img' })
            .mockReturnValueOnce(undefined)
            .mockReturnValueOnce(undefined);

        const mockCards = [
            { uuid: 'uuid1', imageId: 'img1', projectId: 'project-a' },
            { uuid: 'uuid2', imageId: 'img2', projectId: 'project-a' }
        ];
        // Mock where().anyOf().toArray() chain
        (db.cards.where as Mock).mockReturnValue({
            anyOf: vi.fn().mockReturnValue({
                toArray: vi.fn().mockResolvedValue(mockCards)
            })
        });
        (db.images.bulkGet as Mock).mockResolvedValue([{ id: 'img1', exportBlob: {} }, { id: 'img2', exportBlob: {} }]);

        render(<CardEditorModalWrapper />);

        const applySelectedBtn = screen.getByText('Apply Selected');
        await act(async () => {
            applySelectedBtn.click();
        });

        expect(db.cards.bulkPut).toHaveBeenCalledWith([
            { uuid: 'uuid1', imageId: 'img1', projectId: 'project-a', overrides: { brightness: 1.5 } },
            { uuid: 'uuid2', imageId: 'img2', projectId: 'project-a', overrides: { brightness: 1.5 } }
        ]);

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(effectCache.queueBulkPreRender).toHaveBeenCalled();
    });

    it('rejects foreign selected cards before bulk writes in a real Dexie transaction', async () => {
        const { db: actualDb } = await vi.importActual<typeof import('@/db')>('@/db');
        const testId = crypto.randomUUID();
        const projectCard: CardOption = {
            uuid: `${testId}-project`,
            name: 'Project card',
            order: 0,
            isUserUpload: false,
            projectId: 'project-a',
        };
        const foreignCard: CardOption = {
            uuid: `${testId}-foreign`,
            name: 'Foreign card',
            order: 1,
            isUserUpload: false,
            projectId: 'project-b',
        };
        await actualDb.cards.bulkAdd([projectCard, foreignCard]);
        const bulkPut = vi.spyOn(actualDb.cards, 'bulkPut');
        const { applySelected, restore } = renderWithActualDexie(actualDb);

        try {
            await expect(applySelected(
                [projectCard.uuid, foreignCard.uuid],
                { brightness: 1.5 },
            )).rejects.toThrow('Cannot apply overrides to cards outside the editor project');

            expect(bulkPut).not.toHaveBeenCalled();
            expect((await actualDb.cards.get(projectCard.uuid))?.overrides).toBeUndefined();
            expect((await actualDb.cards.get(foreignCard.uuid))?.overrides).toBeUndefined();
        } finally {
            restore();
            bulkPut.mockRestore();
        }
    });

    it('rejects a missing selected card before bulk writes in a real Dexie transaction', async () => {
        const { db: actualDb } = await vi.importActual<typeof import('@/db')>('@/db');
        const testId = crypto.randomUUID();
        const projectCard: CardOption = {
            uuid: `${testId}-project`,
            name: 'Project card',
            order: 0,
            isUserUpload: false,
            projectId: 'project-a',
        };
        await actualDb.cards.add(projectCard);
        const bulkPut = vi.spyOn(actualDb.cards, 'bulkPut');
        const { applySelected, restore } = renderWithActualDexie(actualDb);

        try {
            await expect(applySelected(
                [projectCard.uuid, `${testId}-missing`],
                { brightness: 1.5 },
            )).rejects.toThrow('Cannot apply overrides to cards outside the editor project');

            expect(bulkPut).not.toHaveBeenCalled();
            expect((await actualDb.cards.get(projectCard.uuid))?.overrides).toBeUndefined();
        } finally {
            restore();
            bulkPut.mockRestore();
        }
    });

    it('rejects a projectless selected card before bulk writes in a real Dexie transaction', async () => {
        const { db: actualDb } = await vi.importActual<typeof import('@/db')>('@/db');
        const testId = crypto.randomUUID();
        const projectlessCard: CardOption = {
            uuid: `${testId}-projectless`,
            name: 'Projectless card',
            order: 0,
            isUserUpload: false,
        };
        await actualDb.cards.add(projectlessCard);
        const bulkPut = vi.spyOn(actualDb.cards, 'bulkPut');
        const { applySelected, restore } = renderWithActualDexie(actualDb);

        try {
            await expect(applySelected(
                [projectlessCard.uuid],
                { brightness: 1.5 },
            )).rejects.toThrow('Cannot apply overrides to cards outside the editor project');

            expect(bulkPut).not.toHaveBeenCalled();
            expect((await actualDb.cards.get(projectlessCard.uuid))?.overrides).toBeUndefined();
        } finally {
            restore();
            bulkPut.mockRestore();
        }
    });

    it('rejects an empty selected-card list before a real Dexie transaction writes', async () => {
        const { db: actualDb } = await vi.importActual<typeof import('@/db')>('@/db');
        const bulkPut = vi.spyOn(actualDb.cards, 'bulkPut');
        const { applySelected, restore } = renderWithActualDexie(actualDb);

        try {
            await expect(applySelected(
                [],
                { brightness: 1.5 },
            )).rejects.toThrow('Cannot apply overrides without selected cards');

            expect(bulkPut).not.toHaveBeenCalled();
        } finally {
            restore();
            bulkPut.mockRestore();
        }
    });

    it('updates same-project selected cards in a real Dexie transaction', async () => {
        const { db: actualDb } = await vi.importActual<typeof import('@/db')>('@/db');
        const testId = crypto.randomUUID();
        const selectedCards: CardOption[] = [
            {
                uuid: `${testId}-one`,
                name: 'First project card',
                order: 0,
                isUserUpload: false,
                projectId: 'project-a',
            },
            {
                uuid: `${testId}-two`,
                name: 'Second project card',
                order: 1,
                isUserUpload: false,
                projectId: 'project-a',
            },
        ];
        await actualDb.cards.bulkAdd(selectedCards);
        const bulkPut = vi.spyOn(actualDb.cards, 'bulkPut');
        const { applySelected, restore } = renderWithActualDexie(actualDb);

        try {
            await expect(applySelected(
                selectedCards.map(card => card.uuid),
                { brightness: 1.5 },
            )).resolves.toBeUndefined();

            expect(bulkPut).toHaveBeenCalledTimes(1);
            await expect(actualDb.cards.bulkGet(selectedCards.map(card => card.uuid))).resolves.toEqual([
                expect.objectContaining({ uuid: selectedCards[0].uuid, overrides: { brightness: 1.5 } }),
                expect.objectContaining({ uuid: selectedCards[1].uuid, overrides: { brightness: 1.5 } }),
            ]);
        } finally {
            restore();
            bulkPut.mockRestore();
        }
    });

    it('rejects a mixed-project selection before bulk writes and keeps the modal open', async () => {
        mockLiveQuery
            .mockReturnValueOnce({ uuid: 'a1', imageId: 'img-a1', projectId: 'project-a' })
            .mockReturnValueOnce({ id: 'img-a1' })
            .mockReturnValueOnce(undefined)
            .mockReturnValueOnce(undefined);

        (db.cards.where as Mock).mockReturnValue({
            anyOf: vi.fn().mockReturnValue({
                toArray: vi.fn().mockResolvedValue([
                    { uuid: 'a1', imageId: 'img-a1', projectId: 'project-a' },
                    { uuid: 'b1', imageId: 'img-b1', projectId: 'project-b' },
                ]),
            }),
        });

        render(<CardEditorModalWrapper />);

        const applyToSelected = latestModalProps?.onApplyToSelected;
        if (!applyToSelected) throw new Error('Expected selected-apply callback');

        await expect(applyToSelected(['a1', 'b1'], { brightness: 1.5 }))
            .rejects.toThrow('Cannot apply overrides to cards outside the editor project');

        expect(db.cards.bulkPut).not.toHaveBeenCalled();
        expect(effectCache.queueBulkPreRender).not.toHaveBeenCalled();
        expect(screen.getByTestId('card-editor-modal')).toBeInTheDocument();
        expect(mockStoreData.closeModal).not.toHaveBeenCalled();
    });

    describe('Back Image Logic', () => {
        it('should load back image from images table', async () => {
            let backImageCb: (() => Promise<unknown>) | undefined;
            let callCount = 0;

            mockLiveQuery.mockImplementation((((cb: () => Promise<unknown>) => {
                callCount++;
                if (callCount === 1) return { uuid: 'test-uuid', imageId: 'test-id' };
                if (callCount === 2) return { id: 'test-id' };
                if (callCount === 3) return { uuid: 'back-uuid', imageId: 'back-img-id' };
                if (callCount === 4) {
                    backImageCb = cb;
                    return undefined;
                }
                return undefined;
            }) as typeof useLiveQuery));

            render(<CardEditorModalWrapper />);

            expect(backImageCb).toBeDefined();
            if (!backImageCb) return;

            // 1. Test image found in images table
            (db.images.get as Mock).mockResolvedValue({ id: 'back-img-1' });
            const result1 = await backImageCb();
            expect(result1).toEqual({ id: 'back-img-1' });

            // 2. Test fallback to cardbacks table
            (db.images.get as Mock).mockResolvedValue(undefined);
            (db.cardbacks.get as Mock).mockResolvedValue({
                id: 'cb-1',
                displayBlob: 'blob1',
                exportBlob: 'blob2'
            });

            const result2 = await backImageCb();
            expect(result2).toEqual(expect.objectContaining({
                id: 'cb-1',
                displayBlob: 'blob1',
                baseDisplayBlob: 'blob1',
                displayDpi: 300
            }));

            // 3. Test nothing found
            (db.cardbacks.get as Mock).mockResolvedValue(undefined);
            const result3 = await backImageCb();
            expect(result3).toBeUndefined();
        });
    });

    describe('Null/undefined branch coverage', () => {
        it('should handle null storeCard in live query', () => {
            // Setup store to not have a card
            mockModalStore.mockImplementation((selector: (state: typeof mockStoreData) => unknown) => selector({
                ...mockStoreData,
                card: null,
                backCard: null,
            }));

            // Execute each live query callback to simulate the undefined path
            const queryCallbacks: Array<() => Promise<unknown> | unknown> = [];
            mockLiveQuery.mockImplementation(((cb: () => Promise<unknown>) => {
                queryCallbacks.push(cb);
                return undefined;
            }) as typeof useLiveQuery);

            render(<CardEditorModalWrapper />);

            // Should have 4 live queries
            expect(queryCallbacks.length).toBe(4);

            // Execute each callback to trigger the branches
            queryCallbacks.forEach(cb => {
                // Each callback should handle undefined/null gracefully
                expect(() => cb()).not.toThrow();
            });
        });

        it('should handle null imageId in live query', async () => {
            mockModalStore.mockImplementation((selector: (state: typeof mockStoreData) => unknown) => selector({
                ...mockStoreData,
                card: { uuid: 'test', imageId: null },
                backCard: { uuid: 'back', imageId: null },
            }));

            let imageQueryCallback: (() => Promise<unknown>) | undefined;
            let callCount = 0;

            mockLiveQuery.mockImplementation(((cb: () => Promise<unknown>) => {
                callCount++;
                if (callCount === 2) {
                    imageQueryCallback = cb;
                }
                return undefined;
            }) as typeof useLiveQuery);

            render(<CardEditorModalWrapper />);

            // Execute the image query callback - should return undefined for null imageId
            if (imageQueryCallback) {
                const result = await imageQueryCallback();
                expect(result).toBeUndefined();
            }
        });
    });
});
