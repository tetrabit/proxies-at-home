import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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
  useLiveQuery: (query: () => unknown) => {
    void query();
    return [{ uuid: 'card-1', name: 'Lightning Bolt', projectId: 'p1', order: 1, imageId: 'img-1' }];
  },
}));

vi.mock('@/db', () => ({
  db: {
    cards: { where: () => ({ equals: () => ({ sortBy: vi.fn().mockResolvedValue([{ uuid: 'card-1', name: 'Lightning Bolt', projectId: 'p1', order: 1, imageId: 'img-1' }]) }) }) },
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

vi.mock('@/hooks/useShareSync', () => ({ useShareSync: () => ({ syncStatus: 'pending' }) }));
vi.mock('@/helpers/debug', () => ({ debugLog: vi.fn() }));
vi.mock('../../helpers/dbUtils', () => ({
  sortCards: (cards: unknown[]) => cards,
  rebalanceCardOrders: (...args: unknown[]) => mocks.rebalanceCardOrders(...args),
}));

vi.mock('@/components/common', () => ({
  SelectDropdown: ({ buttonText, isOpen, onToggle, children }: { buttonText: string; isOpen: boolean; onToggle: () => void; children: React.ReactNode }) => (
    <div>
      <button onClick={onToggle}>{buttonText}</button>
      {isOpen && <div data-testid="project-menu">{children}</div>}
    </div>
  ),
}));

vi.mock('flowbite-react', () => ({
  Button: ({ children, onClick, disabled, color }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; color?: string }) => <button data-color={color} disabled={disabled} onClick={onClick}>{children}</button>,
  TextInput: ({ id, value, onChange, onKeyDown, placeholder }: { id: string; value: string; placeholder?: string; onChange: React.ChangeEventHandler<HTMLInputElement>; onKeyDown?: React.KeyboardEventHandler<HTMLInputElement> }) => <input id={id} value={value} placeholder={placeholder} onChange={onChange} onKeyDown={onKeyDown} />,
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => <label htmlFor={htmlFor}>{children}</label>,
  Modal: ({ show, children }: { show: boolean; children: React.ReactNode }) => show ? <div role="dialog">{children}</div> : null,
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
    mocks.getShareWarnings.mockReturnValue([]);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
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
  });
});
