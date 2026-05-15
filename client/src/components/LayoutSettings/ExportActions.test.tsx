import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  setLoadingTask: vi.fn(),
  setLoadingMessage: vi.fn(),
  setProgress: vi.fn(),
  setOnCancel: vi.fn(),
  buildDecklist: vi.fn(() => 'deck text'),
  downloadDecklist: vi.fn(),
  downloadMpcXml: vi.fn(),
  exportProxyPagesToPdf: vi.fn().mockResolvedValue(undefined),
  ExportImagesZip: vi.fn().mockResolvedValue(undefined),
  ExportImagesIndividual: vi.fn().mockResolvedValue(undefined),
  serializePdfSettingsForWorker: vi.fn(() => ({ columns: 3, rows: 3 })),
  addToast: vi.fn(),
  setExportMode: vi.fn((mode: string) => { mocks.exportMode = mode; }),
  exportMode: 'fronts',
  decklistSortAlpha: false,
  defaultCardbackId: 'cardback-mpc',
  pageSizeUnit: 'in',
  pageWidth: 8.5,
  pageHeight: 11,
  dpi: 300,
  columns: 3,
  settingsState: {
    useCustomBackOffset: false,
    cardBackPositionX: 0,
    cardBackPositionY: 0,
    printerCalibrationEnabled: false,
    printerCalibrationProfileId: undefined as string | undefined,
    defaultCardbackId: 'cardback-mpc',
  },
  filteredAndSortedCards: [] as Array<Record<string, unknown>>,
  dbCardsToArray: vi.fn(),
  dbImagesToArray: vi.fn(),
  dbCardbacksToArray: vi.fn(),
  dbCardsGet: vi.fn(),
  dbCardsBulkGet: vi.fn(),
  dbCardbacksGet: vi.fn(),
  clipboardWriteText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/store/loading', () => ({
  useLoadingStore: (selector: (state: { setLoadingTask: typeof mocks.setLoadingTask; setLoadingMessage: typeof mocks.setLoadingMessage; setProgress: typeof mocks.setProgress; setOnCancel: typeof mocks.setOnCancel }) => unknown) => selector({
    setLoadingTask: mocks.setLoadingTask,
    setLoadingMessage: mocks.setLoadingMessage,
    setProgress: mocks.setProgress,
    setOnCancel: mocks.setOnCancel,
  }),
}));

vi.mock('@/store/settings', () => ({
  useSettingsStore: Object.assign(
    vi.fn((selector: (state: Record<string, unknown>) => unknown) => selector({
      pageSizeUnit: mocks.pageSizeUnit,
      pageWidth: mocks.pageWidth,
      pageHeight: mocks.pageHeight,
      dpi: mocks.dpi,
      columns: mocks.columns,
      exportMode: mocks.exportMode,
      setExportMode: mocks.setExportMode,
      decklistSortAlpha: mocks.decklistSortAlpha,
    })),
    { getState: () => ({ ...mocks.settingsState, defaultCardbackId: mocks.defaultCardbackId }) }
  ),
}));

vi.mock('@/store/selection', () => ({
  useSelectionStore: { getState: () => ({ flippedCards: new Set(['front-2']) }) },
}));

vi.mock('@/store/toast', () => ({
  useToastStore: { getState: () => ({ addToast: mocks.addToast }) },
}));

vi.mock('@/hooks/useFilteredAndSortedCards', () => ({
  useFilteredAndSortedCards: () => ({ filteredAndSortedCards: mocks.filteredAndSortedCards }),
}));

vi.mock('../../db', () => ({
  db: {
    cards: {
      toArray: () => mocks.dbCardsToArray(),
      get: (id: string) => mocks.dbCardsGet(id),
      bulkGet: (ids: string[]) => mocks.dbCardsBulkGet(ids),
    },
    images: { toArray: () => mocks.dbImagesToArray() },
    cardbacks: {
      toArray: () => mocks.dbCardbacksToArray(),
      get: (id: string) => mocks.dbCardbacksGet(id),
    },
  },
}));

vi.mock('@/helpers/decklistHelper', () => ({
  buildDecklist: (...args: unknown[]) => mocks.buildDecklist(...args),
  downloadDecklist: (...args: unknown[]) => mocks.downloadDecklist(...args),
}));

vi.mock('@/helpers/mpcXmlExport', () => ({
  downloadMpcXml: (...args: unknown[]) => mocks.downloadMpcXml(...args),
}));

vi.mock('@/helpers/exportProxyPageToPdf', () => ({
  exportProxyPagesToPdf: (...args: unknown[]) => mocks.exportProxyPagesToPdf(...args),
}));

vi.mock('@/helpers/exportImagesZip', () => ({
  ExportImagesZip: (...args: unknown[]) => mocks.ExportImagesZip(...args),
  ExportImagesIndividual: (...args: unknown[]) => mocks.ExportImagesIndividual(...args),
}));

vi.mock('@/helpers/serializeSettingsForWorker', () => ({
  serializePdfSettingsForWorker: () => mocks.serializePdfSettingsForWorker(),
}));

vi.mock('@/helpers/mpcAutofillApi', () => ({
  extractMpcIdentifierFromImageId: (value: string) => value.includes('mpc') ? 'mpc-back-id' : null,
}));

vi.mock('@/helpers/imageSourceUtils', () => ({
  inferImageSource: (value?: string) => value?.includes('mpc') ? 'mpc' : undefined,
}));

vi.mock('@/helpers/backBleedSettings', () => ({
  applyInheritedCardbackTargetBleed: (_front: unknown, back: unknown) => back,
  normalizeSharedCardbackTargetBleed: (cards: unknown[]) => cards,
}));

vi.mock('@/helpers/exportPageLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/helpers/exportPageLimit')>();
  return actual;
});

vi.mock('@/helpers/duplexCollation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/helpers/duplexCollation')>();
  return actual;
});

vi.mock('@/helpers/printerCalibrationApi', () => ({
  applyCalibration: vi.fn(async (blob: Blob) => blob),
}));

vi.mock('../common', () => ({
  AutoTooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  NumberInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  SplitButton: ({ label, sublabel, disabled, onClick, isOpen, onToggle, options, onSelect }: { label: string; sublabel?: string; disabled?: boolean; onClick: () => void; isOpen: boolean; onToggle: () => void; options: Array<{ value: string; label: string }>; onSelect: (value: string) => void }) => (
    <div>
      <button disabled={disabled} onClick={onClick}>{label}</button>
      <span>{sublabel}</span>
      <button onClick={onToggle}>{label} modes</button>
      {isOpen ? options.map((option) => <button key={`${label}-${option.value}`} onClick={() => onSelect(option.value)}>{label}: {option.label}</button>) : null}
    </div>
  ),
}));

vi.mock('flowbite-react', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props}>{children}</label>,
}));

import { ExportActions } from './ExportActions';

const front1 = { uuid: 'front-1', name: 'Island', quantity: 1, imageId: 'img-1', linkedBackId: 'back-1' };
const front2 = { uuid: 'front-2', name: 'Forest', quantity: 1, imageId: 'img-2', linkedBackId: 'back-2' };
const linkedBack = { uuid: 'back-1', name: 'Island Back', imageId: 'back-img', linkedFrontId: 'front-1' };
const hiddenBack = { uuid: 'back-2', name: 'Forest Back', imageId: 'back-img-2', linkedFrontId: 'front-2' };

function renderExport(cards = [front1, front2]) {
  mocks.filteredAndSortedCards = cards;
  return render(<ExportActions cards={cards as never[]} />);
}

describe('ExportActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exportMode = 'fronts';
    mocks.decklistSortAlpha = false;
    mocks.defaultCardbackId = 'cardback-mpc';
    mocks.filteredAndSortedCards = [front1, front2];
    mocks.dbCardsToArray.mockResolvedValue([front1, front2, linkedBack, hiddenBack]);
    mocks.dbImagesToArray.mockResolvedValue([{ id: 'img-1' }, { id: 'img-2' }]);
    mocks.dbCardbacksToArray.mockResolvedValue([{ id: 'cardback-mpc', sourceUrl: 'https://mpcfill.com/back' }]);
    mocks.dbCardsGet.mockImplementation(async (id: string) => ({ 'back-1': linkedBack, 'back-2': hiddenBack }[id]));
    mocks.dbCardsBulkGet.mockResolvedValue([hiddenBack]);
    mocks.dbCardbacksGet.mockResolvedValue({ id: 'cardback-mpc', sourceUrl: 'https://mpcfill.com/back' });
    mocks.exportProxyPagesToPdf.mockResolvedValue(undefined);
    mocks.ExportImagesZip.mockResolvedValue(undefined);
    mocks.ExportImagesIndividual.mockResolvedValue(undefined);
    mocks.clipboardWriteText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: mocks.clipboardWriteText }, configurable: true });
  });

  it('copies decklists with MPC IDs by default and can switch to basic copy mode', async () => {
    renderExport();

    fireEvent.click(screen.getByText('Copy Decklist'));
    await waitFor(() => expect(mocks.clipboardWriteText).toHaveBeenCalledWith('deck text'));
    expect(mocks.buildDecklist).toHaveBeenCalledWith([front1, front2], { style: 'withMpc', sort: 'none' });
    expect(mocks.addToast).toHaveBeenCalledWith({ message: 'Copied Decklist!', type: 'success', dismissible: true });

    fireEvent.click(screen.getByText('Copy Decklist modes'));
    fireEvent.click(screen.getByText('Copy Decklist: Basic'));
    fireEvent.click(screen.getByText('Copy Decklist'));
    await waitFor(() => expect(mocks.buildDecklist).toHaveBeenLastCalledWith([front1, front2], { style: 'withSetNum', sort: 'none' }));
  });

  it('downloads basic, MPC, and XML decklists including missing linked backs and default MPC back id', async () => {
    renderExport();

    fireEvent.click(screen.getByText('Download Decklist'));
    await waitFor(() => expect(mocks.downloadDecklist).toHaveBeenCalled());
    expect(mocks.downloadDecklist.mock.calls[0][0]).toMatch(/^decklist_mpc_\d{4}-\d{2}-\d{2}\.txt$/);

    fireEvent.click(screen.getByText('Download Decklist modes'));
    fireEvent.click(screen.getByText('Download Decklist: Basic (.txt)'));
    fireEvent.click(screen.getByText('Download Decklist'));
    await waitFor(() => expect(mocks.downloadDecklist.mock.calls.at(-1)?.[0]).toMatch(/^decklist_\d{4}-\d{2}-\d{2}\.txt$/));

    fireEvent.click(screen.getByText('Download Decklist: MPC Autofill (.xml)'));
    fireEvent.click(screen.getByText('Download Decklist'));
    await waitFor(() => expect(mocks.downloadMpcXml).toHaveBeenCalled());
    expect(mocks.dbCardsBulkGet).toHaveBeenCalledWith(['back-1', 'back-2']);
    expect(mocks.downloadMpcXml.mock.calls[0][0]).toEqual([front1, front2, hiddenBack]);
    expect(mocks.downloadMpcXml.mock.calls[0][2]).toBe('mpc-back-id');
  });

  it('exports ZIP and individual card images with merged image/cardback sources', async () => {
    renderExport();

    fireEvent.click(screen.getByText('Export Card Images'));
    await waitFor(() => expect(mocks.ExportImagesZip).toHaveBeenCalledWith({
      cards: [front1, front2, linkedBack, hiddenBack],
      images: [{ id: 'img-1' }, { id: 'img-2' }, { id: 'cardback-mpc', sourceUrl: 'https://mpcfill.com/back' }],
    }));
    expect(mocks.setLoadingTask).toHaveBeenNthCalledWith(1, 'Exporting ZIP');
    expect(mocks.setLoadingTask).toHaveBeenLastCalledWith(null);

    fireEvent.click(screen.getByText('Export Card Images modes'));
    fireEvent.click(screen.getByText('Export Card Images: Individual Files'));
    fireEvent.click(screen.getByText('Export Card Images'));
    await waitFor(() => expect(mocks.ExportImagesIndividual).toHaveBeenCalled());
  });

  it('exports front PDFs with page limit normalization and error modal handling', async () => {
    renderExport();

    const pageLimit = screen.getByLabelText('PDF pages');
    fireEvent.change(pageLimit, { target: { value: ' 2.8 ' } });
    fireEvent.blur(pageLimit);
    expect((pageLimit as HTMLInputElement).value).toBe('2');

    fireEvent.click(screen.getByText('Export to PDF'));
    await waitFor(() => expect(mocks.exportProxyPagesToPdf).toHaveBeenCalled());
    expect(mocks.setLoadingTask).toHaveBeenCalledWith('Generating PDF');
    expect(mocks.exportProxyPagesToPdf.mock.calls[0][0]).toMatchObject({
      cards: [front1, front2],
      pagesPerPdf: expect.any(Number),
      maxPages: 2,
      filenameSuffix: '_fronts',
    });
    expect(mocks.setOnCancel).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.setOnCancel).toHaveBeenLastCalledWith(null);

    mocks.exportProxyPagesToPdf.mockRejectedValueOnce(new Error('pdf failed'));
    fireEvent.click(screen.getByText('Export to PDF'));
    expect(await screen.findByText('PDF Export Failed')).toBeDefined();
    expect(screen.getByText('pdf failed')).toBeDefined();
  });

  it('disables export actions when no front cards are available', () => {
    renderExport([{ uuid: 'back-only', linkedFrontId: 'front', name: 'Back' }]);

    expect((screen.getByText('Export to PDF') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Export Card Images') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Copy Decklist') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Download Decklist') as HTMLButtonElement).disabled).toBe(true);
  });
});
