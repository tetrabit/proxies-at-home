import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MpcPreferenceFixture } from '@/types';
import {
  electronPreferenceSyncTarget,
  isElectronPreferenceSyncAvailable,
} from './electronPreferenceSyncTarget';

const fixture: MpcPreferenceFixture = {
  version: 1,
  exportedAt: '2026-04-18T12:00:00.000Z',
  cases: [],
};

describe('electronPreferenceSyncTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.electronAPI;
  });

  it('reports availability when the required Electron APIs exist', () => {
    window.electronAPI = {
      serverUrl: vi.fn(),
      getAppVersion: vi.fn(),
      getUpdateChannel: vi.fn(),
      setUpdateChannel: vi.fn(),
      getAutoUpdateEnabled: vi.fn(),
      setAutoUpdateEnabled: vi.fn(),
      onUpdateStatus: vi.fn(),
      onShowAbout: vi.fn(),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      installUpdate: vi.fn(),
      loadMpcPreferences: vi.fn(),
      saveMpcPreferences: vi.fn(),
    };

    expect(isElectronPreferenceSyncAvailable()).toBe(true);
  });

  it('loads preferences through the Electron bridge', async () => {
    const loadMpcPreferences = vi.fn().mockResolvedValue(fixture);
    window.electronAPI = {
      serverUrl: vi.fn(),
      getAppVersion: vi.fn(),
      getUpdateChannel: vi.fn(),
      setUpdateChannel: vi.fn(),
      getAutoUpdateEnabled: vi.fn(),
      setAutoUpdateEnabled: vi.fn(),
      onUpdateStatus: vi.fn(),
      onShowAbout: vi.fn(),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      installUpdate: vi.fn(),
      loadMpcPreferences,
      saveMpcPreferences: vi.fn(),
    };

    await expect(electronPreferenceSyncTarget.load()).resolves.toEqual(fixture);
  });

  it('writes preferences through the Electron bridge', async () => {
    const saveMpcPreferences = vi.fn().mockResolvedValue(undefined);
    window.electronAPI = {
      serverUrl: vi.fn(),
      getAppVersion: vi.fn(),
      getUpdateChannel: vi.fn(),
      setUpdateChannel: vi.fn(),
      getAutoUpdateEnabled: vi.fn(),
      setAutoUpdateEnabled: vi.fn(),
      onUpdateStatus: vi.fn(),
      onShowAbout: vi.fn(),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      installUpdate: vi.fn(),
      loadMpcPreferences: vi.fn(),
      saveMpcPreferences,
    };

    await expect(electronPreferenceSyncTarget.write(fixture)).resolves.toBeUndefined();
    expect(saveMpcPreferences).toHaveBeenCalledWith(fixture);
  });

  it('throws clearly when Electron APIs are unavailable', async () => {
    await expect(electronPreferenceSyncTarget.load()).rejects.toThrow(
      'Electron MPC preference sync is unavailable'
    );
  });

  it('describes the Electron target', () => {
    expect(electronPreferenceSyncTarget.describe()).toBe('Electron');
  });
});
