import { readFileSync } from 'node:fs';
import Module from 'module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const exposeInMainWorld = vi.fn();
const ipcRenderer = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
const originalLoad = Module._load;
const preloadPath = fileURLToPath(new URL('./preload.cts', import.meta.url));
const expectedMethods = [
  'calibrationHarnessExecute',
  'checkForUpdates',
  'downloadUpdate',
  'fetchMoxfieldDeck',
  'getAppVersion',
  'getAutoUpdateEnabled',
  'getMicroserviceUrl',
  'getPrivateApiBootstrap',
  'getUpdateChannel',
  'installUpdate',
  'loadMpcPreferences',
  'onShowAbout',
  'onUpdateStatus',
  'saveMpcPreferences',
  'serverUrl',
  'setAutoUpdateEnabled',
  'setUpdateChannel',
];

function loadPreloadSource() {
  const output = ts.transpileModule(readFileSync(preloadPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: preloadPath,
  }).outputText;
  const preloadModule = new Module(preloadPath) as unknown as {
    filename: string;
    paths: string[];
    _compile(source: string, filename: string): void;
  };
  preloadModule.filename = preloadPath;
  preloadModule._compile(output, preloadPath);
}

describe('preload bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Module._load = ((request: string, parent: NodeJS.Module | null, isMain: boolean) => {
      if (request === 'electron') {
        return { contextBridge: { exposeInMainWorld }, ipcRenderer };
      }
      if (request === './preload-api.js') {
        throw new Error('sandboxed preload must not load the split preload API helper');
      }
      return originalLoad(request, parent, isMain);
    }) as typeof Module._load;
  });

  afterEach(() => {
    Module._load = originalLoad;
  });

  it('exposes the exact Electron API without loading the split helper', () => {
    loadPreloadSource();

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(exposeInMainWorld.mock.calls[0][0]).toBe('electronAPI');
    expect(Object.keys(exposeInMainWorld.mock.calls[0][1]).sort()).toEqual(expectedMethods);
  });
});
