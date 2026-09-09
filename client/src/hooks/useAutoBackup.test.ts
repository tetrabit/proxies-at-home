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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function backupWithName(name: string): { project: { name: string }; cards: { linkedFrontId: null }[] } {
  return {
    project: { name },
    cards: [{ linkedFrontId: null }],
  };
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
    vi.stubGlobal('electronAPI', {
      getPrivateApiBootstrap: vi.fn().mockResolvedValue({
        baseUrl: 'http://127.0.0.1:4555',
        bearer: 'auto-backup-test-bearer',
      }),
    });
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

  it('runs one trailing backup with the newest revision after a change arrives during an active upload and minimum interval', async () => {
    let observedRevision: number | null = 1;
    mockUseLiveQuery.mockImplementation(() => observedRevision);

    const firstUpload = deferred<{ ok: boolean }>();
    mockExportProject
      .mockResolvedValueOnce(backupWithName('first revision'))
      .mockResolvedValueOnce(backupWithName('newest revision'));
    mockFetch.mockReturnValueOnce(firstUpload.promise).mockResolvedValue({ ok: true });

    const { rerender } = renderHook(() => useAutoBackup());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    observedRevision = 2;
    rerender();
    observedRevision = 3;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    await act(async () => {
      firstUpload.resolve({ ok: true });
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).projectName).toBe('newest revision');
  });

  it('cancels an interval-deferred trailing backup on unmount', async () => {
    currentProjectId = 'project-unmount';
    let observedRevision: number | null = 1;
    mockUseLiveQuery.mockImplementation(() => observedRevision);
    mockExportProject.mockResolvedValue(backupWithName('initial revision'));
    mockFetch.mockResolvedValue({ ok: true });

    const { rerender, unmount } = renderHook(() => useAutoBackup());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    observedRevision = 2;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('cancels an interval-deferred trailing backup on project switch', async () => {
    currentProjectId = 'project-switch-one';
    let observedRevision: number | null = 1;
    mockUseLiveQuery.mockImplementation(() => observedRevision);
    mockExportProject.mockResolvedValue(backupWithName('switch revision'));
    mockFetch.mockResolvedValue({ ok: true });

    const { rerender, unmount } = renderHook(() => useAutoBackup());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    observedRevision = 2;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    currentProjectId = 'project-switch-two';
    observedRevision = null;
    rerender();
    await act(async () => {
      await Promise.resolve();
    });
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not let a completed prior-project upload suppress the new project lifecycle', async () => {
    currentProjectId = 'project-active-switch-one';
    let observedRevision: number | null = 1;
    mockUseLiveQuery.mockImplementation(() => observedRevision);

    const firstUpload = deferred<{ ok: boolean }>();
    mockExportProject
      .mockResolvedValueOnce(backupWithName('shared revision'))
      .mockResolvedValueOnce(backupWithName('outgoing revision'))
      .mockResolvedValueOnce(backupWithName('shared revision'));
    mockFetch.mockReturnValueOnce(firstUpload.promise).mockResolvedValue({ ok: true });

    const { rerender } = renderHook(() => useAutoBackup());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    currentProjectId = 'project-active-switch-two';
    observedRevision = null;
    rerender();
    await act(async () => {
      await Promise.resolve();
      firstUpload.resolve({ ok: true });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('backs up a project directly', async () => {
    const projectId = 'project id';
    mockExportProject.mockResolvedValue({
      project: { name: 'Project 1' },
      cards: [{ linkedFrontId: null }],
    });
    mockFetch.mockResolvedValue({ ok: true });

    await expect(backupProject(projectId)).resolves.toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4555/api/backup/project%20id',
      expect.objectContaining({ method: 'PUT', credentials: 'omit', redirect: 'error' })
    );
    expect(new Headers(mockFetch.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer auto-backup-test-bearer'
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

  it('does not send an unauthenticated beacon on page unload', () => {
    const sendBeacon = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon });

    renderHook(() => useAutoBackup());

    window.dispatchEvent(new Event('beforeunload'));

    expect(sendBeacon).not.toHaveBeenCalled();
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
