import type { MpcPreferenceFixture } from '../shared/types.js';

type IpcRendererLike = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (...args: unknown[]) => void): void;
};

export function createElectronApi(ipcRenderer: IpcRendererLike) {
  return {
    serverUrl: () => ipcRenderer.invoke('get-server-url') as Promise<string>,
    loadMpcPreferences: () =>
      ipcRenderer.invoke('mpc-preferences:load') as Promise<MpcPreferenceFixture | null>,
    saveMpcPreferences: (fixture: MpcPreferenceFixture) =>
      ipcRenderer.invoke('mpc-preferences:save', fixture) as Promise<void>,
    getMicroserviceUrl: () =>
      ipcRenderer.invoke('get-microservice-url') as Promise<string>,
    getAppVersion: () => ipcRenderer.invoke('get-app-version') as Promise<string>,
    getUpdateChannel: () =>
      ipcRenderer.invoke('get-update-channel') as Promise<string>,
    setUpdateChannel: (channel: string) =>
      ipcRenderer.invoke('set-update-channel', channel) as Promise<boolean>,
    getAutoUpdateEnabled: () =>
      ipcRenderer.invoke('get-auto-update-enabled') as Promise<boolean>,
    setAutoUpdateEnabled: (enabled: boolean) =>
      ipcRenderer.invoke('set-auto-update-enabled', enabled) as Promise<boolean>,
    fetchMoxfieldDeck: (deckId: string) =>
      ipcRenderer.invoke('fetch-moxfield-deck', deckId),
    onUpdateStatus: (
      callback: (status: string, info?: unknown) => void
    ) => {
      ipcRenderer.on('update-status', (_event, status, info) =>
        callback(status as string, info)
      );
    },
    onShowAbout: (callback: () => void) => {
      ipcRenderer.on('show-about', () => callback());
    },
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates') as Promise<void>,
    downloadUpdate: () => ipcRenderer.invoke('download-update') as Promise<void>,
    installUpdate: () => ipcRenderer.invoke('install-update') as Promise<void>,
  };
}
