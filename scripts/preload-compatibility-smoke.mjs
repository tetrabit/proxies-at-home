#!/usr/bin/env node
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256Pattern = /^[0-9a-f]{64}$/;
const forbiddenSwitches = ['--no-sandbox', '--disable-setuid-sandbox'];

const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const serialError = (error) => ({ name: error instanceof Error ? error.name : typeof error, code: error?.code ?? null, message: error instanceof Error ? error.message : String(error) });
export const privateNetworkReadOnlyAssertions = 'ip link show lo | grep -q "<LOOPBACK,UP" && test -z "$(ip route show default)" && test -z "$(ip -6 route show default)"';

export function emittedPreloadDependencyGraph(source) {
  const requireSpecifiers = [...source.matchAll(/\brequire\(\s*(['"])([^'"\n]+)\1\s*\)/g)].map((match) => match[2]);
  const unique = [...new Set(requireSpecifiers)];
  const relativeRequireSpecifiers = unique.filter((name) => name.startsWith('./') || name.startsWith('../') || path.isAbsolute(name));
  const unexpectedRequireSpecifiers = unique.filter((name) => name !== 'electron');
  return { requireSpecifiers: unique, relativeRequireSpecifiers, unexpectedRequireSpecifiers, selfContained: relativeRequireSpecifiers.length === 0 && unexpectedRequireSpecifiers.length === 0 };
}

export function rejectSandboxDisablingSwitches(args) {
  const forbidden = args.find((arg) => forbiddenSwitches.some((name) => arg === name || arg.startsWith(`${name}=`)));
  if (forbidden) throw new Error(`forbidden Chromium sandbox switch: ${forbidden}`);
}

export function parseArguments(args) {
  if (args.length !== 4 || args[0] !== '--build-report' || !path.isAbsolute(args[1]) || args[2] !== '--build-report-sha256' || !sha256Pattern.test(args[3])) {
    throw new Error('usage: node scripts/preload-compatibility-smoke.mjs --build-report <absolute-build-report.json> --build-report-sha256 <64-lowercase-hex>; SHA-256 must be explicit');
  }
  return { buildReport: args[1], buildReportSha256: args[3] };
}

function relativeContained(rootPath, target, label) {
  const relative = path.relative(rootPath, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} escaped or was not contained by root`);
  return relative;
}

async function regularContained(rootPath, target, label) {
  const rootReal = await realpath(rootPath);
  const absolute = path.resolve(target);
  const relative = relativeContained(rootReal, absolute, label);
  let current = rootReal;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink: ${current}`);
  }
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular non-symlink file`);
  return absolute;
}

function resolveManifestInput(manifestRoot, entry) {
  if (entry.path.startsWith('$builder/')) return path.join(manifestRoot, entry.path.slice('$builder/'.length));
  if (entry.path.startsWith('$tool/')) return path.join(manifestRoot, 'node_modules', entry.path.slice('$tool/'.length));
  if (entry.path.startsWith('$')) throw new Error(`unsupported manifest control path: ${entry.path}`);
  return path.join(manifestRoot, entry.path);
}

function aggregateInputs(inputs) {
  return createHash('sha256').update(inputs.map((entry) => `${entry.path}\u0000${entry.byteLength}\u0000${entry.sha256}\n`).join('')).digest('hex');
}

function validRecord(entry, label) {
  if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' || !sha256Pattern.test(entry.sha256) || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
    throw new Error(`invalid ${label} manifest record`);
  }
}

export async function validateBuildReport(reportPath, expectedSha256, { repositoryRoot = undefined } = {}) {
  if (!path.isAbsolute(reportPath) || !sha256Pattern.test(expectedSha256)) throw new Error('build report path and SHA-256 must be explicit and syntactically valid');
  const resolvedReport = path.resolve(reportPath);
  const reportParent = path.dirname(resolvedReport);
  await regularContained(reportParent, resolvedReport, 'build report');
  if (await sha256(resolvedReport) !== expectedSha256) throw new Error('build report SHA-256 does not match caller-bound manifest');
  const report = JSON.parse(await readFile(resolvedReport, 'utf8'));
  if (report === null || typeof report !== 'object' || !path.isAbsolute(report.root) || !path.isAbsolute(report.outdir) || !Array.isArray(report.inputs) || !Array.isArray(report.outputs) || !sha256Pattern.test(report.inputHash)) throw new Error('build report shape is invalid');
  const manifestRoot = await realpath(report.root);
  if (repositoryRoot !== undefined && manifestRoot !== await realpath(repositoryRoot)) throw new Error('build report root does not match the caller-bound repository');
  const outdir = path.resolve(report.outdir);
  relativeContained(manifestRoot, outdir, 'build output directory');
  const outdirStat = await lstat(outdir);
  if (!outdirStat.isDirectory() || outdirStat.isSymbolicLink()) throw new Error('build output directory is not a contained non-symlink directory');
  const inputNames = new Set();
  for (const entry of report.inputs) {
    validRecord(entry, 'input');
    if (inputNames.has(entry.path)) throw new Error(`duplicate input record: ${entry.path}`);
    inputNames.add(entry.path);
    const filename = resolveManifestInput(manifestRoot, entry);
    const containedRoot = entry.path.startsWith('$tool/') ? path.join(manifestRoot, 'node_modules') : manifestRoot;
    await regularContained(containedRoot, filename, `manifest input ${entry.path}`);
    const bytes = await readFile(filename);
    if (bytes.byteLength !== entry.byteLength || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`manifest input bytes mismatch: ${entry.path}`);
  }
  const sortedInputs = [...report.inputs].sort((left, right) => left.path.localeCompare(right.path));
  if (aggregateInputs(sortedInputs) !== report.inputHash) throw new Error('manifest aggregate input hash mismatch');
  const outputNames = new Set();
  const outputPaths = new Set();
  for (const entry of report.outputs) {
    validRecord(entry, 'output');
    if (typeof entry.name !== 'string' || entry.name.length === 0 || outputNames.has(entry.name) || outputPaths.has(entry.path)) throw new Error('duplicate or invalid output manifest record');
    outputNames.add(entry.name); outputPaths.add(entry.path);
    const filename = path.resolve(outdir, entry.path);
    await regularContained(outdir, filename, `manifest output ${entry.path}`);
    const bytes = await readFile(filename);
    if (bytes.byteLength !== entry.byteLength || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`manifest output bytes mismatch: ${entry.path}`);
  }
  const preloadEntry = report.outputs.find((entry) => entry.path === 'preload.cjs');
  const ipcEntry = report.outputs.find((entry) => entry.path === 'calibration-harness-ipc.js');
  if (preloadEntry === undefined || ipcEntry === undefined) throw new Error('manifest lacks required emitted preload or IPC output');
  const graph = emittedPreloadDependencyGraph(await readFile(path.join(outdir, preloadEntry.path), 'utf8'));
  if (!graph.selfContained || JSON.stringify(graph.requireSpecifiers) !== JSON.stringify(['electron'])) throw new Error('emitted preload has a non-electron require dependency');
  return { reportPath: resolvedReport, report, manifestRoot, outdir, graph, emitted: { preload: path.join(outdir, preloadEntry.path), ipc: path.join(outdir, ipcEntry.path) } };
}

export function ownedProcessGroupMembers(processGroupId, { execFileSyncFn = execFileSync } = {}) {
  try {
    const output = execFileSyncFn('ps', ['-eo', 'pid=,pgid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const pids = output.split('\n').map((line) => line.trim().split(/\s+/).map(Number)).filter(([pid, group]) => Number.isInteger(pid) && group === processGroupId).map(([pid]) => pid);
    return { supported: true, status: 'known', pids };
  } catch (error) {
    const stdout = Buffer.isBuffer(error?.stdout) ? error.stdout.toString('utf8') : String(error?.stdout ?? '');
    const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : String(error?.stderr ?? '');
    if (error?.status === 1 && stdout.trim() === '' && stderr.trim() === '') return { supported: true, status: 'known', pids: [], source: 'ps-no-matching-process-group' };
    return { supported: true, status: 'unknown', pids: null, error: serialError(error) };
  }
}

async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const [stat, status] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/status`, 'utf8')]);
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const field = (name) => status.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1] ?? null;
    return { pid, pgid: Number(fields[2]), sid: Number(fields[3]), startTime: fields[19] ?? null, uid: field('Uid')?.split(/\s+/)[0] ?? null, gid: field('Gid')?.split(/\s+/)[0] ?? null, seccomp: field('Seccomp'), noNewPrivs: field('NoNewPrivs') };
  } catch (error) {
    return { pid, error: serialError(error) };
  }
}

async function recordedPidAbsence(identities) {
  return Promise.all(identities.filter((entry) => Number.isInteger(entry?.pid) && entry.pid > 0).map(async (entry) => {
    const current = await processIdentity(entry.pid);
    if (current === null || current.error?.code === 'ENOENT') return { pid: entry.pid, status: 'absent' };
    if (current.error !== undefined) return { pid: entry.pid, status: 'unknown', error: current.error };
    if (entry.startTime !== null && current.startTime !== entry.startTime) return { pid: entry.pid, status: 'reused', previous: entry, current };
    return { pid: entry.pid, status: 'present', current };
  }));
}

export function isVerifiedOwnedChildShutdown({ reaped, scan, pidAbsence = [] }) {
  return Boolean(reaped && scan?.supported === true && scan.status === 'known' && Array.isArray(scan.pids) && scan.pids.length === 0 && pidAbsence.every((entry) => entry.status === 'absent' || entry.status === 'reused'));
}

function exitObservation(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode ?? null, alreadyExited: true });
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, alreadyExited: false }))),
    new Promise((resolve) => child.once('error', (error) => resolve({ error: serialError(error), code: null, signal: null, alreadyExited: false }))),
  ]);
}

async function boundedObservation(observation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      observation,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function stopOwned(child, identities, { scan = ownedProcessGroupMembers, pidAbsence = recordedPidAbsence, killFn = (owned, signal) => owned.kill(signal), timeoutMs = 2500 } = {}) {
  if (!child?.pid) return { reaped: false, scan: { supported: true, status: 'unknown', pids: null }, pidAbsence: [], verified: false, failure: 'owned child pid unavailable' };
  let first;
  if (child.exitCode == null && child.signalCode == null) {
    const observed = exitObservation(child);
    killFn(child, 'SIGTERM');
    first = await boundedObservation(observed, timeoutMs);
  } else first = await exitObservation(child);
  let final = first;
  if (final === null && child.exitCode == null && child.signalCode == null) {
    const observed = exitObservation(child);
    killFn(child, 'SIGKILL');
    final = await boundedObservation(observed, timeoutMs);
  }
  const members = scan(child.pid);
  const absences = await pidAbsence(identities);
  const reaped = final !== null && final.error === undefined;
  return { reaped, exit: final, scan: members, pidAbsence: absences, verified: isVerifiedOwnedChildShutdown({ reaped, scan: members, pidAbsence: absences }) };
}

export async function allocateRun(artifactParent, namespace, token = randomUUID()) {
  const parent = path.resolve(artifactParent);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('artifact parent is not a controlled non-symlink directory');
  if (!/^[a-z0-9-]+$/i.test(namespace) || !/^[a-z0-9-]+$/i.test(token)) throw new Error('artifact namespace or token is unsafe');
  const namespacePath = path.join(parent, namespace);
  try { await mkdir(namespacePath, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const namespaceStat = await lstat(namespacePath);
  if (!namespaceStat.isDirectory() || namespaceStat.isSymbolicLink()) throw new Error('artifact namespace is not a controlled non-symlink directory');
  const run = path.join(namespacePath, token);
  try { await mkdir(run, { mode: 0o700 }); } catch (error) { if (error?.code === 'EEXIST') throw new Error(`artifact run collision: ${run}`); throw error; }
  return run;
}

async function namespaceIdentity() {
  const uid = process.getuid?.(); const gid = process.getgid?.();
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0 || gid === 0) throw new Error('private smoke requires a non-root host identity');
  const probe = execFileSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-net', '--uid', String(uid), '--gid', String(gid), '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', '/bin/sh', '-c', `${privateNetworkReadOnlyAssertions} && test "$(id -u)" != 0 && test "$(id -g)" != 0 && id`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { hostUid: uid, hostGid: gid, electronUid: uid, electronGid: gid, mappingProbe: probe };
}

export function bwrapNetworkIsolatedLaunch(electronArgs, electronExecutable, repositoryMount, writableRun, environment, identity) {
  rejectSandboxDisablingSwitches(electronArgs);
  const writableMount = path.join(repositoryMount, path.relative(root, writableRun));
  return { command: '/usr/bin/bwrap', args: [
    '--unshare-user', '--unshare-net', '--uid', String(identity.electronUid), '--gid', String(identity.electronGid), '--cap-drop', 'ALL', '--die-with-parent', '--clearenv',
    '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/var/tmp', '--dir', repositoryMount,
    '--ro-bind', root, repositoryMount, '--bind', writableRun, writableMount, '--bind', '/tmp/.X11-unix', '/tmp/.X11-unix',
    ...Object.entries(environment).flatMap(([key, value]) => ['--setenv', key, value]),
    '--', '/bin/sh', '-c', `${privateNetworkReadOnlyAssertions} && exec setpriv --nnp -- "$@"`,
    'private-preload-ipc-launch', electronExecutable, ...electronArgs,
  ] };
}

async function startPrivateXvfb(onOwned) {
  const child = spawn('/usr/bin/Xvfb', ['-displayfd', '3', '-nolisten', 'tcp', '-screen', '0', '1280x800x24'], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  onOwned(child);
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  let deadline;
  const ready = await Promise.race([
    once(child.stdio[3], 'data').then(([chunk]) => chunk.toString('utf8')),
    once(child, 'exit').then(([code, signal]) => { throw new Error(`Xvfb exited before display readiness (${code ?? signal}): ${stderr}`); }),
    once(child, 'error').then(([error]) => { throw error; }),
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Xvfb displayfd readiness timeout')), 5000); }),
  ]).finally(() => clearTimeout(deadline));
  const display = Number.parseInt(ready.trim(), 10);
  if (!Number.isInteger(display) || display < 1) throw new Error('Xvfb emitted an invalid display number');
  return { child, display: `:${display}`, stdout: () => stdout, stderr: () => stderr };
}

function requireHarnessFields(harness) {
  if (harness?.status !== 'PASS' || harness?.bridge?.exactAllowlist !== true || harness?.ipc?.sixOperations !== true || harness?.ipc?.snapshotCas !== true || harness?.trust?.subframeBridgeAbsent !== true || harness?.trust?.pendingResponseNavigationCancelled !== true || harness?.trust?.registrarDrained !== true || harness?.sandbox?.renderer?.seccomp !== '2' || harness?.sandbox?.renderer?.noNewPrivs !== '1' || !Number.isInteger(harness?.processes?.main?.pid) || !Number.isInteger(harness?.processes?.renderer?.pid) || harness?.cleanup?.verified !== true) throw new Error('harness required runtime fields are missing or not PASS');
}

async function main() {
  const artifactParent = path.join(root, '.review-artifacts');
  let run = null; let xvfb = null; let electron = null; let failure = null; let preflight = null; let harnessReport = null; let electronOutcome = null; let xvfbOutcome = null; let stdout = ''; let stderr = ''; let launch = null; let identities = [];
  try {
    const input = parseArguments(process.argv.slice(2));
    run = await allocateRun(artifactParent, 'preload-compatibility-native', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
    preflight = await validateBuildReport(input.buildReport, input.buildReportSha256, { repositoryRoot: root });
    const profile = path.join(run, 'retained-profile');
    await mkdir(profile, { mode: 0o700 });
    for (const entry of ['home', 'xdg-config', 'xdg-cache', 'xdg-runtime', 'user-data', 'crash']) await mkdir(path.join(profile, entry), { mode: 0o700 });
    const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron');
    const electronStat = await lstat(electronExecutable);
    if (process.platform !== 'linux' || !electronStat.isFile() || electronStat.isSymbolicLink()) throw new Error('Linux installed Electron executable is unavailable');
    const identity = await namespaceIdentity();
    xvfb = await startPrivateXvfb((child) => { xvfb = { child }; });
    const repositoryMount = '/var/tmp/repository';
    const sandboxPath = (file) => path.join(repositoryMount, path.relative(root, file));
    const harnessPath = sandboxPath(path.join(root, 'scripts', 'preload-compatibility-harness.mjs'));
    const reportPath = path.join(run, 'harness-report.json');
    const args = ['--disable-gpu', '--no-proxy-server', '--ozone-platform=x11', `--user-data-dir=${sandboxPath(path.join(profile, 'user-data'))}`, harnessPath, `--preload=${sandboxPath(preflight.emitted.preload)}`, `--ipc=${sandboxPath(preflight.emitted.ipc)}`, `--user-data=${sandboxPath(path.join(profile, 'user-data'))}`, `--fixture-dir=${sandboxPath(run)}`, `--report-file=${sandboxPath(reportPath)}`];
    rejectSandboxDisablingSwitches(args);
    const childEnv = { PATH: process.env.PATH, HOME: sandboxPath(path.join(profile, 'home')), XDG_CONFIG_HOME: sandboxPath(path.join(profile, 'xdg-config')), XDG_CACHE_HOME: sandboxPath(path.join(profile, 'xdg-cache')), XDG_RUNTIME_DIR: sandboxPath(path.join(profile, 'xdg-runtime')), DISPLAY: xvfb.display, ELECTRON_DISABLE_GPU: '1', LIBGL_ALWAYS_SOFTWARE: '1' };
    launch = bwrapNetworkIsolatedLaunch(args, sandboxPath(electronExecutable), repositoryMount, run, childEnv, identity);
    await writeFile(path.join(run, 'command.json'), `${JSON.stringify({ cwd: root, command: launch.command, args: launch.args, environmentKeys: Object.keys(childEnv).sort(), privateDisplay: xvfb.display }, null, 2)}\n`);
    electron = spawn(launch.command, launch.args, { cwd: run, detached: true, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    electron.stdout.on('data', (chunk) => { stdout += chunk; }); electron.stderr.on('data', (chunk) => { stderr += chunk; });
    const launcherIdentity = await processIdentity(electron.pid); identities = [launcherIdentity].filter(Boolean);
    const finished = await boundedObservation(exitObservation(electron), 25000);
    if (finished === null) electronOutcome = await stopOwned(electron, identities); else electronOutcome = { reaped: finished.error === undefined, exit: finished, scan: ownedProcessGroupMembers(electron.pid), pidAbsence: [], verified: false };
    harnessReport = JSON.parse(await readFile(reportPath, 'utf8'));
    requireHarnessFields(harnessReport);
    identities.push(harnessReport.processes.main, harnessReport.processes.renderer);
    const pidAbsence = await recordedPidAbsence(identities);
    electronOutcome = { ...electronOutcome, runtimeIdentities: identities, pidAbsence, verified: electronOutcome.reaped && isVerifiedOwnedChildShutdown({ reaped: electronOutcome.reaped, scan: electronOutcome.scan, pidAbsence }) };
    if (finished === null || finished.code !== 0 || !electronOutcome.verified) throw new Error('actual Electron process completion or identity-aware cleanup failed');
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (electron?.pid && electron.exitCode == null && electron.signalCode == null) electronOutcome = await stopOwned(electron, identities);
  } finally {
    if (xvfb?.child) xvfbOutcome = await stopOwned(xvfb.child, [await processIdentity(xvfb.child.pid)].filter(Boolean));
    if (run !== null) {
      await writeFile(path.join(run, 'electron.stdout.log'), stdout);
      await writeFile(path.join(run, 'electron.stderr.log'), stderr);
    }
  }
  const status = failure === null && xvfbOutcome?.verified === true ? 'PASS' : 'FAIL';
  if (run === null) {
    console.log(JSON.stringify({ status: 'FAIL', reportPath: null, reportSha256: null, failure }, null, 2));
    process.exitCode = 1;
    return;
  }
  const reportPath = path.join(run, 'report.json');
  const report = { schema: 'td-06d5fb-private-xvfb-preload-ipc-smoke/v2', status, failure, command: { cwd: root, argv: process.argv.slice(1) }, preflight: preflight && { reportPath: preflight.reportPath, reportSha256: await sha256(preflight.reportPath), inputHash: preflight.report.inputHash, outdir: preflight.outdir, graph: preflight.graph, emitted: preflight.emitted }, scripts: Object.fromEntries(await Promise.all(['scripts/preload-compatibility-smoke.mjs', 'scripts/preload-compatibility-smoke.test.mjs', 'scripts/preload-compatibility-harness.mjs', 'scripts/fixtures/preload-ipc-fixture.mjs'].map(async (name) => [name, await sha256(path.join(root, name))]))), processes: { electron: electronOutcome, xvfb: xvfbOutcome }, harnessReport, retainedProfile: path.join(run, 'retained-profile'), logs: { stdout: path.join(run, 'electron.stdout.log'), stderr: path.join(run, 'electron.stderr.log'), command: path.join(run, 'command.json') } };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, reportPath, reportSha256: await sha256(reportPath), failure }, null, 2));
  process.exitCode = status === 'PASS' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
