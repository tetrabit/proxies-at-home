import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectedCards: new Set<string>(),
  clearSelection: vi.fn(),
  openArtworkModal: vi.fn(),
  openCalibrationModal: vi.fn(),
  openCardEditor: vi.fn(),
  openMpcUpgrade: vi.fn(),
  showInfoToast: vi.fn(),
  showErrorToast: vi.fn(),
  resetCardToOriginalImage: vi.fn().mockResolvedValue({
    reset: 1,
    skipped: 0,
    alreadyOriginal: 0,
    legacy: 0,
  }),
  undoableDeleteCard: vi.fn().mockResolvedValue(undefined),
  undoableDeleteCardsBatch: vi.fn().mockResolvedValue(undefined),
  undoableDuplicateCard: vi.fn().mockResolvedValue(undefined),
  undoableDuplicateCardsBatch: vi.fn().mockResolvedValue(undefined),
  dbImagesGet: vi.fn(),
}));

vi.mock('flowbite-react', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('lucide-react', () => ({
  Copy: () => <span data-testid="copy-icon" />,
  Trash: () => <span data-testid="trash-icon" />,
  Settings: () => <span data-testid="settings-icon" />,
  Palette: () => <span data-testid="palette-icon" />,
  Sparkles: () => <span data-testid="sparkles-icon" />,
  RotateCcw: () => <span data-testid="rotate-ccw-icon" />,
}));

vi.mock('@/store/selection', () => ({
  useSelectionStore: (selector: (state: { selectedCards: Set<string>; clearSelection: typeof mocks.clearSelection }) => unknown) =>
    selector({ selectedCards: mocks.selectedCards, clearSelection: mocks.clearSelection }),
}));

vi.mock('@/helpers/undoableActions', () => ({
  undoableDeleteCard: (...args: unknown[]) => mocks.undoableDeleteCard(...args),
  undoableDeleteCardsBatch: (...args: unknown[]) => mocks.undoableDeleteCardsBatch(...args),
  undoableDuplicateCard: (...args: unknown[]) => mocks.undoableDuplicateCard(...args),
  undoableDuplicateCardsBatch: (...args: unknown[]) => mocks.undoableDuplicateCardsBatch(...args),
}));

vi.mock('@/helpers/dbUtils', () => ({
  resetCardToOriginalImage: (...args: unknown[]) => mocks.resetCardToOriginalImage(...args),
}));

vi.mock('@/store', () => ({
  useArtworkModalStore: (selector: (state: { openModal: typeof mocks.openArtworkModal }) => unknown) =>
    selector({ openModal: mocks.openArtworkModal }),
  useCalibrationModalStore: (selector: (state: { openModal: typeof mocks.openCalibrationModal }) => unknown) =>
    selector({ openModal: mocks.openCalibrationModal }),
  useCardEditorModalStore: (selector: (state: { openModal: typeof mocks.openCardEditor }) => unknown) =>
    selector({ openModal: mocks.openCardEditor }),
  useMpcUpgradeModalStore: (selector: (state: { openModal: typeof mocks.openMpcUpgrade }) => unknown) =>
    selector({ openModal: mocks.openMpcUpgrade }),
}));

vi.mock('@/store/toast', () => ({
  useToastStore: (selector: (state: {
    showInfoToast: typeof mocks.showInfoToast;
    showErrorToast: typeof mocks.showErrorToast;
  }) => unknown) => selector({
    showInfoToast: mocks.showInfoToast,
    showErrorToast: mocks.showErrorToast,
  }),
}));

vi.mock('@/db', () => ({
  db: { images: { get: (id: string) => mocks.dbImagesGet(id) } },
}));

import {
  PageViewContextMenu,
} from './PageViewContextMenu';
import {
  getOriginalArtResetTargetCard,
  getOriginalArtResetToastMessage,
} from './pageViewContextMenuUtils';

const front = { uuid: 'front-1', name: 'Island', imageId: 'img-1', linkedBackId: 'back-1' };
const back = { uuid: 'back-1', name: 'Island Back', imageId: 'img-back', linkedFrontId: 'front-1' };
const cards = [front, back];
const visibleContextMenu = { visible: true, x: 12, y: 34, cardUuid: 'front-1' };

function renderMenu(overrides: Partial<React.ComponentProps<typeof PageViewContextMenu>> = {}) {
  const setContextMenu = vi.fn();
  render(
    <PageViewContextMenu
      contextMenu={visibleContextMenu}
      setContextMenu={setContextMenu}
      cards={cards as never[]}
      flippedCards={new Set()}
      {...overrides}
    />
  );
  return setContextMenu;
}

describe('PageViewContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectedCards = new Set();
    mocks.dbImagesGet.mockImplementation(async (id: string) => ({ id }));
    mocks.resetCardToOriginalImage.mockResolvedValue({
      reset: 1,
      skipped: 0,
      alreadyOriginal: 0,
      legacy: 0,
    });
  });

  it('renders nothing when hidden or missing a card uuid', () => {
    const { container, rerender } = render(
      <PageViewContextMenu
        contextMenu={{ ...visibleContextMenu, visible: false }}
        setContextMenu={vi.fn()}
        cards={cards as never[]}
        flippedCards={new Set()}
      />
    );

    expect(container.firstChild).toBeNull();

    rerender(
      <PageViewContextMenu
        contextMenu={{ ...visibleContextMenu, cardUuid: null }}
        setContextMenu={vi.fn()}
        cards={cards as never[]}
        flippedCards={new Set()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('runs single-card actions and closes the menu', async () => {
    const setContextMenu = renderMenu({ flippedCards: new Set(['front-1']) });

    fireEvent.click(screen.getByText('Adjust Art'));
    await waitFor(() => expect(mocks.openCardEditor).toHaveBeenCalledWith({
      card: front,
      image: { id: 'img-1' },
      backCard: back,
      backImage: { id: 'img-back' },
      initialFace: 'back',
    }));

    fireEvent.click(screen.getByText('Duplicate'));
    await waitFor(() => expect(mocks.undoableDuplicateCard).toHaveBeenCalledWith('front-1'));

    fireEvent.click(screen.getByTestId('card-context-menu-mpc-upgrade'));
    expect(mocks.openMpcUpgrade).toHaveBeenCalledWith({ cardUuid: 'front-1', card: front });

    fireEvent.click(screen.getByTestId('card-context-menu-mpc-calibration'));
    expect(mocks.openCalibrationModal).toHaveBeenCalledWith({ cardUuid: 'front-1', card: front });

    fireEvent.click(screen.getByTestId('card-context-menu-reset-original-art'));
    await waitFor(() => expect(mocks.resetCardToOriginalImage).toHaveBeenCalledWith('back-1'));
    expect(mocks.showInfoToast).toHaveBeenCalledWith('Reset "Island Back" to original import art.');

    fireEvent.click(screen.getByText('Settings'));
    expect(mocks.openArtworkModal).toHaveBeenCalledWith({
      card: front,
      index: null,
      allCards: cards,
      initialTab: 'settings',
    });

    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(mocks.undoableDeleteCard).toHaveBeenCalledWith('front-1'));
    expect(setContextMenu).toHaveBeenCalledWith({ ...visibleContextMenu, visible: false });
  });

  it('runs multi-selection actions', async () => {
    mocks.selectedCards = new Set(['front-1', 'back-1']);
    renderMenu();

    fireEvent.click(screen.getByText('Adjust 2 Cards'));
    await waitFor(() => expect(mocks.openCardEditor).toHaveBeenCalledWith({
      card: front,
      image: { id: 'img-1' },
      backCard: back,
      backImage: { id: 'img-back' },
      selectedCardUuids: ['front-1', 'back-1'],
    }));

    fireEvent.click(screen.getByText('Duplicate 2 Cards'));
    await waitFor(() => expect(mocks.undoableDuplicateCardsBatch).toHaveBeenCalledWith(['front-1', 'back-1']));
    expect(mocks.clearSelection).toHaveBeenCalled();

    fireEvent.click(screen.getByText('2 Cards Settings'));
    expect(mocks.openArtworkModal).toHaveBeenCalledWith({
      card: front,
      index: null,
      allCards: cards,
      initialTab: 'settings',
    });

    fireEvent.click(screen.getByText('Delete 2 Cards'));
    await waitFor(() => expect(mocks.undoableDeleteCardsBatch).toHaveBeenCalledWith(['front-1', 'back-1']));
  });

  it('closes on outside click and mouse leave while ignoring inside clicks', () => {
    const setContextMenu = renderMenu();
    const menu = document.getElementById('mobile-context-menu')!;

    fireEvent.click(menu);
    expect(setContextMenu).not.toHaveBeenCalled();

    fireEvent.click(document.body);
    expect(setContextMenu).toHaveBeenCalledWith({ ...visibleContextMenu, visible: false });

    fireEvent.mouseLeave(menu);
    expect(setContextMenu).toHaveBeenCalledWith({ ...visibleContextMenu, visible: false });
  });


  it('covers single-card fallback branches when cards or back images are unavailable', async () => {
    const oneSidedCard = { uuid: 'front-1', name: 'Island', imageId: 'img-1' };
    const setContextMenu = renderMenu({ cards: [oneSidedCard] as never[] });

    fireEvent.click(screen.getByText('Adjust Art'));
    await waitFor(() => expect(mocks.openCardEditor).toHaveBeenCalledWith({
      card: oneSidedCard,
      image: { id: 'img-1' },
      backCard: undefined,
      backImage: null,
      initialFace: 'front',
    }));

    expect(setContextMenu).toHaveBeenCalledWith({ ...visibleContextMenu, visible: false });
  });

  it('closes single-card modal actions without opening when the card is missing', () => {
    const setContextMenu = renderMenu({ cards: [] });

    fireEvent.click(screen.getByTestId('card-context-menu-mpc-upgrade'));
    fireEvent.click(screen.getByTestId('card-context-menu-mpc-calibration'));
    fireEvent.click(screen.getByTestId('card-context-menu-reset-original-art'));
    fireEvent.click(screen.getByText('Settings'));

    expect(mocks.openMpcUpgrade).not.toHaveBeenCalled();
    expect(mocks.openCalibrationModal).not.toHaveBeenCalled();
    expect(mocks.resetCardToOriginalImage).not.toHaveBeenCalled();
    expect(mocks.openArtworkModal).not.toHaveBeenCalled();
    expect(setContextMenu).toHaveBeenCalledWith({ ...visibleContextMenu, visible: false });
  });

  it('shows an error toast when returning to original import art fails', async () => {
    mocks.resetCardToOriginalImage.mockRejectedValueOnce(new Error('boom'));
    const setContextMenu = renderMenu();

    fireEvent.click(screen.getByTestId('card-context-menu-reset-original-art'));

    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith(
      'Failed to return card to original import art.'
    ));
    expect(setContextMenu).toHaveBeenCalledWith({ ...visibleContextMenu, visible: false });
  });

  it('formats return-to-original-art status messages', () => {
    expect(getOriginalArtResetToastMessage({
      reset: 1,
      skipped: 0,
      alreadyOriginal: 0,
      legacy: 0,
    }, 'Island')).toBe('Reset "Island" to original import art.');
    expect(getOriginalArtResetToastMessage({
      reset: 0,
      skipped: 0,
      alreadyOriginal: 1,
      legacy: 0,
    }, 'Island')).toBe('"Island" is already using original import art.');
    expect(getOriginalArtResetToastMessage({
      reset: 0,
      skipped: 0,
      alreadyOriginal: 0,
      legacy: 1,
    }, 'Island')).toBe('Cannot reset "Island" because no original import art history is available.');
    expect(getOriginalArtResetToastMessage({
      reset: 0,
      skipped: 1,
      alreadyOriginal: 0,
      legacy: 0,
    }, 'Island')).toBe('No original import art found for "Island".');
  });

  it('targets the visible linked back card only when the menu card is flipped', () => {
    expect(getOriginalArtResetTargetCard(cards as never[], 'front-1', new Set())).toBe(front);
    expect(getOriginalArtResetTargetCard(cards as never[], 'front-1', new Set(['front-1']))).toBe(back);
    expect(getOriginalArtResetTargetCard([{ ...front, linkedBackId: 'missing-back' }] as never[], 'front-1', new Set(['front-1']))).toEqual({
      ...front,
      linkedBackId: 'missing-back',
    });
    expect(getOriginalArtResetTargetCard(cards as never[], 'missing', new Set())).toBeUndefined();
  });

  it('closes multi-select editor/settings actions without opening when the card is missing', async () => {
    mocks.selectedCards = new Set(['front-1', 'back-1']);
    const setContextMenu = renderMenu({ cards: [] });

    fireEvent.click(screen.getByText('Adjust 2 Cards'));
    await waitFor(() => expect(setContextMenu).toHaveBeenCalledWith({ ...visibleContextMenu, visible: false }));

    fireEvent.click(screen.getByText('2 Cards Settings'));

    expect(mocks.openCardEditor).not.toHaveBeenCalled();
    expect(mocks.openArtworkModal).not.toHaveBeenCalled();
    expect(setContextMenu).toHaveBeenCalledWith({ ...visibleContextMenu, visible: false });
  });


  it('closes single-card editor action without opening when the selected card lacks an image id', async () => {
    const setContextMenu = renderMenu({ cards: [{ uuid: 'front-1', name: 'No image id' }] as never[] });

    fireEvent.click(screen.getByText('Adjust Art'));

    await waitFor(() => expect(setContextMenu).toHaveBeenCalledWith({ ...visibleContextMenu, visible: false }));
    expect(mocks.openCardEditor).not.toHaveBeenCalled();
  });

  it('opens the editor with null image data when database images are unavailable', async () => {
    mocks.dbImagesGet.mockResolvedValue(null);
    const cardWithMissingImage = { uuid: 'front-1', name: 'No image', imageId: 'missing-image' };
    const setContextMenu = renderMenu({
      cards: [cardWithMissingImage] as never[],
    });

    fireEvent.click(screen.getByText('Adjust Art'));
    await waitFor(() => expect(mocks.openCardEditor).toHaveBeenCalledWith({
      card: cardWithMissingImage,
      image: null,
      backCard: undefined,
      backImage: null,
      initialFace: 'front',
    }));
    expect(setContextMenu).toHaveBeenCalledWith({ ...visibleContextMenu, visible: false });
  });
});
