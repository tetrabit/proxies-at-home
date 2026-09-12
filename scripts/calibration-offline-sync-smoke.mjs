#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { buildSharedSyncService, sourceBinding } from './calibration-shared-sync-smoke.mjs';
import {
  bwrapNetworkIsolatedLaunch,
  ownedProcessGroupMembers,
  stopOwned,
  validateBuildReport,
} from './preload-compatibility-smoke.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactParent = path.join(root, '.review-artifacts', 'task-completion-1bc8140c4bff4f698267aaef96c44f34', 'td-b7731f');
const buildTimeoutMs = 30_000;
const runnerTimeoutMs = 120_000;
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const redact = value => String(value).replace(/calibration_pair_[A-Za-z0-9_-]+/g, '[REDACTED_CALIBRATION_CREDENTIAL]');

export function parseOfflineRunArguments(args) {
  if (args.length === 0) return { runtime: true };
  throw new Error('usage: node scripts/calibration-offline-sync-smoke.mjs');
}

export function stableLoopbackOrigin(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError('stable loopback port must be a positive TCP port');
  return `http://127.0.0.1:${port}`;
}

export function serviceSeedDisposition(revision) {
  if (revision === null) return 'seed';
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('revision must be null or positive');
  return 'preserve';
}

function bounded(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function exclusiveRun() {
  await mkdir(artifactParent, { recursive: true, mode: 0o700 });
  const parent = await realpath(artifactParent);
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Q2 artifact parent is unavailable');
  const run = path.join(parent, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  try { await mkdir(run, { mode: 0o700 }); }
  catch (error) { if (error?.code === 'EEXIST') throw new Error(`Q2 artifact run collision: ${run}`); throw error; }
  await mkdir(path.join(run, 'reports'), { mode: 0o700 });
  return run;
}

function track(command, args, options, label) {
  const child = spawn(command, args, options);
  let stdout = ''; let stderr = ''; let error = null;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const failed = new Promise((_, reject) => child.once('error', value => { error = value; reject(value); }));
  child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8'); });
  return {
    child, label,
    get stdout() { return stdout; }, get stderr() { return stderr; },
    async wait(timeoutMs) {
      try {
        const result = await bounded(Promise.race([exited, failed]), timeoutMs, `${label} exit`);
        if (error) throw error;
        return result;
      } catch (failure) { throw new Error(`${label}: ${redact(failure?.message ?? failure)}`); }
    },
  };
}

async function startPrivateXvfb() {
  const child = spawn('/usr/bin/Xvfb', ['-displayfd', '3', '-nolisten', 'tcp', '-screen', '0', '1280x800x24'], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH },
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  const value = await bounded(Promise.race([
    once(child.stdio[3], 'data').then(([chunk]) => chunk.toString('utf8')),
    once(child, 'error').then(([error]) => { throw error; }),
    once(child, 'exit').then(([code, signal]) => { throw new Error(`private Xvfb exited before readiness (${code ?? signal}): ${stderr}`); }),
  ]), 5_000, 'private Xvfb readiness');
  const display = `:${Number.parseInt(value.trim(), 10)}`;
  if (!/^:[1-9][0-9]*$/.test(display)) throw new Error('private Xvfb reported an unsafe display');
  return { child, display };
}

async function namespaceIdentity() {
  const uid = process.getuid?.(); const gid = process.getgid?.();
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0 || gid === 0) throw new Error('Q2 requires a non-root host identity');
  return { electronUid: uid, electronGid: gid };
}

async function main() {
  const run = await exclusiveRun(); const reports = path.join(run, 'reports');
  const sources = [
    'scripts/calibration-offline-sync-smoke.mjs',
    'scripts/calibration-offline-sync-smoke.test.mjs',
    'scripts/fixtures/calibration-shared-sync-service.ts',
    'scripts/fixtures/calibration-shared-sync-restart-electron.mjs',
    'scripts/fixtures/calibration-shared-sync-restart-runner.mjs',
    'scripts/fixtures/calibration-shared-sync-restart-browser.mjs',
    'scripts/fixtures/calibration-shared-sync-restart-browser.test.mjs',
    'scripts/calibration-shared-sync-smoke.mjs',
  ];
  const sourcesBefore = await sourceBinding(sources);
  await writeFile(path.join(reports, 'source-binding.json'), JSON.stringify(sourcesBefore, null, 2));
  await writeFile(path.join(reports, 'source-hashes.json'), `${JSON.stringify(Object.fromEntries(await Promise.all(sources.map(async item => [item, await sha256(path.join(root, item))]))), null, 2)}\n`, { mode: 0o600 });
  let xvfb = null; let launchTrack = null; let launchOutcome = null; let xvfbOutcome = null; let failure = null; let preflight = null; let buildOutcome = null;
  try {
    const build = track(process.execPath, [path.join(root, 'scripts/build-electron-main.mjs'), '--outdir', path.join(run, 'electron-build')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }, 'Q2 Electron build');
    buildOutcome = await build.wait(buildTimeoutMs);
    await writeFile(path.join(reports, 'build.stdout.log'), redact(build.stdout), { mode: 0o600 });
    await writeFile(path.join(reports, 'build.stderr.log'), redact(build.stderr), { mode: 0o600 });
    if (buildOutcome.code !== 0) throw new Error(`Q2 Electron build failed: ${redact(build.stderr)}`);
    const buildReport = path.join(reports, 'build-report.json');
    await writeFile(buildReport, build.stdout, { mode: 0o600 });
    preflight = await validateBuildReport(buildReport, await sha256(buildReport), { repositoryRoot: root });
    const service = await buildSharedSyncService({ root, run });
    xvfb = await startPrivateXvfb();
    const identity = await namespaceIdentity();
    const mount = '/var/tmp/repository';
    const mapped = filename => path.join(mount, path.relative(root, filename));
    const profile = path.join(run, 'electron-profile');
    for (const item of ['home', 'config', 'cache', 'runtime', 'user-data']) await mkdir(path.join(profile, item), { recursive: true, mode: 0o700 });
    const environment = {
      PATH: process.env.PATH,
      HOME: mapped(path.join(profile, 'home')),
      XDG_CONFIG_HOME: mapped(path.join(profile, 'config')),
      XDG_CACHE_HOME: mapped(path.join(profile, 'cache')),
      XDG_RUNTIME_DIR: mapped(path.join(profile, 'runtime')),
      TMPDIR: '/var/tmp',
      DISPLAY: xvfb.display,
      ELECTRON_DISABLE_GPU: '1',
      LIBGL_ALWAYS_SOFTWARE: '1',
    };
    const args = [
      mapped(path.join(root, 'scripts/fixtures/calibration-shared-sync-restart-runner.mjs')),
      `--root=${mount}`, `--run=${mapped(run)}`, `--service=${mapped(service.servicePath)}`, `--node=${service.nodeExecutable}`,
      `--electron=${mapped(path.join(root, 'node_modules/electron/dist/electron'))}`,
      `--chromium=${chromium.executablePath()}`,
      `--preload=${mapped(preflight.emitted.preload)}`, `--ipc=${mapped(preflight.emitted.ipc)}`,
    ];
    const launch = bwrapNetworkIsolatedLaunch(args, service.nodeExecutable, mount, run, environment, identity);
    await writeFile(path.join(reports, 'namespace-launch.json'), `${JSON.stringify({ command: launch.command, args: launch.args, environmentKeys: Object.keys(environment).sort(), privateDisplay: xvfb.display, uid: identity.electronUid, gid: identity.electronGid }, null, 2)}\n`, { mode: 0o600 });
    launchTrack = track(launch.command, launch.args, { cwd: run, detached: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] }, 'Q2 private namespace runner');
    const exit = await launchTrack.wait(runnerTimeoutMs);
    await writeFile(path.join(reports, 'runner.stdout.log'), redact(launchTrack.stdout), { mode: 0o600 });
    await writeFile(path.join(reports, 'runner.stderr.log'), redact(launchTrack.stderr), { mode: 0o600 });
    launchOutcome = { exit, reaped: exit.code === 0, scan: ownedProcessGroupMembers(launchTrack.child.pid) };
    launchOutcome.verified = launchOutcome.reaped && launchOutcome.scan.status === 'known' && launchOutcome.scan.pids.length === 0;
    if (exit.code !== 0 || !launchOutcome.verified) throw new Error(`Q2 private runner failed: ${redact(launchTrack.stderr)}`);
    const inner = JSON.parse(await readFile(path.join(reports, 'inner-report.json'), 'utf8'));
    if (inner.status !== 'PASS') throw new Error(`Q2 inner runner failed: ${inner.failure}`);
    if (JSON.stringify(sourcesBefore) !== JSON.stringify(await sourceBinding(sources))) throw new Error('Q2 source inputs changed during runtime');
  } catch (error) {
    failure = redact(error?.stack ?? error);
    if (launchTrack?.child.pid && launchTrack.child.exitCode === null && launchTrack.child.signalCode === null) {
      launchOutcome = await stopOwned(launchTrack.child, [], { killFn: (child, signal) => {
        try { process.kill(-child.pid, signal); } catch (killError) { if (killError?.code !== 'ESRCH') throw killError; }
      } });
    }
  } finally {
    if (xvfb?.child) xvfbOutcome = await stopOwned(xvfb.child, [], { killFn: (child, signal) => {
      try { process.kill(-child.pid, signal); } catch (killError) { if (killError?.code !== 'ESRCH') throw killError; }
    } });
  }
  const report = {
    schema: 'td-b7731f-offline-restart-q2/v2', status: failure === null && xvfbOutcome?.verified === true ? 'PASS' : 'FAIL', failure, run,
    build: preflight && { exit: buildOutcome, inputHash: preflight.report.inputHash, outputs: preflight.report.outputs },
    processes: { namespaceRunner: launchOutcome, xvfb: xvfbOutcome },
    logs: { launch: path.join(reports, 'namespace-launch.json'), runnerStdout: path.join(reports, 'runner.stdout.log'), runnerStderr: path.join(reports, 'runner.stderr.log') },
  };
  const reportPath = path.join(reports, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, reportPath, failure }, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(parseOfflineRunArguments(process.argv.slice(2)));
