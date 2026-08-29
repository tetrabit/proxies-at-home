import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const projectState = vi.hoisted(() => ({
  projects: [
    { id: 'p1', name: 'Current Deck' },
    { id: 'p2', name: 'Side Deck' },
  ],
  currentProjectId: 'p1' as string | null,
  switchProject: vi.fn().mockResolvedValue(undefined),
  createProject: vi.fn().mockResolvedValue('new-project'),
  deleteProject: vi.fn().mockResolvedValue(undefined),
  renameProject: vi.fn().mockResolvedValue(undefined),
}));

const settingsState = vi.hoisted(() => ({
  pageSizePreset: 'letter', columns: 3, rows: 3, dpi: 300,
  bleedEdge: false, bleedEdgeWidth: 0, withBleedSourceAmount: 0,
  withBleedTargetMode: 'none', withBleedTargetAmount: 0,
  noBleedTargetMode: 'none', noBleedTargetAmount: 0,
  darkenMode: 'none', darkenContrast: 0, darkenEdgeWidth: 0,
  darkenAmount: 0, darkenBrightness: 0, darkenAutoDetect: false,
  perCardGuideStyle: 'none', guideColor: '#000000', guideWidth: 1,
  guidePlacement: 'corners', cutGuideLengthMm: 5, cutLineStyle: 'solid',
  cardSpacingMm: 0, cardPositionX: 0, cardPositionY: 0,
  useCustomBackOffset: false, cardBackPositionX: 0, cardBackPositionY: 0,
  preferredArtSource: 'scryfall', globalLanguage: 'en', autoImportTokens: false,
  mpcFuzzySearch: false, showProcessingToasts: true, sortBy: 'order', sortOrder: 'asc',
  filterManaCost: [], filterColors: [], filterTypes: [], filterCategories: [],
  filterFeatures: [], filterMatchType: 'any', exportMode: 'fronts', decklistSortAlpha: false,
}));

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  showErrorToast: vi.fn(),
  showCopyToast: vi.fn(),
  showSuccessToast: vi.fn(),
  createShare: vi.fn().mockResolvedValue({ id: 'share-1', url: 'https://share.test/1', skipped: 0 }),
  getShareWarnings: vi.fn(() => [] as string[]),
  exportProject: vi.fn().mockResolvedValue({ project: { name: 'Current Deck' }, cards: [{ uuid: 'c1' }] }),
  downloadBackup: vi.fn(),
  pickBackupFile: vi.fn().mockResolvedValue({ project: { name: 'Imported Deck' }, cards: [{ uuid: 'c1' }, { uuid: 'b1', linkedFrontId: 'c1' }] }),
  importProject: vi.fn().mockResolvedValue('imported-project'),
  listServerBackups: vi.fn().mockResolvedValue([{ projectId: 'server-1', projectName: 'Server Deck', cardCount: 2, sizeBytes: 2048, updatedAt: 0 }]),
  fetchServerBackup: vi.fn().mockResolvedValue({ project: { name: 'Server Deck' }, cards: [{ uuid: 'c1' }] }),
  rebalanceCardOrders: vi.fn().mockResolvedValue(undefined),
  liveQueryResult: [{ uuid: 'card-1', name: 'Lightning Bolt', projectId: 'p1', order: 1, imageId: 'img-1' }] as unknown[] | undefined,
  latestCards: [{ uuid: 'card-1', name: 'Lightning Bolt', projectId: 'p1', order: 1, imageId: 'img-1' }] as unknown[],
  cardsQueryCallbacks: [] as Array<() => Promise<unknown>>,
  shareSyncStatus: 'pending' as 'idle' | 'pending' | 'syncing' | 'error',
}));

vi.mock('@/store', () => ({
  useProjectStore: (selector: (state: typeof projectState) => unknown) => selector(projectState),
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
}));

vi.mock('@/store/toast', () => ({
  useToastStore: { getState: () => mocks },
}));

vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (query: () => Promise<unknown>) => {
    mocks.cardsQueryCallbacks.push(query);
    void query();
    return mocks.liveQueryResult;
  },
}));

vi.mock('@/db', () => ({
  db: {
    cards: { where: () => ({ equals: () => ({ sortBy: vi.fn(async () => mocks.latestCards) }) }) },
    projects: { update: vi.fn().mockResolvedValue(undefined) },
  },
}));

vi.mock('@/helpers/shareHelper', () => ({
  createShare: (...args: unknown[]) => mocks.createShare(...args),
  getShareWarnings: (...args: unknown[]) => mocks.getShareWarnings(...args),
}));

vi.mock('@/helpers/projectBackup', () => ({
  exportProject: (...args: unknown[]) => mocks.exportProject(...args),
  downloadBackup: (...args: unknown[]) => mocks.downloadBackup(...args),
  pickBackupFile: (...args: unknown[]) => mocks.pickBackupFile(...args),
  importProject: (...args: unknown[]) => mocks.importProject(...args),
  listServerBackups: (...args: unknown[]) => mocks.listServerBackups(...args),
  fetchServerBackup: (...args: unknown[]) => mocks.fetchServerBackup(...args),
}));

vi.mock('@/hooks/useShareSync', () => ({ useShareSync: () => ({ syncStatus: mocks.shareSyncStatus }) }));
vi.mock('@/helpers/debug', () => ({ debugLog: vi.fn() }));
vi.mock('../../helpers/dbUtils', () => ({
  sortCards: (cards: unknown[]) => cards,
  rebalanceCardOrders: (...args: unknown[]) => mocks.rebalanceCardOrders(...args),
}));

vi.mock('@/components/common', () => ({
  SelectDropdown: ({ buttonText, isOpen, onToggle, onClose, children }: { buttonText: string; isOpen: boolean; onToggle: () => void; onClose: () => void; children: React.ReactNode }) => (
    <div>
      <button onClick={onToggle}>{buttonText}</button>
      {isOpen && <div data-testid="project-menu"><button onClick={onClose}>close project menu</button>{children}</div>}
    </div>
  ),
}));

vi.mock('flowbite-react', () => ({
  Button: ({ children, onClick, disabled, color }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; color?: string }) => <button data-color={color} disabled={disabled} onClick={onClick}>{children}</button>,
  TextInput: ({ id, value, onChange, onKeyDown, placeholder }: { id: string; value: string; placeholder?: string; onChange: React.ChangeEventHandler<HTMLInputElement>; onKeyDown?: React.KeyboardEventHandler<HTMLInputElement> }) => <input id={id} value={value} placeholder={placeholder} onChange={onChange} onKeyDown={onKeyDown} />,
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => <label htmlFor={htmlFor}>{children}</label>,
  Modal: ({ show, onClose, children }: { show: boolean; onClose: () => void; children: React.ReactNode }) => show ? <div role="dialog"><button aria-label="modal-close" onClick={onClose}>×</button>{children}</div> : null,
  ModalHeader: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  ModalBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModalFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
}));

import { ProjectSelector } from './ProjectSelector';

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Current Deck' }));

describe('ProjectSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectState.projects = [
      { id: 'p1', name: 'Current Deck' },
      { id: 'p2', name: 'Side Deck' },
    ];
    projectState.currentProjectId = 'p1';
    projectState.createProject.mockResolvedValue('new-project');
    projectState.switchProject.mockResolvedValue(undefined);
    projectState.renameProject.mockResolvedValue(undefined);
    projectState.deleteProject.mockResolvedValue(undefined);
    mocks.liveQueryResult = [{ uuid: 'card-1', name: 'Lightning Bolt', projectId: 'p1', order: 1, imageId: 'img-1' }];
    mocks.latestCards = [{ uuid: 'card-1', name: 'Lightning Bolt', projectId: 'p1', order: 1, imageId: 'img-1' }];
    mocks.cardsQueryCallbacks = [];
    mocks.shareSyncStatus = 'pending';
    mocks.createShare.mockResolvedValue({ id: 'share-1', url: 'https://share.test/1', skipped: 0 });
    mocks.getShareWarnings.mockReturnValue([]);
    mocks.pickBackupFile.mockResolvedValue({ project: { name: 'Imported Deck' }, cards: [{ uuid: 'c1' }, { uuid: 'b1', linkedFrontId: 'c1' }] });
    mocks.listServerBackups.mockResolvedValue([{ projectId: 'server-1', projectName: 'Server Deck', cardCount: 2, sizeBytes: 2048, updatedAt: 0 }]);
    mocks.fetchServerBackup.mockResolvedValue({ project: { name: 'Server Deck' }, cards: [{ uuid: 'c1' }] });
    mocks.importProject.mockResolvedValue('imported-project');
    mocks.exportProject.mockResolvedValue({ project: { name: 'Current Deck' }, cards: [{ uuid: 'c1' }] });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

  it('covers query, same-project, empty-submit, and single-project guards', async () => {
    const first = render(<ProjectSelector />);
    expect(await mocks.cardsQueryCallbacks.at(-1)!()).toEqual(mocks.latestCards);
    openMenu();
    fireEvent.click(within(screen.getByTestId('project-menu')).getByText('Current Deck'));
    expect(projectState.switchProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('close project menu'));
    expect(screen.queryByTestId('project-menu')).toBeNull();

    openMenu();
    fireEvent.click(screen.getByText('Create New Project...'));
    fireEvent.keyDown(screen.getByLabelText('Project Name'), { key: 'Enter' });
    expect(projectState.createProject).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('Project Name'), { key: 'Escape' });
    fireEvent.click(screen.getByText('Cancel'));

    first.unmount();
    projectState.currentProjectId = null;
    projectState.projects = [{ id: 'only', name: 'Only Deck' }];
    mocks.liveQueryResult = undefined;
    const second = render(<ProjectSelector />);
    expect(await mocks.cardsQueryCallbacks.at(-1)!()).toEqual([]);
    second.unmount();

    projectState.currentProjectId = 'only';
    render(<ProjectSelector />);
    fireEvent.click(screen.getByText('Only Deck'));
    expect(screen.queryByTitle('Delete Project')).toBeNull();
    expect(screen.getByText('Share Project').closest('button')?.getAttribute('title')).toBe('No shareable cards');
  });

  it('switches projects and opens create/rename/delete flows', async () => {
    render(<ProjectSelector />);
    openMenu();

    fireEvent.click(screen.getByText('Side Deck'));
    expect(projectState.switchProject).toHaveBeenCalledWith('p2');

    openMenu();
    fireEvent.click(screen.getByText('Create New Project...'));
    fireEvent.change(screen.getByLabelText('Project Name'), { target: { value: 'New Deck' } });
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(projectState.createProject).toHaveBeenCalledWith('New Deck'));
    expect(projectState.switchProject).toHaveBeenCalledWith('new-project');

    openMenu();
    fireEvent.click(screen.getAllByTitle('Rename Project')[0]);
    fireEvent.change(screen.getByLabelText('New Name'), { target: { value: 'Renamed Deck' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(projectState.renameProject).toHaveBeenCalledWith('p1', 'Renamed Deck'));

    openMenu();
    fireEvent.click(screen.getAllByTitle('Delete Project')[0]);
    fireEvent.click(screen.getByText("Yes, I'm sure"));
    await waitFor(() => expect(projectState.deleteProject).toHaveBeenCalledWith('p1'));
  });

  it('sorts shared slots, reports skipped uploads, and handles share failures', async () => {
    mocks.getShareWarnings.mockReturnValue(['custom upload', 'missing image']);
    mocks.liveQueryResult = [
      { uuid: 'front', name: 'Front', order: 1 },
      { uuid: 'upload', name: 'Upload', order: 2, isUserUpload: true },
    ];
    mocks.latestCards = [
      { uuid: 'back', name: 'Back', order: 1, linkedFrontId: 'front' },
      { uuid: 'later', name: 'Later', order: 2 },
      { uuid: 'front', name: 'Front', order: 1 },
    ];
    mocks.createShare.mockResolvedValueOnce({ id: 'share-1', url: 'https://share.test/1', skipped: 1 });
    render(<ProjectSelector />);

    const shareButton = screen.getByText('Share Project').closest('button')!;
    expect(shareButton.getAttribute('title')).toBe('custom upload, missing image');
    fireEvent.click(shareButton);
    await waitFor(() => expect(mocks.createShare).toHaveBeenCalled());
    const sharedCards = mocks.createShare.mock.calls[0][0] as Array<{ uuid: string }>;
    expect(sharedCards.map((card) => card.uuid)).toEqual(['front', 'back', 'later']);
    expect(mocks.showCopyToast).toHaveBeenCalledWith(
      'Share link copied to clipboard! (1 custom upload excluded)'
    );

    mocks.createShare.mockResolvedValueOnce({ id: 'share-2', url: 'https://share.test/2', skipped: 2 });
    fireEvent.click(shareButton);
    await waitFor(() => expect(mocks.showCopyToast).toHaveBeenCalledWith(
      'Share link copied to clipboard! (2 custom uploads excluded)'
    ));

    mocks.createShare.mockRejectedValueOnce('share string failure');
    fireEvent.click(shareButton);
    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('Failed to create share'));

    mocks.latestCards = [];
    fireEvent.click(shareButton);
    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('No cards to share'));
  });

  it('renders every share synchronization status', () => {
    const { rerender } = render(<ProjectSelector />);
    expect(screen.getByTitle('Changes pending sync')).toBeDefined();

    mocks.shareSyncStatus = 'syncing';
    rerender(<ProjectSelector />);
    expect(screen.getByTitle('Syncing...')).toBeDefined();

    mocks.shareSyncStatus = 'error';
    rerender(<ProjectSelector />);
    expect(screen.getByTitle('Sync failed')).toBeDefined();

    mocks.shareSyncStatus = 'idle';
    rerender(<ProjectSelector />);
    expect(screen.queryByTitle('Sync failed')).toBeNull();
  });

  it('exports, imports, restores, and shares the current project', async () => {
    render(<ProjectSelector />);
    openMenu();
    fireEvent.click(screen.getByText('Export Project (JSON)'));
    await waitFor(() => expect(mocks.exportProject).toHaveBeenCalledWith('p1'));
    expect(mocks.downloadBackup).toHaveBeenCalled();
    expect(mocks.showSuccessToast).toHaveBeenCalledWith('Exported "Current Deck" (1 cards)');

    openMenu();
    fireEvent.click(screen.getByText('Import Project (JSON)...'));
    await waitFor(() => expect(mocks.importProject).toHaveBeenCalled());
    expect(projectState.switchProject).toHaveBeenCalledWith('imported-project');

    openMenu();
    fireEvent.click(screen.getByText('Restore from Server Backup...'));
    await waitFor(() => expect(screen.getByText('Server Deck')).toBeDefined());
    fireEvent.click(screen.getByText('Restore'));
    await waitFor(() => expect(mocks.fetchServerBackup).toHaveBeenCalledWith('server-1'));

    fireEvent.click(screen.getByText('Share Project'));
    await waitFor(() => expect(mocks.createShare).toHaveBeenCalled());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://share.test/1');
    expect(mocks.showCopyToast).toHaveBeenCalledWith('Share link copied to clipboard!');
  });

  it('handles export, import, restore, and rebalance failures with loading states', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.rebalanceCardOrders.mockRejectedValueOnce(new Error('rebalance failed'));
    let resolveBackups: (value: unknown[]) => void = () => undefined;
    mocks.listServerBackups.mockReturnValueOnce(new Promise((resolve) => { resolveBackups = resolve; }));
    mocks.exportProject.mockRejectedValueOnce('export string failure');
    mocks.pickBackupFile.mockResolvedValueOnce({ project: { name: 'Broken Import' }, cards: [] });
    mocks.importProject.mockRejectedValueOnce('import string failure');

    render(<ProjectSelector />);
    await waitFor(() => expect(consoleError).toHaveBeenCalled());

    openMenu();
    fireEvent.click(screen.getByText('Export Project (JSON)'));
    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('Export failed'));

    openMenu();
    fireEvent.click(screen.getByText('Import Project (JSON)...'));
    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('Import failed'));

    openMenu();
    fireEvent.click(screen.getByText('Restore from Server Backup...'));
    expect(screen.getByText('Loading backups...')).toBeDefined();
    resolveBackups([{ projectId: 'server-1', projectName: 'Server Deck', cardCount: 2, sizeBytes: 2048, updatedAt: 0 }]);
    await waitFor(() => expect(screen.getByText('Server Deck')).toBeDefined());

    let rejectRestore: (reason?: unknown) => void = () => undefined;
    mocks.fetchServerBackup.mockReturnValueOnce(new Promise((_, reject) => { rejectRestore = reject; }));
    fireEvent.click(screen.getByText('Restore'));
    expect(screen.getByRole('dialog').querySelector('button[disabled]')).not.toBeNull();
    rejectRestore('restore string failure');
    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('Restore failed'));
  });

  it('surfaces exact Error messages for every project action', async () => {
    mocks.exportProject.mockRejectedValueOnce(new Error('export exact'));
    mocks.pickBackupFile.mockResolvedValueOnce({ project: { name: 'Broken Import' }, cards: [] });
    mocks.importProject
      .mockRejectedValueOnce(new Error('import exact'))
      .mockRejectedValueOnce(new Error('restore exact'));
    mocks.fetchServerBackup.mockResolvedValueOnce({ project: { name: 'Server Deck' }, cards: [] });
    mocks.createShare.mockRejectedValueOnce(new Error('share exact'));

    render(<ProjectSelector />);

    openMenu();
    fireEvent.click(screen.getByText('Export Project (JSON)'));
    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('export exact'));

    openMenu();
    fireEvent.click(screen.getByText('Import Project (JSON)...'));
    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('import exact'));

    openMenu();
    fireEvent.click(screen.getByText('Restore from Server Backup...'));
    await waitFor(() => expect(screen.getByText('Server Deck')).toBeDefined());
    fireEvent.click(screen.getByText('Restore'));
    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('restore exact'));
    fireEvent.click(screen.getByLabelText('modal-close'));

    fireEvent.click(screen.getByText('Share Project'));
    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('share exact'));
  });

  it('handles empty and failing project actions', async () => {
    projectState.currentProjectId = null;
    projectState.projects = [];
    mocks.listServerBackups.mockRejectedValueOnce(new Error('network'));
    mocks.pickBackupFile.mockResolvedValueOnce(null);
    mocks.createShare.mockRejectedValueOnce(new Error('share failed'));

    render(<ProjectSelector />);
    expect(screen.getByText('Select Project')).toBeDefined();

    fireEvent.click(screen.getByText('Select Project'));
    expect((screen.getByText('Export Project (JSON)').closest('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Import Project (JSON)...'));
    await waitFor(() => expect(mocks.pickBackupFile).toHaveBeenCalled());
    expect(mocks.importProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Select Project'));
    fireEvent.click(screen.getByText('Restore from Server Backup...'));
    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('Failed to fetch server backups'));
    expect(screen.getByText('No server backups found.')).toBeDefined();

    fireEvent.click(screen.getByText('Share Project'));
    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('No cards to share'));
  });

  it('closes create, rename, and restore modals through their modal callbacks', async () => {
    render(<ProjectSelector />);

    openMenu();
    fireEvent.click(screen.getByText('Create New Project...'));
    fireEvent.click(screen.getByLabelText('modal-close'));
    expect(screen.queryByText('Create New Project')).toBeNull();

    openMenu();
    fireEvent.click(screen.getAllByTitle('Rename Project')[0]);
    fireEvent.click(screen.getByLabelText('modal-close'));
    expect(screen.queryByText('Rename Project')).toBeNull();

    openMenu();
    fireEvent.click(screen.getAllByTitle('Rename Project')[0]);
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Rename Project')).toBeNull();

    openMenu();
    fireEvent.click(screen.getByText('Restore from Server Backup...'));
    await waitFor(() => expect(screen.getByText('Server Deck')).toBeDefined());
    fireEvent.click(screen.getByLabelText('modal-close'));
    expect(screen.queryByText('Restore from Server Backup')).toBeNull();
  });

  it('submits create and rename modals with Enter and closes cancel-only dialogs', async () => {
    render(<ProjectSelector />);

    openMenu();
    fireEvent.click(screen.getByText('Create New Project...'));
    fireEvent.change(screen.getByLabelText('Project Name'), { target: { value: 'Keyboard Deck' } });
    fireEvent.keyDown(screen.getByLabelText('Project Name'), { key: 'Escape' });
    expect(projectState.createProject).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('Project Name'), { key: 'Enter' });
    await waitFor(() => expect(projectState.createProject).toHaveBeenCalledWith('Keyboard Deck'));

    openMenu();
    fireEvent.click(screen.getAllByTitle('Rename Project')[0]);
    fireEvent.change(screen.getByLabelText('New Name'), { target: { value: '' } });
    fireEvent.keyDown(screen.getByLabelText('New Name'), { key: 'Enter' });
    expect(projectState.renameProject).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('New Name'), { target: { value: 'Keyboard Rename' } });
    fireEvent.keyDown(screen.getByLabelText('New Name'), { key: 'Escape' });
    expect(projectState.renameProject).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('New Name'), { key: 'Enter' });
    await waitFor(() => expect(projectState.renameProject).toHaveBeenCalledWith('p1', 'Keyboard Rename'));

    openMenu();
    fireEvent.click(screen.getAllByTitle('Delete Project')[0]);
    fireEvent.click(screen.getByText('No, cancel'));
    expect(screen.queryByText('Confirm Delete Project')).toBeNull();

    openMenu();
    fireEvent.click(screen.getByText('Restore from Server Backup...'));
    await waitFor(() => expect(screen.getByText('Server Deck')).toBeDefined());
    fireEvent.click(screen.getByText('Close'));
    expect(screen.queryByText('Restore from Server Backup')).toBeNull();
  });
});
