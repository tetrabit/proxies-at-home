import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectedCards: new Set<string>(),
  clearSelection: vi.fn(),
  openArtworkModal: vi.fn(),
  openCalibrationModal: vi.fn(),
  openCardEditor: vi.fn(),
  openMpcUpgrade: vi.fn(),
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

vi.mock('@/db', () => ({
  db: { images: { get: (id: string) => mocks.dbImagesGet(id) } },
}));

import { PageViewContextMenu } from './PageViewContextMenu';

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

  it('closes without opening editors when card image data is unavailable', async () => {
    mocks.dbImagesGet.mockResolvedValue(null);
    const setContextMenu = renderMenu({ cards: [{ uuid: 'front-1', name: 'No image' }] as never[] });

    fireEvent.click(screen.getByText('Adjust Art'));
    await waitFor(() => expect(setContextMenu).toHaveBeenCalledWith({ ...visibleContextMenu, visible: false }));
    expect(mocks.openCardEditor).not.toHaveBeenCalled();
  });
});
