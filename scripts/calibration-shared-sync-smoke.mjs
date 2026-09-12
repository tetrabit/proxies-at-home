#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { build as esbuild } from 'esbuild';

import {
  bwrapNetworkIsolatedLaunch,
  ownedProcessGroupMembers,
  stopOwned,
  validateBuildReport,
} from './preload-compatibility-smoke.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactParent = path.join(root, '.review-artifacts', 'task-completion-1bc8140c4bff4f698267aaef96c44f34');
export const artifactNamespace = 'td-d361f7';
const serviceStartupTimeoutMs = 8_000;
const buildTimeoutMs = 30_000;

const sha256 = async (filename) => createHash('sha256').update(await readFile(filename)).digest('hex');
const redact = (value) => String(value).replace(/calibration_pair_[A-Za-z0-9_-]{43}/g, '[REDACTED_CALIBRATION_CREDENTIAL]');

export function parseRunArguments(args) {
  if (args.length === 0) return { startupOnly: false };
  if (args.length === 1 && args[0] === '--startup-only') return { startupOnly: true };
  throw new Error('usage: node scripts/calibration-shared-sync-smoke.mjs [--startup-only]');
}

export function isSafeOwnedRun(rootPath, candidate) {
  try {
    const relative = path.relative(path.resolve(rootPath), path.resolve(candidate));
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

export function isSafeLaunchArguments(args) {
  return Array.isArray(args) && !args.some((value) => (
    typeof value !== 'string'
    || value === '--no-sandbox'
    || value.startsWith('--no-sandbox=')
    || value === '--disable-setuid-sandbox'
    || value.startsWith('--disable-setuid-sandbox=')
  ));
}

async function exclusiveRun() {
  const parent = await realpath(artifactParent);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('authorized evidence parent unavailable');
  const namespace = path.join(parent, artifactNamespace);
  await mkdir(namespace, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const namespaceStat = await lstat(namespace);
  if (!namespaceStat.isDirectory() || namespaceStat.isSymbolicLink()) throw new Error('authorized evidence namespace unavailable');
  const run = path.join(namespace, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  await mkdir(run, { mode: 0o700 });
  return run;
}

function bounded(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function trackChild(command, args, options, label) {
  const child = spawn(command, args, options);
  let stdout = '';
  let stderr = '';
  let spawnError = null;
  let exited = null;
  const exit = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    });
  });
  child.once('error', (error) => { spawnError = error; });
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  return {
    child,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    async waitExit(timeoutMs) {
      const outcome = await bounded(exit, timeoutMs, `${label} exit`);
      if (spawnError !== null) throw new Error(`${label} spawn error: ${redact(spawnError.message)}`);
      return outcome;
    },
  };
}

async function startXvfb() {
  const child = spawn('/usr/bin/Xvfb', ['-displayfd', '3', '-nolisten', 'tcp', '-screen', '0', '1280x800x24'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const readiness = Promise.race([
    once(child.stdio[3], 'data').then(([chunk]) => chunk.toString('utf8')),
    once(child, 'error').then(([error]) => { throw error; }),
    once(child, 'exit').then(([code, signal]) => { throw new Error(`owned Xvfb exited before readiness (${code ?? signal}): ${stderr}`); }),
  ]);
  const displayValue = await bounded(readiness, 5_000, 'owned Xvfb readiness');
  const display = `:${Number.parseInt(displayValue.trim(), 10)}`;
  if (!/^:[1-9][0-9]*$/.test(display)) throw new Error('invalid private Xvfb display');
  return { child, display };
}

/** Builds a CJS service closure so native better-sqlite3 resolves through an explicit, owned runtime module path. */
export async function buildSharedSyncService({ root: repositoryRoot = root, run }) {
  if (!isSafeOwnedRun(path.join(repositoryRoot, '.review-artifacts'), run)) throw new Error('service output must be in a repository-local artifact run');
  const servicePath = path.join(run, 'calibration-shared-sync-service.cjs');
  await esbuild({
    entryPoints: [path.join(repositoryRoot, 'scripts/fixtures/calibration-shared-sync-service.ts')],
    outfile: servicePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['better-sqlite3', 'express', 'vite'],
    logLevel: 'silent',
  });
  return {
    servicePath,
    nodeExecutable: process.execPath,
    environment: {
      NODE_PATH: [path.join(repositoryRoot, 'server', 'node_modules'), path.join(repositoryRoot, 'node_modules')].join(path.delimiter),
    },
  };
}

export async function sourceBinding(scripts) {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'client/src', 'server/src', 'shared', 'client/package.json', 'client/package-lock.json', 'server/package.json', 'server/package-lock.json'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const inputs = Object.fromEntries(await Promise.all([...new Set([...tracked, ...scripts])].sort().map(async name => [name, await sha256(path.join(root, name))])));
  return { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), inputs };
}

async function main({ startupOnly }) {
  const run = await exclusiveRun();
  const reports = path.join(run, 'reports');
  const build = path.join(run, 'electron-build');
  await mkdir(reports, { mode: 0o700 });

  const scripts = [
    'scripts/calibration-shared-sync-smoke.mjs',
    'scripts/calibration-shared-sync-smoke.test.mjs',
    'scripts/fixtures/calibration-shared-sync-service.ts',
    'scripts/fixtures/calibration-shared-sync-electron.mjs',
    'scripts/fixtures/calibration-shared-sync-browser.mjs',
    'scripts/fixtures/calibration-shared-sync-browser.test.mjs',
  ];
  const sourcesBefore = await sourceBinding(scripts);
  await writeFile(path.join(reports, 'source-binding.json'), JSON.stringify(sourcesBefore, null, 2));
  let buildExit = null;
  let preflight = null;
  let electronOutcome = null;
  let xvfbOutcome = null;
  let electronStdout = '';
  let electronStderr = '';
  let failure = null;
  let xvfb = null;
  let electron = null;

  try {
    const buildChild = trackChild(process.execPath, [path.join(root, 'scripts/build-electron-main.mjs'), '--outdir', build], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    }, 'isolated Electron build');
    buildExit = await buildChild.waitExit(buildTimeoutMs);
    await writeFile(path.join(reports, 'build.stdout.log'), redact(buildChild.stdout), { mode: 0o600 });
    await writeFile(path.join(reports, 'build.stderr.log'), redact(buildChild.stderr), { mode: 0o600 });
    if (buildExit.code !== 0) throw new Error(`isolated Electron build failed: ${redact(buildChild.stderr)}`);
    const buildReportPath = path.join(reports, 'build-report.json');
    await writeFile(buildReportPath, buildChild.stdout, { mode: 0o600 });
    preflight = await validateBuildReport(buildReportPath, await sha256(buildReportPath), { repositoryRoot: root });

    const serviceRuntime = await buildSharedSyncService({ root, run });
    xvfb = await startXvfb();
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0 || gid === 0) throw new Error('non-root runtime identity required');

    const mount = '/var/tmp/repository';
    const mapped = (filename) => path.join(mount, path.relative(root, filename));
    const reportFile = path.join(run, 'reports', 'electron-report.json');
    const nodePath = [path.join(mount, 'server', 'node_modules'), path.join(mount, 'node_modules')].join(path.delimiter);
    const args = [
      '--disable-gpu',
      '--no-proxy-server',
      '--ozone-platform=x11',
      `--user-data-dir=${mapped(path.join(run, 'electron-profile/user-data'))}`,
      mapped(path.join(root, 'scripts/fixtures/calibration-shared-sync-electron.mjs')),
      `--root=${mount}`,
      `--run=${mapped(run)}`,
      `--service=${mapped(serviceRuntime.servicePath)}`,
      `--node=${serviceRuntime.nodeExecutable}`,
      `--node-path=${nodePath}`,
      `--chromium=${chromium.executablePath()}`,
      `--preload=${mapped(preflight.emitted.preload)}`,
      `--ipc=${mapped(preflight.emitted.ipc)}`,
      `--report-file=${mapped(reportFile)}`,
      ...(startupOnly ? ['--startup-only'] : []),
    ];
    if (!isSafeLaunchArguments(args)) throw new Error('unsafe Electron launch arguments');
    const environment = {
      PATH: process.env.PATH,
      HOME: mapped(path.join(run, 'electron-profile/home')),
      XDG_CONFIG_HOME: mapped(path.join(run, 'electron-profile/config')),
      XDG_CACHE_HOME: mapped(path.join(run, 'electron-profile/cache')),
      XDG_RUNTIME_DIR: mapped(path.join(run, 'electron-profile/runtime')),
      DISPLAY: xvfb.display,
      ELECTRON_DISABLE_GPU: '1',
      LIBGL_ALWAYS_SOFTWARE: '1',
    };
    for (const name of ['home', 'config', 'cache', 'runtime']) {
      await mkdir(path.join(run, 'electron-profile', name), { recursive: true, mode: 0o700 });
    }
    const launch = bwrapNetworkIsolatedLaunch(args, mapped(path.join(root, 'node_modules/electron/dist/electron')), mount, run, environment, { electronUid: uid, electronGid: gid });
    await writeFile(path.join(reports, 'launch.json'), `${JSON.stringify({ command: launch.command, args: launch.args, environmentKeys: Object.keys(environment).sort(), privateDisplay: xvfb.display }, null, 2)}\n`, { mode: 0o600 });
    electron = trackChild(launch.command, launch.args, { cwd: run, detached: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] }, 'sandboxed Electron Q1');
    const exit = await electron.waitExit(startupOnly ? serviceStartupTimeoutMs : 60_000);
    electronStdout = redact(electron.stdout);
    electronStderr = redact(electron.stderr);
    electronOutcome = {
      reaped: exit.code === 0,
      exit,
      scan: ownedProcessGroupMembers(electron.child.pid),
      verified: exit.code === 0 && ownedProcessGroupMembers(electron.child.pid).status === 'known' && ownedProcessGroupMembers(electron.child.pid).pids.length === 0,
    };
    if (exit.code !== 0 || !electronOutcome.verified) throw new Error(`sandboxed Electron Q1 failed: ${electronStderr}`);

    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    const startupEvidence = report.status === 'PASS'
      && report.outcome?.sandbox?.renderer?.seccomp === '2'
      && report.outcome?.sandbox?.renderer?.noNewPrivs === '1'
      && report.outcome?.profile?.distinct === true
      && report.outcome?.config?.mode === 0o600
      && report.outcome?.service?.ready === true
      && report.outcome?.startupOnly === true;
    const fullEvidence = report.outcome?.browserSeed?.status === 'PASS'
      && report.outcome?.electronResult?.status === 'PASS'
      && report.outcome?.browserObserve?.status === 'PASS';
    const runtimeSafety = report.outcome?.sandbox?.renderer?.seccomp === '2'
      && report.outcome?.sandbox?.renderer?.noNewPrivs === '1'
      && report.outcome?.profile?.distinct === true && report.outcome?.config?.mode === 0o600
      && report.cleanup?.verified === true;
    if (!(startupOnly ? startupEvidence : runtimeSafety && report.status === 'PASS' && fullEvidence
      && report.outcome.browserSeed.shutdown?.verified === true && report.outcome.browserObserve.shutdown?.verified === true)) {
      throw new Error('Q1 renderer/service lifecycle report lacks required acceptance evidence');
    }
    if (JSON.stringify(sourcesBefore) !== JSON.stringify(await sourceBinding(scripts))) throw new Error('Q1 source inputs changed during runtime');
  } catch (error) {
    failure = redact(error instanceof Error ? error.message : String(error));
    if (electron?.child.pid && electron.child.exitCode === null && electron.child.signalCode === null) {
      electronOutcome = await stopOwned(electron.child, [], {
        killFn: (child, signal) => {
          try { process.kill(-child.pid, signal); } catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
        },
      });
    }
  } finally {
    if (xvfb?.child) xvfbOutcome = await stopOwned(xvfb.child, [], {
      killFn: (child, signal) => {
        try { process.kill(-child.pid, signal); } catch (killError) { if (killError.code !== 'ESRCH') throw killError; }
      },
    });
    await writeFile(path.join(reports, 'electron.stdout.log'), electronStdout, { mode: 0o600 });
    await writeFile(path.join(reports, 'electron.stderr.log'), electronStderr, { mode: 0o600 });
  }

  const buildReportPath = path.join(reports, 'build-report.json');
  const status = failure === null && xvfbOutcome?.verified === true ? 'PASS' : 'FAIL';
  const reportPath = path.join(reports, 'report.json');
  const report = {
    schema: 'td-d361f7-browser-electron-shared-sync-q1/v1',
    status,
    failure,
    run,
    sourceHash: createHash('sha256').update(JSON.stringify({ scripts: Object.fromEntries(await Promise.all(scripts.map(async (name) => [name, await sha256(path.join(root, name))]))), electronInputHash: preflight?.report.inputHash ?? null })).digest('hex'),
    scripts: Object.fromEntries(await Promise.all(scripts.map(async (name) => [name, await sha256(path.join(root, name))]))),
    build: preflight === null ? null : {
      command: [process.execPath, 'scripts/build-electron-main.mjs', '--outdir', build],
      exit: buildExit,
      reportPath: buildReportPath,
      reportSha256: await sha256(buildReportPath),
      inputHash: preflight.report.inputHash,
      outdir: build,
      outputs: preflight.report.outputs,
    },
    processes: { electron: electronOutcome, xvfb: xvfbOutcome },
    logs: {
      stdout: path.join(reports, 'electron.stdout.log'),
      stderr: path.join(reports, 'electron.stderr.log'),
      launch: path.join(reports, 'launch.json'),
    },
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status, reportPath, reportSha256: await sha256(reportPath), failure }, null, 2));
  if (status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(parseRunArguments(process.argv.slice(2)));
}
