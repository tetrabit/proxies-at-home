import 'fake-indexeddb/auto';
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db';
import { backupProject, useAutoBackup } from './useAutoBackup';

const mockExportProject = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());
const mockUseLiveQuery = vi.hoisted(() => vi.fn());
const mockUseProjectStore = vi.hoisted(() => vi.fn());
let currentProjectId = 'project-1';

vi.mock('@/helpers/projectBackup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/helpers/projectBackup')>()),
  exportProject: mockExportProject,
}));

vi.mock('@/constants', () => ({
  API_BASE: 'http://example.test',
}));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: mockUseLiveQuery,
}));

vi.mock('@/store', () => ({
  useProjectStore: mockUseProjectStore,
}));

vi.mock('@/helpers/debug', () => ({
  debugLog: vi.fn(),
}));

const customHash = 'a'.repeat(64);

async function seedProject(projectId: string, settings: Record<string, unknown> = {}): Promise<void> {
  await db.projects.add({
    id: projectId,
    name: 'Project 1',
    createdAt: 1,
    lastOpenedAt: 1,
    cardCount: 1,
    settings,
  } as never);
}

describe('useAutoBackup', () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    await db.delete();
    await db.open();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    currentProjectId = 'project-1';
    mockUseProjectStore.mockImplementation((selector) => selector({ currentProjectId }));
    mockUseLiveQuery.mockReturnValue(null);
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.delete();
  });

  it('does no export or base64 work for native card and image bursts before the admitted debounce, then exports once', async () => {
    currentProjectId = 'project-native';
    await seedProject(currentProjectId, { paperSize: 'letter', bleed: 'on' });
    await db.cards.add({
      uuid: 'front-1',
      projectId: currentProjectId,
      name: 'Front card',
      order: 0,
      isUserUpload: true,
      imageId: customHash,
      linkedBackId: 'back-1',
    } as never);
    await db.user_images.add({
      hash: customHash,
      type: 'image/png',
      data: new Blob(['artwork-one'], { type: 'image/png' }),
      createdAt: 1,
    });

    const { exportProject: actualExportProject } = await vi.importActual<
      typeof import('@/helpers/projectBackup')
    >('@/helpers/projectBackup');
    mockExportProject.mockImplementation(actualExportProject);
    mockFetch.mockResolvedValue({ ok: true });

    let base64Reads = 0;
    class CountingFileReader {
      result: string | null = null;
      onloadend: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(): void {
        base64Reads++;
        this.result = 'data:image/png;base64,YXJ0d29yay10d28=';
        this.onloadend?.();
      }
    }
    vi.stubGlobal('FileReader', CountingFileReader);

    let liveQueryCallback: (() => Promise<string | null>) | undefined;
    let liveQueryResult: string | null = null;
    mockUseLiveQuery.mockImplementation((callback: () => Promise<string | null>) => {
      liveQueryCallback = callback;
      return liveQueryResult;
    });

    const { rerender } = renderHook(() => useAutoBackup());
    liveQueryResult = await liveQueryCallback!();
    rerender();

    await db.cards.update('front-1', {
      order: 1,
      overrides: { brightness: 12 },
      linkedBackId: undefined,
    } as never);
    await db.cards.update('front-1', { imageId: customHash } as never);
    await db.user_images.put({
      hash: customHash,
      type: 'image/png',
      data: new Blob(['artwork-two'], { type: 'image/png' }),
      createdAt: 2,
    });
    liveQueryResult = await liveQueryCallback!();
    rerender();

    expect(mockExportProject).not.toHaveBeenCalled();
    expect(base64Reads).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(mockExportProject).not.toHaveBeenCalled();
    expect(base64Reads).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.resolve();
    });
    expect(mockExportProject).toHaveBeenCalledTimes(1);
    expect(base64Reads).toBe(1);
  });

  it('backs up a project directly', async () => {
    mockExportProject.mockResolvedValue({
      project: { name: 'Project 1' },
      cards: [{ linkedFrontId: null }],
    });
    mockFetch.mockResolvedValue({ ok: true });

    await expect(backupProject('project-1')).resolves.toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://example.test/api/backup/project-1',
      expect.objectContaining({ method: 'PUT' })
    );
  });

  it('returns true without sending when the backup has no main cards', async () => {
    mockExportProject.mockResolvedValue({
      project: { name: 'Project 1' },
      cards: [{ linkedFrontId: 'back-1' }],
    });

    await expect(backupProject('project-1')).resolves.toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns false when the server rejects the backup', async () => {
    mockExportProject.mockResolvedValue({
      project: { name: 'Project 1' },
      cards: [{ linkedFrontId: null }],
    });
    mockFetch.mockResolvedValue({ ok: false });

    await expect(backupProject('project-1')).resolves.toBe(false);
  });

  it('backs up projects during the periodic sweep', async () => {
    currentProjectId = 'project-sweep';
    await seedProject(currentProjectId);
    await seedProject('project-empty');
    await db.cards.add({
      uuid: 'sweep-card',
      projectId: currentProjectId,
      name: 'Sweep card',
      order: 0,
      isUserUpload: false,
    } as never);
    mockExportProject.mockResolvedValue({
      project: { name: 'Sweep Project' },
      cards: [{ linkedFrontId: null }],
    });
    mockFetch.mockResolvedValue({ ok: true });

    renderHook(() => useAutoBackup());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.resolve();
    });

    expect(mockExportProject).toHaveBeenCalledWith('project-sweep');
    expect(mockExportProject).not.toHaveBeenCalledWith('project-empty');
  });

  it('sends a beacon on page unload when a project is active', () => {
    const sendBeacon = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon });

    renderHook(() => useAutoBackup());

    window.dispatchEvent(new Event('beforeunload'));

    expect(sendBeacon).toHaveBeenCalledWith(
      'http://example.test/api/backup/project-1',
      expect.any(Blob)
    );
  });

  it('skips the scheduled backup when the last backup was too recent', async () => {
    mockExportProject.mockResolvedValue({
      project: { name: 'Project 1' },
      cards: [{ linkedFrontId: null }],
    });
    mockFetch.mockResolvedValue({ ok: true });

    await backupProject('project-1');

    renderHook(() => useAutoBackup());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(mockExportProject).toHaveBeenCalledTimes(1);
  });
});
