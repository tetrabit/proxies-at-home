import type { MpcPreferenceFixture } from './mpc-preferences.js';
import type { CalibrationHarnessIpcOperation, CalibrationHarnessIpcResult } from '../shared/calibrationHarnessIpc.js';

const { contextBridge, ipcRenderer } = require('electron');

type IpcRendererLike = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (...args: unknown[]) => void): void;
};

type PrivateApiBootstrap = {
  baseUrl: string;
  bearer: string;
};

// This must remain inline: Electron's sandboxed preload loader cannot resolve sibling modules.
function createElectronApi(renderer: IpcRendererLike) {
  const subscribe = (channel: 'update-status' | 'show-about', listener: (...args: unknown[]) => void) => {
    renderer.on(channel, listener);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      renderer.removeListener(channel, listener);
    };
  };
  return {
    serverUrl: () => renderer.invoke('get-server-url') as Promise<string>,
    getPrivateApiBootstrap: () =>
      renderer.invoke('get-private-api-bootstrap') as Promise<PrivateApiBootstrap>,
    calibrationHarnessExecute: (operation: CalibrationHarnessIpcOperation) =>
      renderer.invoke('calibration-harness:execute', operation) as Promise<CalibrationHarnessIpcResult>,
    loadMpcPreferences: () =>
      renderer.invoke('mpc-preferences:load') as Promise<MpcPreferenceFixture | null>,
    saveMpcPreferences: (fixture: MpcPreferenceFixture) =>
      renderer.invoke('mpc-preferences:save', fixture) as Promise<void>,
    getMicroserviceUrl: () =>
      renderer.invoke('get-microservice-url') as Promise<string>,
    getAppVersion: () => renderer.invoke('get-app-version') as Promise<string>,
    getUpdateChannel: () =>
      renderer.invoke('get-update-channel') as Promise<string>,
    setUpdateChannel: (channel: string) =>
      renderer.invoke('set-update-channel', channel) as Promise<boolean>,
    getAutoUpdateEnabled: () =>
      renderer.invoke('get-auto-update-enabled') as Promise<boolean>,
    setAutoUpdateEnabled: (enabled: boolean) =>
      renderer.invoke('set-auto-update-enabled', enabled) as Promise<boolean>,
    fetchMoxfieldDeck: (deckId: string) =>
      renderer.invoke('fetch-moxfield-deck', deckId),
    onUpdateStatus: (
      callback: (status: string, info?: unknown) => void
    ) => {
      return subscribe('update-status', (_event, status, info) =>
        callback(status as string, info)
      );
    },
    onShowAbout: (callback: () => void) => {
      return subscribe('show-about', () => callback());
    },
    checkForUpdates: () => renderer.invoke('check-for-updates') as Promise<void>,
    downloadUpdate: () => renderer.invoke('download-update') as Promise<void>,
    installUpdate: () => renderer.invoke('install-update') as Promise<void>,
  };
}

contextBridge.exposeInMainWorld('electronAPI', createElectronApi(ipcRenderer));
