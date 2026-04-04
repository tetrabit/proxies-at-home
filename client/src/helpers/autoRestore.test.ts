/**
 * Tests for autoRestore — server backup recovery on empty IndexedDB
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock sessionStorage
const mockSessionStorage = new Map<string, string>();
vi.stubGlobal('sessionStorage', {
  getItem: (key: string) => mockSessionStorage.get(key) ?? null,
  setItem: (key: string, value: string) => mockSessionStorage.set(key, value),
  removeItem: (key: string) => mockSessionStorage.delete(key),
  clear: () => mockSessionStorage.clear(),
});

// Mock db
const mockProjectCount = vi.fn();
vi.mock('@/db', () => ({
  db: {
    projects: {
      count: () => mockProjectCount(),
    },
  },
}));

// Mock projectBackup helpers
const mockListBackups = vi.fn();
const mockFetchBackup = vi.fn();
const mockImportProject = vi.fn();
vi.mock('@/helpers/projectBackup', () => ({
  listServerBackups: () => mockListBackups(),
  fetchServerBackup: (id: string) => mockFetchBackup(id),
  importProject: (backup: unknown, name?: string) => mockImportProject(backup, name),
  validateBackup: (data: unknown) => data,
}));

// Mock debugLog
vi.mock('@/helpers/debug', () => ({
  debugLog: vi.fn(),
}));

import { autoRestore } from './autoRestore';

describe('autoRestore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionStorage.clear();
  });

  it('returns null if sessionStorage flag is already set', async () => {
    mockSessionStorage.set('proxxied_auto_restore_done', 'has_data');

    const result = await autoRestore();
    expect(result).toBeNull();
    expect(mockProjectCount).not.toHaveBeenCalled();
  });

  it('returns null if IndexedDB already has projects', async () => {
    mockProjectCount.mockResolvedValue(3);

    const result = await autoRestore();
    expect(result).toBeNull();
    expect(mockListBackups).not.toHaveBeenCalled();
    expect(mockSessionStorage.get('proxxied_auto_restore_done')).toBe('has_data');
  });

  it('returns null if server is unreachable', async () => {
    mockProjectCount.mockResolvedValue(0);
    mockListBackups.mockRejectedValue(new Error('Network error'));

    const result = await autoRestore();
    expect(result).toBeNull();
    expect(mockSessionStorage.get('proxxied_auto_restore_done')).toBe('server_unreachable');
  });

  it('returns null if server has no backups', async () => {
    mockProjectCount.mockResolvedValue(0);
    mockListBackups.mockResolvedValue([]);

    const result = await autoRestore();
    expect(result).toBeNull();
    expect(mockSessionStorage.get('proxxied_auto_restore_done')).toBe('no_backups');
  });

  it('restores all backups from server when IndexedDB is empty', async () => {
    mockProjectCount.mockResolvedValue(0);
    mockListBackups.mockResolvedValue([
      {
        projectId: 'proj-1',
        projectName: 'Kamryn',
        cardCount: 10,
        updatedAt: 2000,
        createdAt: 1000,
        sizeBytes: 500,
      },
      {
        projectId: 'proj-2',
        projectName: 'Test Deck',
        cardCount: 5,
        updatedAt: 3000,
        createdAt: 1500,
        sizeBytes: 300,
      },
    ]);

    const fakeBackup1 = {
      version: 1,
      app: 'proxxied',
      exportedAt: '2026-01-01',
      project: { name: 'Kamryn', createdAt: 1000, settings: {} },
      cards: [],
      userImages: [],
    };
    const fakeBackup2 = {
      version: 1,
      app: 'proxxied',
      exportedAt: '2026-01-02',
      project: { name: 'Test Deck', createdAt: 1500, settings: {} },
      cards: [],
      userImages: [],
    };

    mockFetchBackup.mockImplementation((id: string) => {
      if (id === 'proj-1') return Promise.resolve(fakeBackup1);
      if (id === 'proj-2') return Promise.resolve(fakeBackup2);
      return Promise.reject(new Error('not found'));
    });

    mockImportProject
      .mockResolvedValueOnce('new-id-2') // proj-2 (sorted first, updatedAt=3000)
      .mockResolvedValueOnce('new-id-1'); // proj-1 (sorted second, updatedAt=2000)

    const result = await autoRestore();

    expect(result).not.toBeNull();
    expect(result!.restoredCount).toBe(2);
    expect(result!.projectIds).toEqual(['new-id-2', 'new-id-1']);
    expect(result!.projectNames).toEqual(['Test Deck', 'Kamryn']);
    expect(mockSessionStorage.get('proxxied_auto_restore_done')).toBe('restored_2');
  });

  it('continues restoring when one backup fails', async () => {
    mockProjectCount.mockResolvedValue(0);
    mockListBackups.mockResolvedValue([
      {
        projectId: 'proj-ok',
        projectName: 'Good',
        cardCount: 5,
        updatedAt: 2000,
        createdAt: 1000,
        sizeBytes: 200,
      },
      {
        projectId: 'proj-bad',
        projectName: 'Broken',
        cardCount: 3,
        updatedAt: 1000,
        createdAt: 500,
        sizeBytes: 100,
      },
    ]);

    const goodBackup = {
      version: 1,
      app: 'proxxied',
      exportedAt: '2026-01-01',
      project: { name: 'Good', createdAt: 1000, settings: {} },
      cards: [],
      userImages: [],
    };

    mockFetchBackup.mockImplementation((id: string) => {
      if (id === 'proj-ok') return Promise.resolve(goodBackup);
      return Promise.reject(new Error('corrupt data'));
    });

    mockImportProject.mockResolvedValueOnce('new-good-id');

    const result = await autoRestore();

    expect(result).not.toBeNull();
    expect(result!.restoredCount).toBe(1);
    expect(result!.projectIds).toEqual(['new-good-id']);
    expect(result!.projectNames).toEqual(['Good']);
  });
});
