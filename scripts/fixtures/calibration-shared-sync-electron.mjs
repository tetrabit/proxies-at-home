import { app, BrowserWindow, ipcMain } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const options = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const required = ['root', 'run', 'service', 'node', 'node-path', 'preload', 'ipc', 'report-file'];
for (const key of required) {
  if (!options.get(key) || !path.isAbsolute(options.get(key))) throw new Error(`electron Q1 fixture needs absolute --${key}`);
}

const root = options.get('root');
const run = options.get('run');
const servicePath = options.get('service');
const nodeExecutable = options.get('node');
const nodePath = options.get('node-path');
const preload = options.get('preload');
const ipcPath = options.get('ipc');
const reportFile = options.get('report-file');
const startupOnly = options.has('startup-only');
const profile = path.join(run, 'electron-profile');
const userData = path.join(profile, 'user-data');
const serviceData = path.join(run, 'server-data');
const credentialFile = path.join(run, 'private-browser-credential');
const connectionFile = path.join(userData, 'calibration-harness.connection.json');
const browserProfile = path.join(run, 'browser-profile');
const credentialPattern = /calibration_pair_[A-Za-z0-9_-]{43}/g;

let service = null;
let windowRef = null;
let dispose = null;
const events = [];

const redact = (value) => String(value).replace(credentialPattern, '[REDACTED_CALIBRATION_CREDENTIAL]');
const bounded = (promise, timeoutMs, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
};

function trackChild(command, args, options, label) {
  const child = spawn(command, args, options);
  let stdout = '';
  let stderr = '';
  let spawnError = null;
  let exit = null;
  const listeners = new Set();
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
    for (const listener of listeners) listener();
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.once('error', (error) => {
    spawnError = error;
    for (const listener of listeners) listener();
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exit = { code, signal };
      for (const listener of listeners) listener();
      resolve(exit);
    });
  });
  const readiness = (timeoutMs) => new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      listeners.delete(check);
      callback(value);
    };
    const check = () => {
      if (spawnError !== null) return finish(reject, new Error(`${label} spawn error: ${redact(spawnError.message)}`));
      const line = stdout.split('\n').find((value) => value.length > 0);
      if (line !== undefined) {
        try {
          const result = JSON.parse(line);
          return finish(resolve, result);
        } catch (error) {
          return finish(reject, new Error(`${label} emitted malformed readiness JSON: ${redact(error.message)}; stdout=${redact(stdout)}; stderr=${redact(stderr)}`));
        }
      }
      if (exit !== null) return finish(reject, new Error(`${label} exited before readiness (${exit.code ?? exit.signal}); stderr=${redact(stderr)}`));
    };
    listeners.add(check);
    timer = setTimeout(() => finish(reject, new Error(`${label} readiness timeout; stdout=${redact(stdout)}; stderr=${redact(stderr)}`)), timeoutMs);
    check();
  });
  return {
    child,
    readiness,
    waitExit: (timeoutMs) => bounded(exited, timeoutMs, `${label} exit`),
    diagnostics: () => ({ stdout: redact(stdout), stderr: redact(stderr), exit }),
  };
}

function processGroupScan(processGroupId) {
  try {
    const output = execFileSync('ps', ['-eo', 'pid=,pgid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const pids = output.split('\n').map((line) => line.trim().split(/\s+/).map(Number)).filter(([pid, pgid]) => Number.isInteger(pid) && pgid === processGroupId).map(([pid]) => pid);
    return { supported: true, status: 'known', pids };
  } catch (error) {
    return { supported: true, status: 'unknown', pids: null, error: redact(error.message) };
  }
}

async function stopOwnedGroup(tracked, label) {
  const child = tracked?.child;
  if (!child?.pid) return { reaped: false, verified: false, failure: `${label} child pid unavailable` };
  let exit;
  try {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      exit = await tracked.waitExit(2_500);
    } else {
      exit = { code: child.exitCode, signal: child.signalCode };
    }
  } catch (error) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
    try { exit = await tracked.waitExit(2_500); } catch (finalError) {
      return { reaped: false, verified: false, failure: `${label} did not settle: ${redact(finalError.message)}`, diagnostics: tracked.diagnostics() };
    }
  }
  const scan = processGroupScan(child.pid);
  return { reaped: true, exit, scan, verified: scan.status === 'known' && scan.pids.length === 0, diagnostics: tracked.diagnostics() };
}

const identity = async (pid) => {
  const [status, processStat] = await Promise.all([readFile(`/proc/${pid}/status`, 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8')]);
  const field = (name) => status.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1] ?? null;
  const fields = processStat.slice(processStat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return {
    pid,
    pgid: Number(fields[2]),
    sid: Number(fields[3]),
    startTime: fields[19] ?? null,
    uid: field('Uid')?.split(/\s+/)[0] ?? null,
    gid: field('Gid')?.split(/\s+/)[0] ?? null,
    seccomp: field('Seccomp'),
    noNewPrivs: field('NoNewPrivs'),
  };
};

async function runBrowser(mode, origin) {
  const tracked = trackChild(nodeExecutable, [
    path.join(root, 'scripts/fixtures/calibration-shared-sync-browser.mjs'),
    mode,
    origin,
    browserProfile,
    credentialFile,
  ], {
    cwd: run,
    detached: true,
    env: {
      PATH: process.env.PATH,
      NODE_PATH: nodePath,
      Q1_CHROMIUM_EXECUTABLE: options.get('chromium'),
      // bwrap provides this per-launch tmpfs; its short absolute path keeps Chromium's
      // ProcessSingleton Unix-domain socket below sun_path's 108-byte limit.
      TMPDIR: '/var/tmp',
      HOME: path.join(run, 'browser-home'),
      XDG_CONFIG_HOME: path.join(run, 'browser-config'),
      XDG_CACHE_HOME: path.join(run, 'browser-cache'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }, `browser-${mode}`);
  try {
    const ready = await tracked.readiness(30_000);
    const exit = await tracked.waitExit(5_000);
    if (exit.code !== 0 || ready.kind !== 'browser-result') {
      throw new Error(`browser ${mode} failed: ${JSON.stringify(tracked.diagnostics())}`);
    }
    const scan = processGroupScan(tracked.child.pid);
    if (scan.status !== 'known' || scan.pids.length !== 0) throw new Error(`browser ${mode} left live processes`);
    return { ...ready.result, shutdown: { exit, scan, verified: true } };
  } catch (error) {
    await stopOwnedGroup(tracked, `browser-${mode}`);
    throw error;
  }
}

async function closeService() {
  const result = await stopOwnedGroup(service, 'production calibration service');
  service = null;
  return result;
}

async function main() {
  await writeFile(path.join(run, 'reports', 'fixture-stage.txt'), 'directories\n', { mode: 0o600 });
  for (const directory of [
    run,
    profile,
    userData,
    serviceData,
    browserProfile,
    path.join(run, 'browser-home'),
    path.join(run, 'browser-config'),
    path.join(run, 'browser-cache'),
    path.join(run, 'browser-temp'),
  ]) await mkdir(directory, { recursive: true, mode: 0o700 });

  app.setPath('userData', userData);
  app.on('window-all-closed', () => {});
  await app.whenReady();
  await writeFile(path.join(run, 'reports', 'fixture-stage.txt'), 'electron-ready\n', { mode: 0o600 });

  service = trackChild(nodeExecutable, [
    servicePath,
    '--run',
    root,
    run,
    serviceData,
    credentialFile,
    connectionFile,
  ], {
    cwd: root,
    detached: true,
    env: {
      PATH: process.env.PATH,
      NODE_PATH: nodePath,
      HOME: path.join(run, 'service-home'),
      XDG_CACHE_HOME: path.join(run, 'service-cache'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }, 'production calibration service');
  const ready = await service.readiness(8_000);
  if (ready.kind !== 'ready' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(ready.origin)) {
    throw new Error(`service readiness invalid: ${JSON.stringify(service.diagnostics())}`);
  }
  await writeFile(path.join(run, 'reports', 'fixture-stage.txt'), 'service-ready\n', { mode: 0o600 });

  const register = (await import(pathToFileURL(ipcPath).href)).registerCalibrationHarnessIpcHandlers;
  if (typeof register !== 'function') throw new Error('emitted IPC registrar unavailable');
  const expected = `${ready.origin}/calibration-shared-sync.html?role=electron`;
  windowRef = new BrowserWindow({
    show: false,
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  windowRef.webContents.on('console-message', (_event, level, message) => events.push({ level, message: redact(message) }));
  dispose = register({
    ipcMain,
    getMainWebContents: () => windowRef?.webContents ?? null,
    expectedRendererUrl: () => expected,
    configPath: () => connectionFile,
  });

  if (startupOnly) {
    await windowRef.loadURL('data:text/html,<main>Q1 startup-only production preload probe</main>');
    const renderer = await identity(windowRef.webContents.getOSProcessId());
    const main = await identity(process.pid);
    if (renderer.seccomp !== '2' || renderer.noNewPrivs !== '1' || renderer.uid === '0' || main.uid === '0') {
      throw new Error('sandbox identity requirements failed');
    }
    return {
      status: 'PASS',
      startupOnly: true,
      service: { ready: true },
      sandbox: {
        browserWindow: { show: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
        renderer,
        main,
      },
      profile: { electron: profile, browser: browserProfile, distinct: profile !== browserProfile },
      config: { path: connectionFile, mode: (await stat(connectionFile)).mode & 0o777 },
      events,
    };
  }

  await windowRef.loadURL(expected);
  const browserSeed = await runBrowser('seed', ready.origin);
  await windowRef.webContents.executeJavaScript(`document.querySelector('[data-action=electron-edit]').click()`);
  await windowRef.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const limit=Date.now()+10000;const tick=()=>document.querySelector('#status').textContent==='electron-published'?resolve(true):Date.now()>limit?reject(new Error(document.querySelector('#status').textContent)):setTimeout(tick,25);tick()})`);
  const electronResult = await windowRef.webContents.executeJavaScript('window.__calibrationSharedSyncResult');
  const browserObserve = await runBrowser('observe', ready.origin);

  const renderer = await identity(windowRef.webContents.getOSProcessId());
  const main = await identity(process.pid);
  if (renderer.seccomp !== '2' || renderer.noNewPrivs !== '1' || renderer.uid === '0' || main.uid === '0') {
    throw new Error('sandbox identity requirements failed');
  }
  if (JSON.stringify({ browserSeed, electronResult, browserObserve, events }).includes('calibration_pair_')) {
    throw new Error('renderer evidence leaked private configuration');
  }
  return {
    status: 'PASS',
    service: { ready: true },
    browserSeed,
    electronResult,
    browserObserve,
    sandbox: {
      browserWindow: { show: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
      renderer,
      main,
    },
    profile: { electron: profile, browser: browserProfile, distinct: profile !== browserProfile },
    config: { path: connectionFile, mode: (await stat(connectionFile)).mode & 0o777 },
    events,
  };
}

let outcome;
let failure;
let cleanup;
void writeFile(path.join(run, 'reports', 'fixture-entered.json'), `${JSON.stringify({ entered: true, argv: process.argv.slice(1) })}\n`, { mode: 0o600 })
  .then(() => main())
  .then((result) => { outcome = result; })
  .catch((error) => { failure = redact(error instanceof Error ? error.stack : String(error)); })
  .finally(async () => {
    try { await dispose?.(); } catch (error) { failure ??= redact(error); }
    try { if (windowRef && !windowRef.isDestroyed()) windowRef.destroy(); } catch { /* preserve fixture failure */ }
    cleanup = await closeService();
    await writeFile(reportFile, `${JSON.stringify({
      schema: 'q1-shared-sync-electron/v1',
      status: failure ? 'FAIL' : 'PASS',
      failure: failure ?? null,
      outcome: outcome ?? null,
      cleanup,
    }, null, 2)}\n`, { mode: 0o600 });
    await chmod(reportFile, 0o600);
    app.exit(failure ? 2 : 0);
  });
