import 'fake-indexeddb/auto';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db';
import { useAutoBackup } from './useAutoBackup';

const mockFetch = vi.hoisted(() => vi.fn());
const mockUseProjectStore = vi.hoisted(() => vi.fn());
let currentProjectId = 'project-observation';

vi.mock('@/constants', () => ({
  API_BASE: 'http://example.test',
}));

vi.mock('@/store', () => ({
  useProjectStore: mockUseProjectStore,
}));

vi.mock('@/helpers/debug', () => ({
  debugLog: vi.fn(),
}));

const customHash = 'a'.repeat(64);

async function flushSubscription(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 3; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.resolve();
    }
  });
}

async function seedProject(): Promise<void> {
  await db.projects.add({
    id: currentProjectId,
    name: 'Observation project',
    createdAt: 1,
    lastOpenedAt: 1,
    cardCount: 1,
    settings: {},
  } as never);
  await db.cards.add({
    uuid: 'custom-card',
    projectId: currentProjectId,
    name: 'Custom card',
    order: 0,
    isUserUpload: true,
    imageId: customHash,
  } as never);
  await db.user_images.add({
    hash: customHash,
    type: 'image/png',
    data: new Blob(['one'], { type: 'image/png' }),
    createdAt: 1,
  });
}

describe('useAutoBackup Dexie observation', () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    await db.delete();
    await db.open();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(new Date('2026-09-08T00:00:00.000Z'));
    currentProjectId = 'project-observation';
    mockUseProjectStore.mockImplementation((selector) => selector({ currentProjectId }));
    mockFetch.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.delete();
  });

  it('observes a same-size custom Blob replacement, defers export work through bursts, and suppresses an unchanged admitted upload', async () => {
    await seedProject();

    let fileReaderCalls = 0;
    let exportedImageData = 'one';
    class CountingFileReader {
      result: string | null = null;
      onloadend: (() => unknown) | null = null;
      onerror: (() => unknown) | null = null;

      readAsDataURL(blob: Blob): void {
        fileReaderCalls++;
        this.result = `data:${blob.type};base64,${btoa(exportedImageData)}`;
        this.onloadend?.();
      }
    }
    vi.stubGlobal('FileReader', CountingFileReader);

    renderHook(() => useAutoBackup());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushSubscription();

    await act(async () => {
      await vi.advanceTimersToNextTimerAsync();
    });
    await flushSubscription();
    expect(fileReaderCalls).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    exportedImageData = 'two';
    await db.user_images.put({
      hash: customHash,
      type: 'image/png',
      data: new Blob(['two'], { type: 'image/png' }),
      createdAt: 1,
    });
    exportedImageData = 'tre';
    await db.user_images.put({
      hash: customHash,
      type: 'image/png',
      data: new Blob(['tre'], { type: 'image/png' }),
      createdAt: 1,
    });
    await flushSubscription();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(fileReaderCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(fileReaderCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await flushSubscription();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(fileReaderCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(60_000);
    await db.user_images.put({
      hash: customHash,
      type: 'image/png',
      data: new Blob(['tre'], { type: 'image/png' }),
      createdAt: 1,
    });
    await flushSubscription();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await flushSubscription();
    expect(fileReaderCalls).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
