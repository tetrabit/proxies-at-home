import Module from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const exposeInMainWorld = vi.fn();
const ipcRenderer = { invoke: vi.fn(), on: vi.fn() };
const api = { serverUrl: vi.fn() };
const createElectronApi = vi.fn(() => api);
const originalLoad = Module._load;

describe('preload bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    Module._load = ((request: string, parent: NodeJS.Module | null, isMain: boolean) => {
      if (request === 'electron') {
        return { contextBridge: { exposeInMainWorld }, ipcRenderer };
      }
      if (request === './preload-api.js') {
        return { createElectronApi };
      }
      return originalLoad(request, parent, isMain);
    }) as typeof Module._load;
  });

  afterEach(() => {
    Module._load = originalLoad;
  });

  it('exposes the Electron API in the isolated main world', async () => {
    await import('./preload.cts');

    expect(createElectronApi).toHaveBeenCalledWith(ipcRenderer);
    expect(exposeInMainWorld).toHaveBeenCalledWith('electronAPI', api);
  });
});
