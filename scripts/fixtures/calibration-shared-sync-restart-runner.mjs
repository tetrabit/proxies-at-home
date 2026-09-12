#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { ownedProcessGroupMembers } from '../preload-compatibility-smoke.mjs';

const timeoutMs = 30_000;
const startupTimeoutMs = 8_000;
const credentialPattern = /^calibration_pair_[A-Za-z0-9_-]{43}$/;
const redact = value => String(value).replace(/calibration_pair_[A-Za-z0-9_-]+/g, '[REDACTED_CALIBRATION_CREDENTIAL]');

function parseOptions(argv) {
  const values = new Map(argv.map(argument => {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) throw new Error(`invalid Q2 runner argument: ${argument}`);
    return [match[1], match[2]];
  }));
  const required = ['root', 'run', 'service', 'node', 'electron', 'preload', 'ipc', 'chromium'];
  if (values.size !== argv.length || required.some(key => !values.has(key))) throw new Error('Q2 runner requires exact owned runtime paths');
  const result = Object.fromEntries(values);
  if (!Object.values(result).every(value => path.isAbsolute(value))) throw new Error('Q2 runner requires absolute paths');
  return result;
}

function bounded(promise, timeout, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout); }),
  ]).finally(() => clearTimeout(timer));
}

function tracked(command, args, options, label) {
  const child = spawn(command, args, options);
  let stdout = ''; let stderr = ''; let spawnError = null;
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const failed = new Promise((_, reject) => child.once('error', error => { spawnError = error; reject(error); }));
  child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8'); });
  return {
    child, label,
    get stdout() { return stdout; }, get stderr() { return stderr; },
    async wait(timeout = timeoutMs) {
      try {
        const outcome = await bounded(Promise.race([exit, failed]), timeout, `${label} exit`);
        if (spawnError) throw new Error(`${label} spawn failed: ${redact(spawnError.message)}`);
        return outcome;
      } catch (error) { throw new Error(`${label}: ${redact(error?.message ?? error)}`); }
    },
  };
}

async function stop(track) {
  if (!track) return null;
  if (track.child.exitCode === null && track.child.signalCode === null) {
    try { process.kill(-track.child.pid, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }
  let exit;
  try { exit = await track.wait(5_000); }
  catch (first) {
    if (track.child.exitCode === null && track.child.signalCode === null) {
      try { process.kill(-track.child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    }
    try { exit = await track.wait(5_000); } catch { throw first; }
  }
  const scan = ownedProcessGroupMembers(track.child.pid);
  if (scan.status !== 'known' || scan.pids.length !== 0) throw new Error(`${track.label} left live processes`);
  return { exit, pid: track.child.pid, scan, verified: true };
}

async function freePort() {
  const server = net.createServer();
  const port = await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', () => resolve(server.address().port)));
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitReady(track, label) {
  const ready = (async () => {
    let seen = 0;
    while (true) {
      const lines = track.stdout.split('\n');
      for (; seen < lines.length - 1; seen += 1) {
        try {
          const parsed = JSON.parse(lines[seen]);
          if (parsed.kind === 'ready' && typeof parsed.origin === 'string') return parsed;
        } catch { /* unrelated Vite diagnostic remains in captured evidence */ }
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })();
  const outcome = await bounded(Promise.race([
    ready,
    track.wait(startupTimeoutMs).then(value => { throw new Error(`${label} exited before readiness (${value.code ?? value.signal}): ${redact(track.stderr)}`); }),
  ]), startupTimeoutMs, `${label} readiness`);
  return outcome;
}

async function waitFile(filename, label, waiting) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { return await readFile(filename, 'utf8'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (waiting.child.exitCode !== null || waiting.child.signalCode !== null) {
      throw new Error(`${label} process exited before checkpoint: ${redact(waiting.stderr)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out`);
}

function environment({ root, run }) {
  const profile = path.join(run, 'electron-profile');
  return {
    PATH: process.env.PATH,
    NODE_PATH: [path.join(root, 'server', 'node_modules'), path.join(root, 'node_modules')].join(path.delimiter),
    HOME: path.join(profile, 'home'),
    XDG_CONFIG_HOME: path.join(profile, 'config'),
    XDG_CACHE_HOME: path.join(profile, 'cache'),
    XDG_RUNTIME_DIR: path.join(profile, 'runtime'),
    TMPDIR: '/var/tmp',
    ELECTRON_DISABLE_GPU: '1',
    LIBGL_ALWAYS_SOFTWARE: '1',
    DISPLAY: process.env.DISPLAY,
  };
}

async function browserPhase({ origin, profile, credentialFile, phase }) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: parseOptions(process.argv.slice(2)).chromium,
    chromiumSandbox: true,
    serviceWorkers: 'block',
    args: ['--no-proxy-server', '--ozone-platform=x11'],
  });
  try {
    const page = await context.newPage();
    if (phase === 'queue') await context.route(`${origin}/api/calibration-harness/snapshot`, route => route.request().method() === 'PUT' ? route.abort('failed') : route.continue());
    await page.goto(`${origin}/calibration-shared-sync-restart.html?role=browser&phase=${phase}`, { waitUntil: 'domcontentloaded' });
    if (phase === 'queue') {
      const credential = (await readFile(credentialFile, 'utf8')).trim();
      if (!credentialPattern.test(credential)) throw new Error('Q2 browser credential is unavailable');
      await page.waitForFunction(() => window.__q2ModuleReady === true, null, { timeout: timeoutMs });
      await page.locator('#credential').fill(credential);
      await page.locator('#q2-start').click();
    }
    await page.waitForFunction(() => {
      const text = document.querySelector('#status')?.textContent ?? '';
      if (text.startsWith('failed:')) throw new Error(text);
      return text === 'PASS';
    }, null, { timeout: timeoutMs });
    const result = await page.evaluate(() => window.__q2RestartResult);
    if (result?.status !== 'PASS') throw new Error(`browser ${phase} did not return PASS`);
    return result;
  } finally {
    await context.close();
    if (context.browser()?.isConnected()) throw new Error(`browser ${phase} did not physically close`);
  }
}

async function electronPhase(options, env) {
  const report = path.join(options.run, 'reports', `${options.phase}.json`);
  const electron = tracked(options.electron, [
    '--disable-gpu', '--no-proxy-server', '--ozone-platform=x11',
    `--user-data-dir=${path.join(options.run, 'electron-profile', 'user-data')}`,
    path.join(options.root, 'scripts/fixtures/calibration-shared-sync-restart-electron.mjs'),
    `--run=${options.run}`, `--origin=${options.origin}`, `--preload=${options.preload}`, `--ipc=${options.ipc}`,
    `--connection=${options.connection}`, `--phase=${options.phase}`, `--report-file=${report}`,
  ], { cwd: options.run, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] }, `Electron ${options.phase}`);
  return { electron, report };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const run = options.run; const reports = path.join(run, 'reports'); const profile = path.join(run, 'electron-profile');
  await mkdir(reports, { recursive: true, mode: 0o700 });
  for (const item of ['home', 'config', 'cache', 'runtime', 'user-data']) await mkdir(path.join(profile, item), { recursive: true, mode: 0o700 });
  const env = environment(options);
  if (!/^:[1-9][0-9]*$/.test(env.DISPLAY ?? '')) throw new Error('Q2 inner runner lacks the private Xvfb display');
  const data = path.join(run, 'server-data'); const credential = path.join(run, 'private-browser-credential');
  const connection = path.join(profile, 'user-data', 'calibration-harness.connection.json');
  const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
  let service = null; const activeElectrons = []; const matrix = {}; let failure = null;
  try {
    service = tracked(options.node, [options.service, '--run', options.root, run, data, credential, connection, '--mode=bootstrap', `--port=${port}`], { cwd: run, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] }, 'Q2 bootstrap service');
    const bootstrap = await waitReady(service, 'Q2 bootstrap service');
    if (bootstrap.origin !== origin) throw new Error('bootstrap service selected a noncanonical origin');
    matrix.browserQueue = await browserPhase({ origin, profile: path.join(run, 'browser-profile'), credentialFile: credential, phase: 'queue' });
    const credentialHash = createHash('sha256').update(await readFile(credential)).digest('hex');
    const connectionHash = createHash('sha256').update(await readFile(connection)).digest('hex');
    matrix.serviceBeforeRestart = await stop(service); service = null;
    service = tracked(options.node, [options.service, '--run', options.root, run, data, credential, connection, '--mode=resume', `--port=${port}`], { cwd: run, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] }, 'Q2 resume service');
    const resumed = await waitReady(service, 'Q2 resume service');
    if (resumed.origin !== origin) throw new Error('resume service changed its fixed origin');
    if (createHash('sha256').update(await readFile(credential)).digest('hex') !== credentialHash
      || createHash('sha256').update(await readFile(connection)).digest('hex') !== connectionHash) throw new Error('resume rewrote connection material');
    matrix.serviceResume = { pid: service.child.pid, originUnchanged: true, credentialUnchanged: true, connectionUnchanged: true };
    matrix.browserRecover = await browserPhase({ origin, profile: path.join(run, 'browser-profile'), credentialFile: credential, phase: 'recover' });
    if (matrix.browserRecover.revision !== 2) throw new Error('browser recovery did not settle revision 2 before Electron admission');

    const disjoint = await electronPhase({ ...options, run, origin, connection, phase: 'electron-disjoint' }, env);
    activeElectrons.push(disjoint.electron);
    await waitFile(path.join(reports, 'electron-disjoint-admitted'), 'electron disjoint admission', disjoint.electron);
    matrix.browserRemoteDisjoint = await browserPhase({ origin, profile: path.join(run, 'browser-profile'), credentialFile: credential, phase: 'remote-disjoint' });
    if (matrix.browserRemoteDisjoint.revision !== 3) throw new Error('remote disjoint publication did not produce revision 3');
    await writeFile(path.join(run, 'electron-disjoint-go'), 'go\n', { mode: 0o600 }); await chmod(path.join(run, 'electron-disjoint-go'), 0o600);
    const disjointExit = await disjoint.electron.wait();
    if (disjointExit.code !== 0) throw new Error(`electron disjoint failed: ${redact(disjoint.electron.stderr)}`);
    matrix.electronDisjoint = JSON.parse(await readFile(disjoint.report, 'utf8'));
    if (matrix.electronDisjoint.outcome?.result?.revision !== 4) throw new Error('Electron stale-base disjoint merge did not publish revision 4');
    matrix.electronBeforeRestart = await stop(disjoint.electron);

    const conflict = await electronPhase({ ...options, run, origin, connection, phase: 'electron-conflict' }, env);
    activeElectrons.push(conflict.electron);
    await waitFile(path.join(reports, 'electron-conflict-admitted'), 'electron conflict admission', conflict.electron);
    matrix.browserRemoteConflict = await browserPhase({ origin, profile: path.join(run, 'browser-profile'), credentialFile: credential, phase: 'remote-conflict' });
    if (matrix.browserRemoteConflict.revision !== 5) throw new Error('remote conflict publication did not produce revision 5');
    await writeFile(path.join(run, 'electron-conflict-go'), 'go\n', { mode: 0o600 }); await chmod(path.join(run, 'electron-conflict-go'), 0o600);
    const conflictExit = await conflict.electron.wait();
    if (conflictExit.code !== 0) throw new Error(`electron conflict failed: ${redact(conflict.electron.stderr)}`);
    matrix.electronConflict = JSON.parse(await readFile(conflict.report, 'utf8'));
    const conflictOutcome = matrix.electronConflict.outcome?.result;
    if (conflictOutcome?.revision !== 5 || conflictOutcome?.recovery !== 'conflict') throw new Error('same-case stale conflict did not retain revision 5');
  } catch (error) {
    failure = redact(error?.stack ?? error);
  } finally {
    for (const electron of activeElectrons.reverse()) {
      try { matrix[`${electron.label} shutdown`] = await stop(electron); }
      catch (error) { failure ??= redact(error?.stack ?? error); }
    }
    try { if (service) matrix.serviceFinal = await stop(service); }
    catch (error) { failure ??= redact(error?.stack ?? error); }
  }
  const report = { schema: 'td-b7731f-offline-restart-q2/v2', status: failure ? 'FAIL' : 'PASS', failure, run, origin, matrix };
  await writeFile(path.join(reports, 'inner-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, failure }, null, 2));
  if (failure) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) await main();
