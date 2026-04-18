import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { MpcPreferenceFixture } from '../shared/types.js';

const appMock = {
  getPath: vi.fn((name: string) => (name === 'userData' ? '/tmp/proxxied-user-data' : '/tmp')),
  isPackaged: false,
  whenReady: vi.fn(() => ({ then: vi.fn() })),
  on: vi.fn(),
  quit: vi.fn(),
  getVersion: vi.fn(() => '1.0.0'),
};

const ipcMainMock = { handle: vi.fn() };

vi.mock('electron', () => ({
  app: appMock,
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }

    webContents = {
      send: vi.fn(),
      openDevTools: vi.fn(),
    };

    loadURL = vi.fn();
    loadFile = vi.fn();
    on = vi.fn();
  },
  ipcMain: ipcMainMock,
  nativeTheme: { themeSource: 'system' },
  dialog: { showErrorBox: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(() => ({})), setApplicationMenu: vi.fn() },
  net: { fetch: vi.fn() },
}));

vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      logger: null,
      channel: 'latest',
      on: vi.fn(),
      checkForUpdatesAndNotify: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
    },
  },
}));

vi.mock('./microservice-manager.js', () => ({
  createScryfallMicroservice: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  MicroserviceManager: class {},
}));

const fixture: MpcPreferenceFixture = {
  version: 1,
  exportedAt: '2026-04-18T12:00:00.000Z',
  cases: [],
};

describe('electron MPC preference helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses userData for the preferences path', async () => {
    const { getMpcPreferencesPath } = await import('./main.ts');

    expect(getMpcPreferencesPath(appMock)).toBe(
      path.join('/tmp/proxxied-user-data', 'mpc-preferences.user.json')
    );
  });

  it('returns null when no preference file exists', async () => {
    const { loadMpcPreferencesFromDisk } = await import('./main.ts');
    const missingFile = path.join(os.tmpdir(), `missing-${Date.now()}.json`);

    await expect(loadMpcPreferencesFromDisk(missingFile)).resolves.toBeNull();
  });

  it('throws when the preference file contains malformed JSON', async () => {
    const { loadMpcPreferencesFromDisk } = await import('./main.ts');
    const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'electron-pref-invalid-'));
    const filePath = path.join(tempDirectory, 'mpc-preferences.user.json');
    await fs.promises.writeFile(filePath, '{bad json', 'utf8');

    await expect(loadMpcPreferencesFromDisk(filePath)).rejects.toThrow(
      '[Electron] Failed to load MPC preferences:'
    );

    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
  });

  it('writes pretty-printed JSON with a trailing newline', async () => {
    const { saveMpcPreferencesToDisk } = await import('./main.ts');
    const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'electron-pref-save-'));
    const filePath = path.join(tempDirectory, 'mpc-preferences.user.json');

    await saveMpcPreferencesToDisk(fixture, filePath);

    const payload = await fs.promises.readFile(filePath, 'utf8');
    expect(payload.endsWith('\n')).toBe(true);
    expect(JSON.parse(payload)).toEqual(fixture);

    await fs.promises.rm(tempDirectory, { recursive: true, force: true });
  });

  it('registers load and save IPC handlers', async () => {
    const { registerMpcPreferenceIpcHandlers } = await import('./main.ts');

    registerMpcPreferenceIpcHandlers(ipcMainMock, appMock);

    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      'mpc-preferences:load',
      expect.any(Function)
    );
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      'mpc-preferences:save',
      expect.any(Function)
    );
  });
});
