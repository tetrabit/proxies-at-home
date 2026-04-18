import type { MpcPreferenceFixture, PreferenceSyncTarget } from '@/types';

function getElectronPreferenceApi() {
  return window.electronAPI?.loadMpcPreferences &&
    window.electronAPI?.saveMpcPreferences
    ? window.electronAPI
    : null;
}

export function isElectronPreferenceSyncAvailable(): boolean {
  return getElectronPreferenceApi() !== null;
}

function requireElectronPreferenceApi() {
  const electronApi = getElectronPreferenceApi();

  if (!electronApi) {
    throw new Error('Electron MPC preference sync is unavailable');
  }

  return electronApi;
}

export const electronPreferenceSyncTarget: PreferenceSyncTarget = {
  async load(): Promise<MpcPreferenceFixture | null> {
    return requireElectronPreferenceApi().loadMpcPreferences();
  },

  async write(fixture: MpcPreferenceFixture): Promise<void> {
    await requireElectronPreferenceApi().saveMpcPreferences(fixture);
  },

  describe(): string {
    return 'Electron';
  },
};
