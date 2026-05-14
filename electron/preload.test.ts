import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElectronApi } from './preload-api';

describe('preload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes MPC preference IPC helpers on electronAPI', async () => {
    const invoke = vi.fn();
    const on = vi.fn();
    const exposedApi = createElectronApi({ invoke, on }) as {
      loadMpcPreferences: () => Promise<unknown>;
      saveMpcPreferences: (fixture: unknown) => Promise<unknown>;
    };
    const fixture = { version: 1, exportedAt: '2026-04-18T12:00:00.000Z', cases: [] };

    await exposedApi.loadMpcPreferences();
    await exposedApi.saveMpcPreferences(fixture);

    expect(invoke).toHaveBeenNthCalledWith(1, 'mpc-preferences:load');
    expect(invoke).toHaveBeenNthCalledWith(2, 'mpc-preferences:save', fixture);
  });

  it('routes every exposed bridge method to the expected IPC channel', async () => {
    const invoke = vi.fn(async () => undefined);
    const on = vi.fn();
    const api = createElectronApi({ invoke, on });

    await api.serverUrl();
    await api.getMicroserviceUrl();
    await api.getAppVersion();
    await api.getUpdateChannel();
    await api.setUpdateChannel('stable');
    await api.getAutoUpdateEnabled();
    await api.setAutoUpdateEnabled(false);
    await api.fetchMoxfieldDeck('deck-1');
    await api.checkForUpdates();
    await api.downloadUpdate();
    await api.installUpdate();

    expect(invoke.mock.calls).toEqual([
      ['get-server-url'],
      ['get-microservice-url'],
      ['get-app-version'],
      ['get-update-channel'],
      ['set-update-channel', 'stable'],
      ['get-auto-update-enabled'],
      ['set-auto-update-enabled', false],
      ['fetch-moxfield-deck', 'deck-1'],
      ['check-for-updates'],
      ['download-update'],
      ['install-update'],
    ]);
  });

  it('subscribes update and about callbacks through ipcRenderer.on', () => {
    const invoke = vi.fn();
    const on = vi.fn();
    const api = createElectronApi({ invoke, on });
    const updateCallback = vi.fn();
    const aboutCallback = vi.fn();

    api.onUpdateStatus(updateCallback);
    api.onShowAbout(aboutCallback);

    on.mock.calls[0][1]({}, 'downloaded', { version: '1.0.0' });
    on.mock.calls[1][1]();

    expect(on.mock.calls.map(([channel]) => channel)).toEqual(['update-status', 'show-about']);
    expect(updateCallback).toHaveBeenCalledWith('downloaded', { version: '1.0.0' });
    expect(aboutCallback).toHaveBeenCalledOnce();
  });
});
