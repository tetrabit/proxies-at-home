const { app, BrowserWindow, ipcMain, session } = await import('electron');
const API_ROOT = '/api/calibration-harness';
import { chmod, copyFile, lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixtureIndex = process.argv.indexOf(fileURLToPath(import.meta.url));
if (fixtureIndex < 1) throw new Error('Q3 Electron fixture entrypoint missing');
const fixtureArguments = process.argv.slice(fixtureIndex + 1);
const options = new Map(fixtureArguments.map(argument => {
  const match = /^--([a-z-]+)=(.+)$/.exec(argument);
  if (match === null) throw new Error('Q3 Electron fixture requires exact path options');
  return [match[1], match[2]];
}));
const required = ['web-origin', 'backend-origin', 'connection-file', 'preload', 'ipc', 'browser-bundle', 'report-file'];
if (fixtureArguments.length !== required.length || options.size !== required.length || required.some(key => !options.has(key))) throw new Error('Q3 Electron fixture requires exact path options');
const webOrigin = options.get('web-origin');
const backendOrigin = options.get('backend-origin');
if (webOrigin !== 'http://127.0.0.1:5173' || backendOrigin !== 'http://127.0.0.1:3001') throw new Error('Q3 Electron fixture requires canonical loopback endpoints');
for (const key of ['connection-file', 'preload', 'ipc', 'browser-bundle', 'report-file']) if (!path.isAbsolute(options.get(key))) throw new Error('Q3 Electron fixture requires absolute paths');

const sourceConnection = options.get('connection-file');
const preload = options.get('preload');
const ipcPath = options.get('ipc');
const browserBundle = options.get('browser-bundle');
const reportFile = options.get('report-file');
const userData = app.getPath('userData');
const installedConnection = path.join(userData, 'calibration-harness.connection.json');
const requests = [];
let windowRef;
let dispose;

function privateFile(value) {
  return typeof value === 'string' && path.isAbsolute(value);
}

function redact(value) {
  return String(value).replace(/calibration_pair_[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 300);
}

async function processIdentity(pid) {
  const [statusText, statText] = await Promise.all([readFile(`/proc/${pid}/status`, 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8')]);
  const field = name => statusText.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1] ?? null;
  return { uid: field('Uid')?.split(/\s+/)[0] ?? null, seccomp: field('Seccomp'), noNewPrivs: field('NoNewPrivs') };
}

function bounded(promise, timeoutMs, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); })]).finally(() => clearTimeout(timer));
}

function readOnlyBrokerRequest(parsed, method) {
  return parsed.origin === backendOrigin && parsed.search === '' && method === 'GET'
    && (parsed.pathname === `${API_ROOT}/session` || parsed.pathname === `${API_ROOT}/snapshot`
      || new RegExp(`^${API_ROOT}/blobs/[0-9a-f]{64}$`).test(parsed.pathname));
}

function installRendererNetworkPolicy() {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let parsed;
    try { parsed = new URL(details.url); } catch { callback({ cancel: true }); return; }
    // Vite/static assets remain available; every API route is denied in the renderer before transmission.
    callback({ cancel: parsed.origin !== webOrigin || parsed.pathname.startsWith('/api/') });
  });
}

function installBrokerNetworkPolicy() {
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== 'function') throw new Error('Q3 Electron fixture requires fetch');
  globalThis.fetch = async (input, init = {}) => {
    const parsed = new URL(typeof input === 'string' ? input : input.url);
    const method = String(init.method ?? 'GET').toUpperCase();
    if (!readOnlyBrokerRequest(parsed, method)) throw new Error('broker network policy denied request before send');
    requests.push({ method, pathname: parsed.pathname });
    return nativeFetch(input, init);
  };
}

async function requirePrivateRegularFile(filename, label) {
  const item = await lstat(filename);
  if (!item.isFile() || item.isSymbolicLink() || ((item.mode & 0o777) & 0o077) !== 0) throw new Error(`${label} must be private regular file`);
}

async function waitForRendererResult() {
  return bounded(new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const state = await windowRef.webContents.executeJavaScript(`JSON.stringify({ready:window.__q3CanonicalReadonlyReady === true, result:window.__q3CanonicalReadonlyResult ?? null, failure:window.__q3CanonicalReadonlyFailure ?? null})`);
        const parsed = JSON.parse(state);
        if (parsed.failure !== null) return reject(new Error(`renderer module failed: ${parsed.failure}`));
        if (!parsed.ready) return setTimeout(tick, 25);
        const result = await windowRef.webContents.executeJavaScript('window.__q3CanonicalReadonly.startElectron()');
        return resolve(result);
      } catch (error) { reject(error); }
    };
    void tick();
  }), 20 * 60_000, 'Q3 Electron renderer');
}

async function run() {
  if (!privateFile(sourceConnection)) throw new Error('private connection source unavailable');
  await requirePrivateRegularFile(sourceConnection, 'connection source');
  await mkdir(userData, { recursive: true, mode: 0o700 });
  await copyFile(sourceConnection, installedConnection);
  await chmod(installedConnection, 0o600);
  if (((await stat(installedConnection)).mode & 0o777) !== 0o600) throw new Error('installed connection file mode differs');
  installRendererNetworkPolicy();
  installBrokerNetworkPolicy();
  const module = await import(pathToFileURL(ipcPath).href);
  const registerCalibrationHarnessIpcHandlers = module.registerCalibrationHarnessIpcHandlers;
  if (typeof registerCalibrationHarnessIpcHandlers !== 'function') throw new Error('emitted IPC registrar unavailable');
async function requireRegularFile(filename, label) {
  const item = await lstat(filename);
  if (!item.isFile() || item.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
}
  await requireRegularFile(browserBundle, 'browser bundle');
  const fixtureSource = await readFile(browserBundle, 'utf8');
  windowRef = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  dispose = registerCalibrationHarnessIpcHandlers({
    ipcMain,
    getMainWebContents: () => windowRef?.webContents ?? null,
    expectedRendererUrl: () => `${webOrigin}/`,
    configPath: () => installedConnection,
  });
  await windowRef.loadURL(`${webOrigin}/`);
  await windowRef.webContents.executeJavaScript(`(() => { const tag = document.createElement('script'); tag.type = 'module'; tag.textContent = ${JSON.stringify(fixtureSource)}; document.head.append(tag); })()`);
  const outcome = await waitForRendererResult();
  if (outcome?.status !== 'PASS') throw new Error('production C3 renderer did not return PASS');
  const renderer = await processIdentity(windowRef.webContents.getOSProcessId());
  const main = await processIdentity(process.pid);
  if (renderer.seccomp !== '2' || renderer.noNewPrivs !== '1' || renderer.uid === '0' || main.uid === '0') throw new Error('secure Chromium sandbox/non-root identity failed');
  return { outcome, requests, sandbox: { renderer, main, browserWindow: { show: false, sandbox: true, contextIsolation: true, nodeIntegration: false } }, config: { mode: 0o600, mainOnly: true } };
}

async function finish(result) {
  let failure = null;
  try { await dispose?.(); } catch (error) { failure = redact(error); }
  try { if (windowRef && !windowRef.isDestroyed()) windowRef.destroy(); } catch (error) { failure ??= redact(error); }
  const report = failure === null && result?.outcome?.status === 'PASS'
    ? { schema: 'td-80f260-q3-electron-readonly/v1', status: 'PASS', outcome: result.outcome, requests: result.requests, sandbox: result.sandbox, config: result.config }
    : { schema: 'td-80f260-q3-electron-readonly/v1', status: 'FAIL', failure: failure ?? result?.failure ?? 'fixture failure', requests };
  await mkdir(path.dirname(reportFile), { recursive: true, mode: 0o700 });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  app.exit(report.status === 'PASS' ? 0 : 2);
}

app.setPath('userData', userData);
app.on('window-all-closed', () => {});
app.whenReady().then(run).then(finish).catch(error => finish({ failure: redact(error) }));
