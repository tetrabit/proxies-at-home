import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const options = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, '').split('=');
    return [key, value.join('=')];
  })
);

const preload = options.get('preload');
const userData = options.get('user-data');
const reportFile = options.get('report-file');
if (!preload || !userData || !reportFile) {
  throw new Error('preload compatibility harness requires --preload, --user-data, and --report-file');
}

const expectedMethods = [
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
].sort();

const consoleMessages = [];
let probeWindow;

function serializeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function writeReport(report) {
  mkdirSync(path.dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`PRELOAD_COMPATIBILITY_HARNESS_REPORT=${JSON.stringify(report)}`);
}

async function inspectBridge() {
  const bridgeJson = await probeWindow.webContents.executeJavaScript(`
    JSON.stringify({
      apiType: typeof window.electronAPI,
      keys: window.electronAPI ? Object.keys(window.electronAPI).sort() : [],
      functionTypes: window.electronAPI
        ? Object.fromEntries(Object.keys(window.electronAPI).map((key) => [key, typeof window.electronAPI[key]]))
        : {},
      rendererNodeGlobals: {
        process: typeof window.process,
        require: typeof window.require,
      },
    })
  `);
  const bridge = JSON.parse(bridgeJson);
  return {
    ...bridge,
    missingExpectedMethods: expectedMethods.filter((method) => !bridge.keys.includes(method)),
    unexpectedMethods: bridge.keys.filter((method) => !expectedMethods.includes(method)),
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function run() {
  ipcMain.handle('get-server-url', () => 'preload-probe://loopback');

  probeWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  probeWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    consoleMessages.push({ level, message, line, sourceId });
  });

  await probeWindow.loadURL('data:text/html;charset=utf-8,<title>preload compatibility probe</title>');
  const bridge = await inspectBridge();
  const exactAllowlist =
    JSON.stringify(bridge.keys) === JSON.stringify(expectedMethods) &&
    bridge.missingExpectedMethods.length === 0 &&
    bridge.unexpectedMethods.length === 0;
  const everyExpectedMethodIsFunction = expectedMethods.every(
    (method) => bridge.functionTypes[method] === 'function'
  );
  const noRendererNode =
    bridge.rendererNodeGlobals.process === 'undefined' &&
    bridge.rendererNodeGlobals.require === 'undefined';

  if (bridge.apiType !== 'object') {
    throw new Error(`preload bridge missing: window.electronAPI is ${bridge.apiType}`);
  }

  const serverUrl = await probeWindow.webContents.executeJavaScript('window.electronAPI.serverUrl()');
  await probeWindow.webContents.executeJavaScript(`
    window.__preloadCompatibilityEvents = [];
    window.__preloadCompatibilityDispose = window.electronAPI.onUpdateStatus((status, info) => {
      window.__preloadCompatibilityEvents.push({ status, info });
    });
    true;
  `);
  probeWindow.webContents.send('update-status', 'first', { version: 'probe' });
  await delay(75);
  const beforeDispose = JSON.parse(
    await probeWindow.webContents.executeJavaScript('JSON.stringify(window.__preloadCompatibilityEvents)')
  );
  await probeWindow.webContents.executeJavaScript('window.__preloadCompatibilityDispose(); true;');
  probeWindow.webContents.send('update-status', 'second', { version: 'must-not-deliver' });
  await delay(75);
  const afterDispose = JSON.parse(
    await probeWindow.webContents.executeJavaScript('JSON.stringify(window.__preloadCompatibilityEvents)')
  );
  const disposerWorked =
    beforeDispose.length === 1 &&
    beforeDispose[0]?.status === 'first' &&
    beforeDispose[0]?.info?.version === 'probe' &&
    afterDispose.length === 1;

  const passed =
    exactAllowlist &&
    everyExpectedMethodIsFunction &&
    noRendererNode &&
    serverUrl === 'preload-probe://loopback' &&
    disposerWorked;
  return {
    status: passed ? 'PASS' : 'FAIL',
    expectedMethods,
    bridge,
    checks: {
      exactAllowlist,
      everyExpectedMethodIsFunction,
      noRendererNode,
      serverUrlRoundTrip: serverUrl === 'preload-probe://loopback',
      disposerWorked,
    },
    serverUrl,
    beforeDispose,
    afterDispose,
  };
}

function finish(outcome) {
  if (probeWindow && !probeWindow.isDestroyed()) probeWindow.destroy();
  ipcMain.removeHandler('get-server-url');
  writeReport({
    schema: 'preload-compatibility-harness/v1',
    status: outcome.status,
    runtime: 'actual repository-installed Electron BrowserWindow; no Electron, preload, contextBridge, or ipcRenderer mocks',
    electronVersions: process.versions,
    browserPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload,
    },
    ...outcome,
    consoleMessages,
    windowDestroyed: probeWindow ? probeWindow.isDestroyed() : null,
  });
  app.exit(outcome.status === 'PASS' ? 0 : 1);
}

app.setPath('userData', userData);
app.whenReady()
  .then(run)
  .then(finish)
  .catch(async (error) => {
    const bridge = probeWindow && !probeWindow.isDestroyed() ? await inspectBridge().catch(() => null) : null;
    finish({
      status: 'FAIL',
      expectedMethods,
      bridge,
      failure: serializeError(error),
    });
  });
