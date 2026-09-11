import { app, BrowserWindow, ipcMain } from 'electron';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createPreloadIpcFixture } from './fixtures/preload-ipc-fixture.mjs';

const options = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...value] = argument.replace(/^--/, '').split('=');
  return [key, value.join('=')];
}));
const required = ['preload', 'ipc', 'user-data', 'fixture-dir', 'report-file'];
for (const key of required) if (!options.get(key)) throw new Error(`private preload harness requires --${key}`);
const preload = options.get('preload'); const ipcPath = options.get('ipc'); const userData = options.get('user-data'); const fixtureDir = options.get('fixture-dir'); const reportFile = options.get('report-file');
const expectedMethods = ['calibrationHarnessExecute', 'checkForUpdates', 'downloadUpdate', 'fetchMoxfieldDeck', 'getAppVersion', 'getAutoUpdateEnabled', 'getMicroserviceUrl', 'getPrivateApiBootstrap', 'getUpdateChannel', 'installUpdate', 'loadMpcPreferences', 'onShowAbout', 'onUpdateStatus', 'saveMpcPreferences', 'serverUrl', 'setAutoUpdateEnabled', 'setUpdateChannel'].sort();
const firstSnapshot = Object.freeze({ version: 1, datasets: [], cases: [], assets: [], runs: [] });
const secondSnapshot = Object.freeze({ ...firstSnapshot, smokeMarker: 'current-snapshot' });
const binary = new Uint8Array([0, 1, 2, 3, 127, 255]);
const binaryHash = createHash('sha256').update(binary).digest('hex');
const credential = `calibration_pair_${'A'.repeat(43)}`;
const harnessId = 'private-native-harness';
let mainWindow; let fixture; let disposeRegistrar; let configPathCalls = 0; const windows = new Set(); const consoleMessages = [];

const serializeError = (error) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
const exact = (actual, expected, label) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} mismatch`); };
const canonicalJson = (value) => JSON.stringify(value, (_key, entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map((name) => [name, entry[name]])) : entry);
async function requireExistingControlledDirectory(directory, label) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be an existing non-symlink directory`);
  return path.resolve(directory);
}
const ipc = async (window, operationSource) => window.webContents.executeJavaScript(`window.electronAPI.calibrationHarnessExecute(${operationSource})`);
const errorCode = async (window, operationSource, code, status) => {
  const result = await ipc(window, operationSource);
  if (result?.ok !== false || result.error?.code !== code || (status !== undefined && result.error?.status !== status)) throw new Error(`expected ${code}${status === undefined ? '' : `/${status}`} IPC error`);
  return result;
};

function ownedWindow() {
  const window = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  windows.add(window);
  window.once('closed', () => windows.delete(window));
  return window;
}

async function inspectBridge(window) {
  return JSON.parse(await window.webContents.executeJavaScript(`JSON.stringify({
    apiType: typeof window.electronAPI,
    keys: window.electronAPI ? Object.keys(window.electronAPI).sort() : [],
    types: window.electronAPI ? Object.fromEntries(Object.keys(window.electronAPI).map((key) => [key, typeof window.electronAPI[key]])) : {},
    rendererNode: { process: typeof window.process, require: typeof window.require }
  })`));
}

async function procIdentity(pid) {
  const [status, stat] = await Promise.all([readFile(`/proc/${pid}/status`, 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8')]);
  const field = (name) => status.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1] ?? null;
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { pid, pgid: Number(fields[2]), sid: Number(fields[3]), startTime: fields[19] ?? null, uid: field('Uid')?.split(/\s+/)[0] ?? null, gid: field('Gid')?.split(/\s+/)[0] ?? null, seccomp: field('Seccomp'), noNewPrivs: field('NoNewPrivs') };
}

async function listenerBarrier(window) {
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => resolve(true)))');
}

async function run() {
  const controlledFixtureDir = await requireExistingControlledDirectory(fixtureDir, 'fixture directory');
  const controlledReportParent = await requireExistingControlledDirectory(path.dirname(reportFile), 'report parent');
  if (controlledFixtureDir !== controlledReportParent || path.dirname(path.resolve(reportFile)) !== controlledFixtureDir) throw new Error('fixture and report paths must use the same allocated controlled directory');
  const trustedDocument = path.join(fixtureDir, 'trusted.html'); const navigatedDocument = path.join(fixtureDir, 'navigated.html'); const frameDocument = path.join(fixtureDir, 'frame.html');
  await Promise.all([
    writeFile(trustedDocument, '<!doctype html><title>trusted</title><iframe src="frame.html"></iframe>'),
    writeFile(navigatedDocument, '<!doctype html><title>navigated</title>'),
    writeFile(frameDocument, '<!doctype html><title>frame</title>'),
  ]);
  const trustedUrl = pathToFileURL(trustedDocument).href; const navigatedUrl = pathToFileURL(navigatedDocument).href;
  const module = await import(pathToFileURL(ipcPath).href);
  const register = module.registerCalibrationHarnessIpcHandlers ?? module.default?.registerCalibrationHarnessIpcHandlers;
  if (typeof register !== 'function') throw new Error('emitted registrar export is unavailable');
  ipcMain.handle('get-server-url', () => 'legacy-ephemeral://local-bootstrap');
  mainWindow = ownedWindow();
  mainWindow.webContents.on('console-message', (_event, level, message) => consoleMessages.push({ level, message }));
  await mainWindow.loadURL(trustedUrl);
  const configPath = path.join(userData, 'calibration-harness.connection.json');
  disposeRegistrar = register({ ipcMain, getMainWebContents: () => mainWindow?.webContents ?? null, expectedRendererUrl: () => trustedUrl, configPath: () => { configPathCalls += 1; return configPath; } });
  const bridge = await inspectBridge(mainWindow);
  exact(bridge.keys, expectedMethods, 'exact 17-method bridge allowlist');
  if (Object.values(bridge.types).some((type) => type !== 'function') || bridge.rendererNode.process !== 'undefined' || bridge.rendererNode.require !== 'undefined') throw new Error('renderer bridge function or Node exposure invariant failed');
  if (await mainWindow.webContents.executeJavaScript('window.electronAPI.serverUrl()') !== 'legacy-ephemeral://local-bootstrap') throw new Error('legacy local bootstrap API did not round trip');
  await mainWindow.webContents.executeJavaScript('window.__events=[]; window.__delivered=new Promise(resolve=>window.__eventDelivered=resolve); window.__dispose=window.electronAPI.onUpdateStatus(status=>{window.__events.push(status);window.__eventDelivered(status)}); true;');
  mainWindow.webContents.send('update-status', 'first');
  if (await mainWindow.webContents.executeJavaScript('window.__delivered') !== 'first') throw new Error('listener delivered-event barrier failed');
  await mainWindow.webContents.executeJavaScript('window.__dispose(); true;');
  mainWindow.webContents.send('update-status', 'second'); await listenerBarrier(mainWindow);
  exact(JSON.parse(await mainWindow.webContents.executeJavaScript('JSON.stringify(window.__events)')), ['first'], 'legacy listener disposal');
  const missingConfig = await errorCode(mainWindow, '{kind:"getSession"}', 'not-configured');
  fixture = createPreloadIpcFixture({ credential, harnessId }); const origin = await fixture.start();
  await writeFile(configPath, JSON.stringify({ version: 1, backendOrigin: origin, credential, harnessId })); await chmod(configPath, 0o600);
  const foreign = ownedWindow(); await foreign.loadURL(trustedUrl); const beforeForeignRequests = fixture.requests.length; const beforeForeignConfig = configPathCalls;
  await errorCode(foreign, '{kind:"getSession"}', 'invalid-operation'); foreign.destroy();
  if (fixture.requests.length !== beforeForeignRequests || configPathCalls !== beforeForeignConfig) throw new Error('foreign window reached config loader or network fixture');
  await mainWindow.loadURL(navigatedUrl); const beforeNavigatedRequests = fixture.requests.length; const beforeNavigatedConfig = configPathCalls;
  await errorCode(mainWindow, '{kind:"getSession"}', 'invalid-operation');
  if (fixture.requests.length !== beforeNavigatedRequests || configPathCalls !== beforeNavigatedConfig) throw new Error('navigated top document reached config loader or network fixture');
  await mainWindow.loadURL(trustedUrl);
  const frame = mainWindow.webContents.mainFrame.frames.find((candidate) => candidate !== mainWindow.webContents.mainFrame);
  if (!frame || await frame.executeJavaScript('typeof window.electronAPI') !== 'undefined') throw new Error('observed subframe bridge must be absent');
  fixture.forceOnce('/session', 401); await errorCode(mainWindow, '{kind:"getSession"}', 'http', 401);
  const session = await ipc(mainWindow, '{kind:"getSession"}'); if (!session.ok || session.value.ownerId !== 'owned-synthetic') throw new Error('getSession did not traverse real IPC');
  fixture.forceOnce('/snapshot', 404); await errorCode(mainWindow, '{kind:"getSnapshot"}', 'http', 404);
  fixture.forceOnce('/snapshot', 412); await errorCode(mainWindow, '{kind:"publishSnapshot",snapshot:{version:1,datasets:[],cases:[],assets:[],runs:[]},expectedRevision:null}', 'http', 412);
  const created = await ipc(mainWindow, '{kind:"publishSnapshot",snapshot:{version:1,datasets:[],cases:[],assets:[],runs:[]},expectedRevision:null}'); if (!created.ok || created.value.revision !== 1) throw new Error('create-only snapshot publish failed');
  const current = await ipc(mainWindow, '{kind:"getSnapshot"}'); if (!current.ok || canonicalJson(current.value.snapshot) !== canonicalJson(firstSnapshot)) throw new Error('current snapshot did not retain submitted bytes');
  await errorCode(mainWindow, '{kind:"publishSnapshot",snapshot:{version:1,datasets:[],cases:[],assets:[],runs:[]},expectedRevision:null}', 'http', 412);
  const cas = await ipc(mainWindow, '{kind:"publishSnapshot",snapshot:{version:1,datasets:[],cases:[],assets:[],runs:[],smokeMarker:"current-snapshot"},expectedRevision:1}'); if (!cas.ok || cas.value.revision !== 2 || canonicalJson(cas.value.snapshot) !== canonicalJson(secondSnapshot)) throw new Error('current snapshot CAS failed');
  await errorCode(mainWindow, '{kind:"publishSnapshot",snapshot:{version:1,datasets:[],cases:[],assets:[],runs:[]},expectedRevision:1}', 'http', 412);
  const preserved = await ipc(mainWindow, '{kind:"getSnapshot"}'); if (!preserved.ok || preserved.value.revision !== 2 || canonicalJson(preserved.value.snapshot) !== canonicalJson(secondSnapshot)) throw new Error('stale snapshot CAS changed current state');
  const put = await ipc(mainWindow, `{kind:"putBlob",sha256:"${binaryHash}",bytes:new Uint8Array([0,1,2,3,127,255])}`); if (!put.ok || put.value.byteLength !== binary.byteLength || put.value.inserted !== true) throw new Error('putBlob failed');
  fixture.forceOnce(`/blobs/${binaryHash}`, 503); await errorCode(mainWindow, `{kind:"getBlob",sha256:"${binaryHash}"}`, 'http', 503);
  const got = await ipc(mainWindow, `{kind:"getBlob",sha256:"${binaryHash}"}`); if (!got.ok || JSON.stringify(Array.from(got.value)) !== JSON.stringify(Array.from(binary))) throw new Error('getBlob exact bytes failed');
  const missing = await ipc(mainWindow, `{kind:"missingBlobs",hashes:["${binaryHash}","${'b'.repeat(64)}"]}`); if (!missing.ok || JSON.stringify(missing.value.missing) !== JSON.stringify(['b'.repeat(64)])) throw new Error('missingBlobs failed');
  const beforeMalformed = fixture.requests.length; await errorCode(mainWindow, '{kind:"getSession",extra:true}', 'invalid-operation'); if (fixture.requests.length !== beforeMalformed) throw new Error('malformed operation reached network fixture');
  const deferred = fixture.deferNextSnapshot();
  deferred.closed.catch(() => {});
  void mainWindow.webContents.executeJavaScript('window.electronAPI.calibrationHarnessExecute({kind:"getSnapshot"}).then(()=>undefined,()=>undefined)').catch(() => undefined);
  await deferred.started;
  const beforeNavigation = deferred.observation();
  if (!beforeNavigation.requestEnded || beforeNavigation.responseClosed || beforeNavigation.socketClosed || beforeNavigation.writableEnded) throw new Error('deferred response was not observed open after normal request completion');
  await mainWindow.loadURL(navigatedUrl);
  const cancelled = await deferred.closed; fixture.releaseDeferred();
  if ((!cancelled.responseClosed && !cancelled.socketClosed) || cancelled.writableEnded) throw new Error('navigation did not terminate the deferred response transport');
  await mainWindow.loadURL(trustedUrl);
  const renderer = await procIdentity(mainWindow.webContents.getOSProcessId());
  const main = await procIdentity(process.pid);
  if (renderer.seccomp !== '2' || renderer.noNewPrivs !== '1' || renderer.uid === '0' || renderer.gid === '0' || main.uid === '0' || main.gid === '0') throw new Error('actual trusted renderer sandbox/non-root main identity failed');
  const rendererData = JSON.stringify({ bridge, session, current, created, cas, put, got: Array.from(got.value), missing, missingConfig, consoleMessages });
  if (rendererData.includes(credential) || rendererData.includes(origin) || rendererData.includes(configPath)) throw new Error('private config values leaked into renderer evidence');
  const expectedErrorStatuses = [401, 404, 412, 503];
  const actualErrorStatuses = fixture.requests.map((entry) => entry.status).filter((entry) => typeof entry === 'number' && entry >= 400);
  if (!expectedErrorStatuses.every((status) => actualErrorStatuses.includes(status)) || !fixture.requests.every((entry) => entry.authorizationValid) || !fixture.requests.some((entry) => entry.precondition === '*') || !fixture.requests.some((entry) => entry.precondition === '"1"')) throw new Error('required fixture transport coverage missing');
  return { status: 'PASS', bridge: { exactAllowlist: true, methods: expectedMethods, rendererNode: bridge.rendererNode, legacyListenerDisposed: true }, ipc: { sixOperations: true, binaryExactBytes: true, snapshotCas: true, faithfulCreateCurrentStale: true, missingConfigTyped: missingConfig.error.code === 'not-configured', malformedZeroNetwork: true, errorStatuses: actualErrorStatuses.filter((status) => expectedErrorStatuses.includes(status)) }, trust: { foreignWindowRejected: true, navigatedTopDocumentRejected: true, subframeBridgeAbsent: true, pendingResponseNavigationCancelled: true, registrarDisposedIdempotently: true }, sandbox: { browserWindow: { show: false, sandbox: true, contextIsolation: true, nodeIntegration: false }, renderer, launchArgv: process.argv.slice(1).filter((argument) => !argument.includes(credential) && !argument.includes(origin)) }, processes: { main, renderer }, fixture: { loopbackOnly: true, requestCount: fixture.requests.length, requests: fixture.requests }, privateRendererDataLeakFree: true };
}

async function finish(outcome) {
  const cleanupFailures = [];
  let registrarDrained = false;
  try { if (disposeRegistrar) { await disposeRegistrar(); await disposeRegistrar(); registrarDrained = true; } } catch (error) { cleanupFailures.push(`registrar: ${serializeError(error)}`); }
  for (const window of [...windows]) { try { if (!window.isDestroyed()) window.destroy(); } catch (error) { cleanupFailures.push(`window: ${serializeError(error)}`); } }
  try { if (fixture) await fixture.close(); } catch (error) { cleanupFailures.push(`fixture: ${serializeError(error)}`); }
  try { ipcMain.removeHandler('get-server-url'); } catch (error) { cleanupFailures.push(`legacy handler: ${serializeError(error)}`); }
  try { await requireExistingControlledDirectory(path.dirname(reportFile), 'report parent'); } catch (error) { cleanupFailures.push(`report parent: ${serializeError(error)}`); }
  const final = { schema: 'td-06d5fb-private-preload-ipc-harness/v2', ...outcome, trust: { ...outcome.trust, registrarDrained }, status: cleanupFailures.length === 0 && outcome.status === 'PASS' ? 'PASS' : 'FAIL', cleanup: { verified: cleanupFailures.length === 0 && windows.size === 0 && registrarDrained, failures: cleanupFailures, openWindows: windows.size, fixtureClosed: fixture !== undefined, registrarDrained } };
  await writeFile(reportFile, `${JSON.stringify(final, null, 2)}\n`);
  app.exit(final.status === 'PASS' ? 0 : 2);
}

app.setPath('userData', userData); app.on('window-all-closed', () => {});
app.whenReady().then(run).then(finish).catch((error) => finish({ status: 'FAIL', failure: serializeError(error), fixture: { requestCount: fixture?.requests.length ?? 0, requests: fixture?.requests ?? [] } }));
