import { beforeEach, describe, expect, it, vi } from 'vitest';

const exposeInMainWorld = vi.fn();
const ipcRenderer = { invoke: vi.fn(), on: vi.fn() };
const api = { serverUrl: vi.fn() };
const createElectronApi = vi.fn(() => api);

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer,
}));
vi.mock('./preload-api.js', () => ({ createElectronApi }));

describe('preload bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('exposes the Electron API in the isolated main world', async () => {
    await import('./preload.cts');

    expect(createElectronApi).toHaveBeenCalledWith(ipcRenderer);
    expect(exposeInMainWorld).toHaveBeenCalledWith('electronAPI', api);
  });
});
