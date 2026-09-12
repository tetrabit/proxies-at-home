#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

import { stopOwned as stopOwnedProcess } from './preload-compatibility-smoke.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactParent = path.join(root, '.review-artifacts', 'td-80f260');
const API_ROOT = '/api/calibration-harness';
const browserFixture = path.join(root, 'scripts', 'fixtures', 'calibration-canonical-readonly-browser.mjs');
const electronFixture = path.join(root, 'scripts', 'fixtures', 'calibration-canonical-readonly-electron.mjs');
const credentialPattern = /^calibration_pair_[A-Za-z0-9_-]{43}$/;
const privateKey = /credential|connection|authorization|token|secret|config|profile/i;
const logLimit = 12_000;

export const EXPECTED_CANONICAL_COUNTS = Object.freeze({
  datasets: 1, cases: 124, assets: 7227, runs: 25, uniqueBlobs: 5817, revision: 1,
});

function fail(message) { throw new Error(`Q3 canonical readonly runner: ${message}`); }
function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${name} must be an absolute path`);
  return value;
}
function exactOption(argument) {
  const match = /^--([a-z-]+)=(.*)$/.exec(argument);
  if (match === null || match[2].length === 0) fail('arguments must be exact --name=value options');
  return match.slice(1);
}

/** Parse only non-secret file references; credential values/env fail closed. */
export function parseReadonlyRunArguments(argv) {
  const required = new Set(['backend-origin', 'web-origin', 'browser-credential-file', 'electron-connection-file', 'electron', 'preload', 'ipc', 'chromium']);
  if (!Array.isArray(argv) || argv.length !== required.size) fail('requires the eight exact readonly options');
  const values = new Map();
  for (const argument of argv) {
    const [key, value] = exactOption(argument);
    if (!required.has(key) || values.has(key) || (/credential(?:=|$)/.test(argument) && key !== 'browser-credential-file')) {
      fail('unrecognized, duplicate, or credential-value option');
    }
    values.set(key, value);
  }
  if (values.size !== required.size || [...required].some(key => !values.has(key))) fail('requires the eight exact readonly options');
  const parsed = {
    backendOrigin: values.get('backend-origin'), webOrigin: values.get('web-origin'),
    browserCredentialFile: absolute(values.get('browser-credential-file'), 'browser credential file'),
    electronConnectionFile: absolute(values.get('electron-connection-file'), 'electron connection file'),
    electron: absolute(values.get('electron'), 'electron executable'),
    preload: absolute(values.get('preload'), 'preload'), ipc: absolute(values.get('ipc'), 'ipc'),
    chromium: absolute(values.get('chromium'), 'chromium executable'),
  };
  validateCanonicalEndpoints(parsed);
  return Object.freeze(parsed);
}

export function validateCanonicalEndpoints(input) {
  if (input?.backendOrigin !== 'http://127.0.0.1:3001' || input?.webOrigin !== 'http://127.0.0.1:5173') {
    fail('requires backend http://127.0.0.1:3001 and web http://127.0.0.1:5173 exactly');
  }
  return Object.freeze({ backendOrigin: input.backendOrigin, webOrigin: input.webOrigin });
}
function allowedPath(pathname) {
  return pathname === `${API_ROOT}/session` || pathname === `${API_ROOT}/snapshot`
    || new RegExp(`^${API_ROOT}/blobs/[0-9a-f]{64}$`).test(pathname);
}

/** Validate a redacted transport-event projection; headers and query values are never retained. */
export function assertReadonlyRequestLog(entries) {
  if (!Array.isArray(entries)) fail('request log is invalid');
  let browserPairCount = 0;
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || (entry.role !== 'browser' && entry.role !== 'electron')
      || typeof entry.method !== 'string' || typeof entry.pathname !== 'string') fail('request log is invalid');
    if (entry.role === 'browser' && entry.method === 'POST' && entry.pathname === `${API_ROOT}/pair`) { browserPairCount += 1; continue; }
    if (entry.method !== 'GET' || !allowedPath(entry.pathname)) fail(`forbidden request ${entry.method} ${entry.pathname}`);
  }
  if (browserPairCount !== 1) fail('requires exactly one browser pairing request');
  return Object.freeze({ browserPairCount, total: entries.length });
}
function exactCounts(value) {
  return value !== null && typeof value === 'object'
    && ['datasets', 'cases', 'assets', 'runs', 'uniqueBlobs'].every(key => value[key] === EXPECTED_CANONICAL_COUNTS[key]);
}
function completeClientProof(value, role) {
  if (value?.status !== 'PASS' || !exactCounts(value.counts) || value.validatedAssets !== EXPECTED_CANONICAL_COUNTS.assets
    || (value.revision !== undefined && value.revision !== EXPECTED_CANONICAL_COUNTS.revision)) fail(`complete ${role} proof is required`);
}
function redact(value, key = '') {
  if (privateKey.test(key)) return undefined;
  if (typeof value === 'string') return value.replace(/calibration_pair_[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, logLimit);
  if (Array.isArray(value)) return value.map(item => redact(item)).filter(item => item !== undefined).slice(0, 12);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]).filter(([, item]) => item !== undefined));
  return value;
}

/** Produces client-hydration evidence only; immutable DB/export verification remains owner-provided. */
export function createReadonlyReport(input) {
  completeClientProof(input.browser, 'browser'); completeClientProof(input.electron, 'electron');
  if (input.requests?.browserPairCount !== 1 || !Number.isSafeInteger(input.requests?.total) || input.requests.total < 1) fail('request allowlist proof is required');
  const report = redact({
    schema: 'td-80f260-canonical-readonly-client-hydration/v2', status: 'PASS',
    proofLayer: 'production C3/Dexie client hydration fixture, not full application UI; post-pair session-tolerant canonical DB/history/export verification is owner-provided separately',
    run: input.run, endpoints: { backendOrigin: input.backendOrigin, webOrigin: input.webOrigin }, expected: EXPECTED_CANONICAL_COUNTS,
    browser: input.browser, electron: input.electron, requestAllowlist: input.requests, buildBinding: input.buildBinding,
  });
  if (JSON.stringify(report).includes('calibration_pair_')) fail('redaction failed');
  return Object.freeze(report);
}

async function checkedPrivateFile(filename, label) {
  const item = await lstat(filename);
  if (!item.isFile() || item.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  if (((item.mode & 0o777) & 0o077) !== 0) fail(`${label} must not be group/world accessible`);
}
async function allocateRun() {
  await mkdir(artifactParent, { recursive: true, mode: 0o700 });
  const parent = await realpath(artifactParent); const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail('artifact parent is not an owned directory');
  const run = path.join(parent, `impl-${randomUUID()}`);
  try { await mkdir(run, { mode: 0o700 }); } catch (error) { if (error?.code === 'EEXIST') fail('artifact run collision'); throw error; }
  await mkdir(path.join(run, 'reports'), { mode: 0o700 });
  return run;
}
async function sha256(filename) { return createHash('sha256').update(await readFile(filename)).digest('hex'); }
function bounded(promise, timeoutMs, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); })]).finally(() => clearTimeout(timer));
}
function cappedAppend(current, chunk) {
  return `${current}${chunk}`.slice(-logLimit);
}
function tracked(command, args, options, label) {
  const child = spawn(command, args, options); let stdout = ''; let stderr = ''; let spawnError;
  child.stdout?.on('data', chunk => { stdout = cappedAppend(stdout, chunk.toString('utf8')); });
  child.stderr?.on('data', chunk => { stderr = cappedAppend(stderr, chunk.toString('utf8')); });
  child.once('error', error => { spawnError = error; });
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  return { child,
    async wait(timeoutMs) { const exit = await bounded(exited, timeoutMs, label); if (spawnError !== undefined) throw new Error(`${label} failed to spawn`); return exit; },
    diagnostics: () => redact({ stdout, stderr }),
  };
}
async function safeStop(child) {
  if (!child?.pid) return { verified: false, failure: 'owned child pid unavailable' };
  return stopOwnedProcess(child, [], { killFn: (owned, signal) => { process.kill(-owned.pid, signal); } });
}
async function startXvfb() {
  const child = spawn('/usr/bin/Xvfb', ['-displayfd', '3', '-nolisten', 'tcp', '-screen', '0', '1280x800x24'], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH },
  });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr = cappedAppend(stderr, chunk.toString('utf8')); });
  try {
    const displayText = await bounded(Promise.race([
      once(child.stdio[3], 'data').then(([chunk]) => String(chunk).trim()),
      once(child, 'exit').then(([code, signal]) => { throw new Error(`private Xvfb exited before readiness (${code ?? signal})`); }),
      once(child, 'error').then(([error]) => { throw error; }),
    ]), 5_000, 'private Xvfb readiness');
    const display = `:${Number.parseInt(displayText, 10)}`;
    if (!/^:[1-9][0-9]*$/.test(display)) fail('private Xvfb did not provide a display');
    return { child, display };
  } catch (error) {
    const cleanup = await safeStop(child);
    throw new Error(`private Xvfb startup failed (${redact(error instanceof Error ? error.message : String(error))}); cleanup verified=${cleanup.verified === true}`);
  }
}
function localInputRecords(metafile) {
  return Object.keys(metafile.inputs).map(filename => path.resolve(root, filename)).filter(filename => {
    const relative = path.relative(root, filename);
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && !relative.split(path.sep).includes('node_modules');
  }).sort();
}
async function snapshotSources(files) {
  return Object.fromEntries(await Promise.all([...new Set(files)].sort().map(async filename => {
    const relative = path.relative(root, filename).split(path.sep).join('/');
    const bytes = await readFile(filename); return [relative, { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength }];
  })));
}
function sameSnapshots(first, second) { return JSON.stringify(first) === JSON.stringify(second); }

function resolveClientImport(specifier) {
  const candidate = path.join(root, 'client', 'src', specifier);
  for (const suffix of ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js']) {
    if (existsSync(`${candidate}${suffix}`)) return `${candidate}${suffix}`;
  }
  return candidate;
}

/** Bundle the real client closure once into the exclusive run so deployed Vite never resolves /src imports. */
async function buildBrowserFixture(run) {
  const outfile = path.join(run, 'browser-c3-fixture.bundle.js');
  const emitted = await build({
    absWorkingDir: root, entryPoints: [browserFixture], outfile, bundle: true, platform: 'browser', format: 'iife', target: 'chrome120',
    metafile: true, sourcemap: false, legalComments: 'none', logLevel: 'warning',
    plugins: [{ name: 'q3-client-source-alias', setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^\/src\// }, args => ({ path: resolveClientImport(args.path.slice('/src/'.length)) }));
      pluginBuild.onResolve({ filter: /^@\// }, args => ({ path: resolveClientImport(args.path.slice(2)) }));
    }}],
  });
  const inputs = localInputRecords(emitted.metafile);
  return { path: outfile, sha256: await sha256(outfile), byteLength: (await stat(outfile)).size, inputs, source: await snapshotSources(inputs) };
}
async function buildElectronClosure(run) {
  const destination = path.join(run, 'electron-build');
  const buildRun = tracked(process.execPath, [path.join(root, 'scripts', 'build-electron-main.mjs'), '--outdir', destination], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }, 'Q3 Electron build');
  const exit = await buildRun.wait(90_000);
  if (exit.code !== 0) throw new Error(`Q3 Electron build failed: ${buildRun.diagnostics().stderr ?? 'unknown error'}`);
  let result;
  try { result = JSON.parse(buildRun.diagnostics().stdout); } catch { throw new Error('Q3 Electron build omitted machine-readable report'); }
  if (!Array.isArray(result?.inputs) || !Array.isArray(result?.outputs)) throw new Error('Q3 Electron build report is incomplete');
  const inputs = result.inputs.filter(entry => typeof entry?.path === 'string' && !entry.path.startsWith('$')).map(entry => path.join(root, entry.path));
  const outputs = Object.fromEntries(await Promise.all(result.outputs.map(async entry => [entry.name, { sha256: entry.sha256, byteLength: entry.byteLength, path: path.join(destination, entry.name) }])));
  return { outdir: destination, inputs, source: await snapshotSources(inputs), outputs, tools: result.tools, inputHash: result.inputHash, raw: result };
}
export function requestAllowedForBrowser(url, method, paired) {
  if (url.origin !== 'http://127.0.0.1:5173') return false;
  if (!url.pathname.startsWith('/api/')) return true;
  if (url.pathname === `${API_ROOT}/pair`) return method === 'POST' && !paired;
  return method === 'GET' && allowedPath(url.pathname);
}
async function browserProof({ chromium: chromiumExecutable, webOrigin, run, credentialFile, browserBundle, requests }) {
  const pageErrors = [];
  const context = await chromium.launchPersistentContext(path.join(run, 'browser-profile'), {
    headless: true, executablePath: chromiumExecutable, chromiumSandbox: true, serviceWorkers: 'block', args: ['--no-proxy-server'],
  });
  try {
    let paired = false;
    await context.route('**/*', route => {
      const request = route.request(); let url;
      try { url = new URL(request.url()); } catch { return route.abort(); }
      const method = request.method().toUpperCase();
      if (!requestAllowedForBrowser(url, method, paired)) return route.abort();
      if (url.pathname.startsWith(API_ROOT)) {
        if (url.pathname === `${API_ROOT}/pair`) paired = true;
        requests.push({ role: 'browser', method, pathname: url.pathname });
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => { if (pageErrors.length < 8) pageErrors.push(redact(error instanceof Error ? error.message : String(error))); });
    await page.goto(webOrigin, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ path: browserBundle, type: 'module' });
    await page.waitForFunction(() => window.__q3CanonicalReadonlyReady === true || window.__q3CanonicalReadonlyFailure != null, null, { timeout: 30_000 });
    const initialized = await page.evaluate(() => ({ ready: window.__q3CanonicalReadonlyReady === true, failure: window.__q3CanonicalReadonlyFailure ?? null }));
    if (!initialized.ready) fail(`browser fixture initialization failed: ${redact(initialized.failure)}`);
    const credential = (await readFile(credentialFile, 'utf8')).trim();
    if (!credentialPattern.test(credential)) fail('browser credential file is invalid');
    await page.locator('#q3-credential').fill(credential);
    await page.locator('#q3-admit').click();
    await page.waitForFunction(() => window.__q3CanonicalReadonlyResult?.status === 'PASS' || window.__q3CanonicalReadonlyFailure != null, null, { timeout: 20 * 60_000 });
    const state = await page.evaluate(() => ({ result: window.__q3CanonicalReadonlyResult ?? null, failure: window.__q3CanonicalReadonlyFailure ?? null }));
    if (state.failure !== null || state.result?.status !== 'PASS') fail(`browser fixture failure: ${redact(state.failure ?? 'missing PASS result')}`);
    return { ...state.result, runtimeSafety: { browserAuthority: 'fixed web origin and API allowlist; default deny before send', chromiumSandbox: true, serviceWorkersBlocked: true, pageErrors } };
  } catch (error) {
    throw new Error(`${redact(error instanceof Error ? error.message : String(error))}; pageErrors=${JSON.stringify(pageErrors)}`);
  } finally { await context.close(); }
}
async function electronProof({ parsed, run, display, requests, browserBundle }) {
  const reportFile = path.join(run, 'reports', 'electron.json'); const profile = path.join(run, 'electron-profile');
  for (const directory of ['user-data', 'home', 'config', 'cache', 'runtime']) await mkdir(path.join(profile, directory), { recursive: true, mode: 0o700 });
  const args = ['--disable-gpu', '--no-proxy-server', '--ozone-platform=x11', `--user-data-dir=${path.join(profile, 'user-data')}`,
    electronFixture, `--web-origin=${parsed.webOrigin}`, `--backend-origin=${parsed.backendOrigin}`, `--connection-file=${parsed.electronConnectionFile}`,
    `--preload=${parsed.preload}`, `--ipc=${parsed.ipc}`, `--browser-bundle=${browserBundle}`, `--report-file=${reportFile}`];
  if (args.some(argument => argument === '--no-sandbox' || argument.startsWith('--no-sandbox=') || argument === '--disable-setuid-sandbox' || argument.startsWith('--disable-setuid-sandbox='))) fail('sandbox disabling launch argument rejected');
  const electron = tracked('/usr/bin/setpriv', ['--no-new-privs', '--', parsed.electron, ...args], {
    cwd: run, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, DISPLAY: display, HOME: path.join(profile, 'home'), XDG_CONFIG_HOME: path.join(profile, 'config'),
      XDG_CACHE_HOME: path.join(profile, 'cache'), XDG_RUNTIME_DIR: path.join(profile, 'runtime'), TMPDIR: '/var/tmp', ELECTRON_DISABLE_GPU: '1',
    },
  }, 'Q3 Electron');
  let cleanup;
  try {
    const exit = await electron.wait(25 * 60_000);
    if (exit.code !== 0) throw new Error(`Electron validation fixture failed (${exit.code ?? exit.signal})`);
    const result = JSON.parse(await readFile(reportFile, 'utf8'));
    if (result.status !== 'PASS' || !Array.isArray(result.requests)) throw new Error(`Electron report failure: ${redact(result.failure ?? 'missing PASS')}`);
    requests.push(...result.requests.map(entry => ({ role: 'electron', method: entry.method, pathname: entry.pathname })));
    return { ...result.outcome, runtimeSafety: { browserWindow: result.sandbox?.browserWindow, rendererSandbox: result.sandbox?.renderer,
      connectionFileMode: result.config?.mode, rendererAuthority: 'fixed web origin/API allowlist; default deny', brokerAuthority: 'fixed backend API allowlist; default deny',
      networkIsolation: 'host network required for canonical loopback services; no private network namespace claimed' }, diagnostics: electron.diagnostics() };
  } catch (error) {
    throw new Error(`${redact(error instanceof Error ? error.message : String(error))}; electronDiagnostics=${JSON.stringify(electron.diagnostics())}`);
  } finally {
    cleanup = await safeStop(electron.child);
    if (!cleanup.verified) throw new Error(`Electron owned-process cleanup was not verified: ${JSON.stringify(redact(cleanup))}`);
  }
}

async function main() {
  let run = null; let xvfb = null; let xvfbCleanup = null; let failure = null; let browser = null; let electron = null; let buildBinding = null; const requests = [];
  try {
    const parsed = parseReadonlyRunArguments(process.argv.slice(2));
    await Promise.all([checkedPrivateFile(parsed.browserCredentialFile, 'browser credential file'), checkedPrivateFile(parsed.electronConnectionFile, 'electron connection file'),
      stat(parsed.electron), stat(parsed.chromium), stat('/usr/bin/setpriv')]);
    run = await allocateRun();
    const browserBuild = await buildBrowserFixture(run);
    const electronBuild = await buildElectronClosure(run);
    buildBinding = { browser: { bundle: { path: browserBuild.path, sha256: browserBuild.sha256, byteLength: browserBuild.byteLength }, source: browserBuild.source },
      electron: { outdir: electronBuild.outdir, inputHash: electronBuild.inputHash, tools: electronBuild.tools, source: electronBuild.source, outputs: electronBuild.outputs },
      runnerFixtures: await snapshotSources([path.join(root, 'scripts', 'calibration-canonical-readonly-smoke.mjs'), browserFixture, electronFixture]) };
    await writeFile(path.join(run, 'reports', 'source-binding.json'), `${JSON.stringify(buildBinding, null, 2)}\n`, { mode: 0o600 });
    xvfb = await startXvfb();
    browser = await browserProof({ chromium: parsed.chromium, webOrigin: parsed.webOrigin, run, credentialFile: parsed.browserCredentialFile, browserBundle: browserBuild.path, requests });
    electron = await electronProof({ parsed: { ...parsed, preload: electronBuild.outputs['preload.cjs'].path, ipc: electronBuild.outputs['calibration-harness-ipc.js'].path }, run, display: xvfb.display, requests, browserBundle: browserBuild.path });
    const currentBinding = { browser: await snapshotSources(browserBuild.inputs), electron: await snapshotSources(electronBuild.inputs), runnerFixtures: await snapshotSources([path.join(root, 'scripts', 'calibration-canonical-readonly-smoke.mjs'), browserFixture, electronFixture]) };
    if (!sameSnapshots(buildBinding.browser.source, currentBinding.browser) || !sameSnapshots(buildBinding.electron.source, currentBinding.electron) || !sameSnapshots(buildBinding.runnerFixtures, currentBinding.runnerFixtures)) fail('source inputs changed during canonical hydration');
    buildBinding.sourceUnchanged = true;
    const requestProof = assertReadonlyRequestLog(requests);
    const report = createReadonlyReport({ ...parsed, run, browser, electron, requests: requestProof, buildBinding });
    await writeFile(path.join(run, 'reports', 'report.pending-cleanup.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  } catch (error) { failure = redact(error instanceof Error ? error.message : String(error)); }
  finally { if (xvfb?.child) xvfbCleanup = await safeStop(xvfb.child); }
  if (xvfb !== null && xvfbCleanup?.verified !== true && failure === null) failure = redact(`Xvfb owned-process cleanup was not verified: ${JSON.stringify(xvfbCleanup)}`);
  if (run === null) { process.stderr.write(`Q3 canonical readonly validation failed: ${failure ?? 'run allocation failed'}\n`); process.exitCode = 1; return; }
  if (failure !== null) {
    await writeFile(path.join(run, 'reports', 'failure.json'), `${JSON.stringify({ status: 'FAIL', failure, cleanup: { xvfb: xvfbCleanup }, requests: requests.slice(0, 20) }, null, 2)}\n`, { mode: 0o600 });
    process.stderr.write(`Q3 canonical readonly validation failed: ${failure}\n`); process.exitCode = 1; return;
  }
  const pending = JSON.parse(await readFile(path.join(run, 'reports', 'report.pending-cleanup.json'), 'utf8'));
  pending.cleanup = { xvfb: xvfbCleanup }; pending.status = 'PASS';
  const reportFile = path.join(run, 'reports', 'report.json'); await writeFile(reportFile, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: 'PASS', run, report: reportFile })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
