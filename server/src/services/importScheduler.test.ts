import cron from 'node-cron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shouldImport = vi.fn();
const downloadAndImportBulkData = vi.fn();
const getLastImportTime = vi.fn();
const getCardCount = vi.fn();
const getDbSizeBytes = vi.fn();
const formatBytes = vi.fn();
const initCatalogs = vi.fn();
let scheduledCallback: (() => void) | undefined;

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((_expr: string, cb: () => void) => {
      scheduledCallback = cb;
      return { stop: vi.fn() };
    }),
  },
}));

vi.mock('./bulkDataService.js', () => ({
  shouldImport: () => shouldImport(),
  downloadAndImportBulkData: () => downloadAndImportBulkData(),
  getLastImportTime: () => getLastImportTime(),
}));

vi.mock('../db/proxxiedCardLookup.js', () => ({
  getCardCount: () => getCardCount(),
  getDbSizeBytes: () => getDbSizeBytes(),
  formatBytes: (bytes: number) => formatBytes(bytes),
}));

vi.mock('../utils/scryfallCatalog.js', () => ({
  initCatalogs: () => initCatalogs(),
}));

describe('import scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    shouldImport.mockReset();
    downloadAndImportBulkData.mockReset();
    getLastImportTime.mockReset().mockReturnValue('2026-01-01T00:00:00.000Z');
    getCardCount.mockReset().mockReturnValue(123);
    getDbSizeBytes.mockReset().mockReturnValue(2048);
    formatBytes.mockReset().mockReturnValue('2.0 KB');
    initCatalogs.mockReset().mockResolvedValue(undefined);
    scheduledCallback = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('logs current state and schedules without startup import when data is fresh', async () => {
    const { startImportScheduler } = await import('./importScheduler.js');
    shouldImport.mockReturnValue(false);

    startImportScheduler();

    expect(console.log).toHaveBeenCalledWith('[Scheduler] Starting import scheduler...');
    expect(console.log).toHaveBeenCalledWith('[Scheduler] Last import: 2026-01-01T00:00:00.000Z');
    expect(console.log).toHaveBeenCalledWith('[Scheduler] Cards in database: 123 (2.0 KB)');
    expect(console.log).toHaveBeenCalledWith('[Scheduler] Database is up to date. Next import: every Wednesday at 03:00 UTC');
    expect(cron.schedule).toHaveBeenCalledWith('0 3 * * 3', expect.any(Function), { timezone: 'UTC' });
    expect(downloadAndImportBulkData).not.toHaveBeenCalled();
  });

  it('runs startup and scheduled imports, refreshes catalogs, and skips overlapping runs', async () => {
    const { startImportScheduler } = await import('./importScheduler.js');
    shouldImport.mockReturnValue(true);
    downloadAndImportBulkData.mockResolvedValue({ cardsImported: 600, durationMs: 120_000 });

    startImportScheduler();
    expect(downloadAndImportBulkData).toHaveBeenCalledTimes(1);
    scheduledCallback?.();
    expect(console.log).toHaveBeenCalledWith('[Scheduler] Import already in progress. Skipping.');

    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(initCatalogs).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith('[Scheduler] Import complete: 600 cards in 2.0 minutes. DB size: 2.0 KB');

    scheduledCallback?.();
    expect(downloadAndImportBulkData).toHaveBeenCalledTimes(2);
  });

  it('retries failed imports with backoff and eventually logs final failure', async () => {
    const { startImportScheduler } = await import('./importScheduler.js');
    shouldImport.mockReturnValue(true);
    downloadAndImportBulkData.mockRejectedValue(new Error('network down'));

    startImportScheduler();
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(downloadAndImportBulkData).toHaveBeenCalledTimes(4);
    expect(console.warn).toHaveBeenCalledWith('[Scheduler] Import failed: network down. Retrying in 5 minutes...');
    expect(console.warn).toHaveBeenCalledWith('[Scheduler] Import failed: network down. Retrying in 30 minutes...');
    expect(console.warn).toHaveBeenCalledWith('[Scheduler] Import failed: network down. Retrying in 120 minutes...');
    expect(console.error).toHaveBeenCalledWith('[Scheduler] Import failed after 3 retries: network down');
  });
});
