import { app, BrowserWindow, ipcMain } from 'electron';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const options = new Map(process.argv.slice(2).map(argument => {
  const [key, ...rest] = argument.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const required = ['run', 'origin', 'preload', 'ipc', 'connection', 'phase', 'report-file'];
for (const key of required) if (!options.get(key)) throw new Error(`Q2 Electron fixture needs --${key}`);
const run = options.get('run');
const origin = options.get('origin');
const preload = options.get('preload');
const ipcPath = options.get('ipc');
const connection = options.get('connection');
const phase = options.get('phase');
const reportFile = options.get('report-file');
if (![run, preload, ipcPath, connection, reportFile].every(path.isAbsolute) || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(origin) || !['electron-disjoint', 'electron-conflict'].includes(phase)) throw new Error('Q2 Electron fixture received unsafe arguments');

function bounded(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function identity(pid) {
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  const field = name => status.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1] ?? null;
  return { pid, uid: field('Uid')?.split(/\s+/)[0] ?? null, seccomp: field('Seccomp'), noNewPrivs: field('NoNewPrivs') };
}

async function waitRenderer(predicate, label) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const result = await windowRef.webContents.executeJavaScript(`(() => {
      const status = document.querySelector('#status')?.textContent ?? '';
      return { status, ready: Boolean(${predicate}) };
    })()`);
    if (result.status.startsWith('failed:')) throw new Error(result.status);
    if (result.ready) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out`);
}

async function waitGo(signal) {
  return bounded((async () => {
    while (true) {
      try { await readFile(signal, 'utf8'); return; }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  })(), 30_000, `Q2 ${phase} go signal`);
}

let windowRef;
let dispose;
let failure = null;
let outcome = null;
void (async () => {
  const profile = path.join(run, 'electron-profile');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  app.setPath('userData', path.join(profile, 'user-data'));
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const register = (await import(pathToFileURL(ipcPath).href)).registerCalibrationHarnessIpcHandlers;
  const expected = `${origin}/calibration-shared-sync-restart.html?role=electron&phase=${phase}`;
  windowRef = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  dispose = register({ ipcMain, getMainWebContents: () => windowRef?.webContents ?? null, expectedRendererUrl: () => expected, configPath: () => connection });
  await windowRef.loadURL(expected);
  await waitRenderer('window.__q2AdmissionReady === true', `Q2 ${phase} renderer admission`);
  const admitted = path.join(run, 'reports', `${phase}-admitted`);
  await writeFile(admitted, 'admitted\n', { mode: 0o600 });
  await chmod(admitted, 0o600);
  await waitGo(path.join(run, `${phase}-go`));
  await windowRef.webContents.executeJavaScript('window.__q2RestartGo = true');
  await waitRenderer("document.querySelector('#status')?.textContent === 'PASS'", `Q2 ${phase} renderer completion`);
  const result = await windowRef.webContents.executeJavaScript('window.__q2RestartResult');
  const renderer = await identity(windowRef.webContents.getOSProcessId());
  if (result?.status !== 'PASS' || renderer.seccomp !== '2' || renderer.noNewPrivs !== '1' || renderer.uid === '0') throw new Error('Q2 Electron runtime evidence is incomplete');
  outcome = { result, renderer, browserWindow: { show: false, sandbox: true, contextIsolation: true, nodeIntegration: false }, admissionMarker: admitted };
})().catch(error => { failure = String(error?.stack ?? error).slice(0, 12000); }).finally(async () => {
  try { await dispose?.(); } catch (error) { failure ??= String(error); }
  try { if (windowRef && !windowRef.isDestroyed()) windowRef.destroy(); } catch (error) { failure ??= String(error); }
  await writeFile(reportFile, `${JSON.stringify({ status: failure === null ? 'PASS' : 'FAIL', failure, outcome }, null, 2)}\n`, { mode: 0o600 });
  await chmod(reportFile, 0o600);
  app.exit(failure === null ? 0 : 2);
});
