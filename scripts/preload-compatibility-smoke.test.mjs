import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  allocateRun,
  bwrapNetworkIsolatedLaunch,
  emittedPreloadDependencyGraph,
  isVerifiedOwnedChildShutdown,
  ownedProcessGroupMembers,
  parseArguments,
  rejectSandboxDisablingSwitches,
  stopOwned,
  validateBuildReport,
} from './preload-compatibility-smoke.mjs';
import { createPreloadIpcFixture } from './fixtures/preload-ipc-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactParent = path.join(root, '.review-artifacts');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function syntheticManifest() {
  const base = await allocateRun(artifactParent, 'preload-smoke-unit', `manifest-${randomUUID()}`);
  const outdir = path.join(base, 'out');
  await mkdir(outdir, { mode: 0o700 });
  const sourcePath = path.join(base, 'source.txt');
  const outputPath = path.join(outdir, 'preload.cjs');
  const ipcPath = path.join(outdir, 'calibration-harness-ipc.js');
  await writeFile(sourcePath, 'source');
  await writeFile(outputPath, "require('electron');");
  await writeFile(ipcPath, 'export {}');
  const source = await readFile(sourcePath);
  const output = await readFile(outputPath);
  const ipc = await readFile(ipcPath);
  const inputs = [{ path: 'source.txt', sha256: sha256(source), byteLength: source.byteLength }];
  const inputHash = sha256(`source.txt\u0000${source.byteLength}\u0000${sha256(source)}\n`);
  const report = { root: base, outdir, inputHash, inputs, outputs: [{ name: 'preload.cjs', path: 'preload.cjs', sha256: sha256(output), byteLength: output.byteLength }, { name: 'calibration-harness-ipc.js', path: 'calibration-harness-ipc.js', sha256: sha256(ipc), byteLength: ipc.byteLength }] };
  const reportPath = path.join(base, 'report.json');
  await writeFile(reportPath, JSON.stringify(report));
  return { base, outdir, reportPath, reportSha256: sha256(await readFile(reportPath)) };
}

function fakeChild({ pid = 4242, exitCode = null, signalCode = null } = {}) {
  const listeners = new Map();
  return {
    pid,
    exitCode,
    signalCode,
    once(event, listener) { listeners.set(event, listener); },
    emit(event, ...args) { listeners.get(event)?.(...args); },
  };
}

const knownEmpty = () => ({ supported: true, status: 'known', pids: [] });
const absent = (identities) => identities.map((identity) => ({ pid: typeof identity === 'number' ? identity : identity.pid, status: 'absent' }));

test('emittedPreloadDependencyGraph rejects a split preload helper', () => {
  const graph = emittedPreloadDependencyGraph("const { contextBridge } = require('electron'); require('./preload-api.js');");
  assert.deepEqual(graph.requireSpecifiers, ['electron', './preload-api.js']);
  assert.equal(graph.selfContained, false);
});

test('ownedProcessGroupMembers records ps failures as unknown instead of empty', () => {
  const error = Object.assign(new Error('ps unavailable'), { code: 'ENOENT' });
  const observation = ownedProcessGroupMembers(4242, { execFileSyncFn: () => { throw error; } });
  assert.equal(observation.status, 'unknown');
  assert.equal(observation.pids, null);
});

test('ownedProcessGroupMembers recognizes a no-selection scan as known empty', () => {
  const error = Object.assign(new Error('Command failed: ps'), { status: 1, stdout: '', stderr: '' });
  assert.deepEqual(ownedProcessGroupMembers(4242, { execFileSyncFn: () => { throw error; } }), { supported: true, status: 'known', pids: [], source: 'ps-no-matching-process-group' });
});

test('isVerifiedOwnedChildShutdown requires reaping, known-empty scan, and absent recorded PIDs', () => {
  assert.equal(isVerifiedOwnedChildShutdown({ reaped: true, scan: { supported: true, status: 'known', pids: [] }, pidAbsence: [{ status: 'absent' }] }), true);
  assert.equal(isVerifiedOwnedChildShutdown({ reaped: false, scan: { supported: true, status: 'known', pids: [] }, pidAbsence: [{ status: 'absent' }] }), false);
  assert.equal(isVerifiedOwnedChildShutdown({ reaped: true, scan: { supported: true, status: 'unknown', pids: null }, pidAbsence: [{ status: 'absent' }] }), false);
});

test('unsafe arguments are rejected before launch construction', () => {
  assert.throws(() => parseArguments([]), /usage:/);
  assert.throws(() => parseArguments(['--build-report', '/x', '--build-report-sha256', 'not-a-hash']), /SHA-256/);
  assert.throws(() => rejectSandboxDisablingSwitches(['--no-sandbox=value']), /forbidden Chromium sandbox switch/);
  assert.throws(() => rejectSandboxDisablingSwitches(['--disable-setuid-sandbox']), /forbidden Chromium sandbox switch/);
});

test('private bwrap launcher asserts already-UP loopback and routes without privileged mutation', () => {
  const launch = bwrapNetworkIsolatedLaunch(['--disable-gpu'], '/repo/electron', '/var/tmp/repository', '/repo/.review-artifacts/run', { PATH: '/usr/bin' }, { electronUid: 1000, electronGid: 1000 });
  assert.equal(launch.command, '/usr/bin/bwrap');
  assert.equal(launch.args.includes('--cap-drop'), true);
  assert.equal(launch.args[launch.args.indexOf('--cap-drop') + 1], 'ALL');
  const command = launch.args[launch.args.indexOf('-c') + 1];
  assert.doesNotMatch(command, /ip link set lo up/);
  assert.match(command, /ip link show lo \| grep -q "<LOOPBACK,UP"/);
  assert.match(command, /ip route show default/);
  assert.match(command, /ip -6 route show default/);
});

test('validateBuildReport accepts a caller-bound synthetic manifest and rejects output escapes', async () => {
  const fixture = await syntheticManifest();
  const accepted = await validateBuildReport(fixture.reportPath, fixture.reportSha256);
  assert.equal(accepted.report.outdir, fixture.outdir);
  const report = JSON.parse(await readFile(fixture.reportPath, 'utf8'));
  report.outputs[0].path = '../escape';
  await writeFile(fixture.reportPath, JSON.stringify(report));
  await assert.rejects(validateBuildReport(fixture.reportPath, sha256(await readFile(fixture.reportPath))), /escaped|contained/);
});

test('allocateRun rejects a symlink and collision while preserving a parent sentinel', async () => {
  const base = await allocateRun(artifactParent, 'preload-smoke-unit', `allocation-${randomUUID()}`);
  const sentinel = path.join(base, 'sentinel');
  const link = path.join(base, 'linked-parent');
  await writeFile(sentinel, 'preserve');
  await symlink(base, link);
  await assert.rejects(allocateRun(link, 'runs', 'fixed'), /non-symlink/);
  const first = await allocateRun(base, 'runs', 'fixed');
  await assert.rejects(allocateRun(base, 'runs', 'fixed'), /collision/);
  const second = await allocateRun(base, 'runs', 'second');
  assert.notEqual(first, second);
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
});

test('faithful HTTP fixture preserves create-only/current/stale CAS and exact binary bytes', async () => {
  const fixture = createPreloadIpcFixture({ credential: `unit_${randomUUID()}`, harnessId: 'unit-harness' });
  try {
    const origin = await fixture.start();
    const request = (url, init = {}) => fetch(`${origin}${url}`, { ...init, headers: { authorization: `Bearer ${fixture.credential}`, ...(init.headers ?? {}) } });
    const snapshotA = { version: 1, datasets: [], cases: [], assets: [], runs: [] };
    const snapshotB = { ...snapshotA, datasets: [{ id: 'next' }] };
    assert.equal((await request('/api/calibration-harness/snapshot', { method: 'PUT', headers: { 'if-none-match': '*', 'content-type': 'application/json' }, body: JSON.stringify(snapshotA) })).status, 201);
    assert.equal((await request('/api/calibration-harness/snapshot', { method: 'PUT', headers: { 'if-none-match': '*', 'content-type': 'application/json' }, body: JSON.stringify(snapshotB) })).status, 412);
    assert.equal((await request('/api/calibration-harness/snapshot', { method: 'PUT', headers: { 'if-match': '"0"', 'content-type': 'application/json' }, body: JSON.stringify(snapshotB) })).status, 412);
    const current = await (await request('/api/calibration-harness/snapshot', { method: 'GET' })).json();
    assert.deepEqual(current, { revision: 1, snapshot: snapshotA });
    assert.equal((await request('/api/calibration-harness/snapshot', { method: 'PUT', headers: { 'if-match': '"1"', 'content-type': 'application/json' }, body: JSON.stringify(snapshotB) })).status, 200);
    const stale = await (await request('/api/calibration-harness/snapshot', { method: 'PUT', headers: { 'if-match': '"1"', 'content-type': 'application/json' }, body: JSON.stringify(snapshotA) })).json();
    assert.equal(stale.error, 'precondition-failed');
    const binary = new Uint8Array([0, 1, 2, 3, 127, 255]);
    const hash = sha256(binary);
    assert.equal((await request(`/api/calibration-harness/blobs/${hash}`, { method: 'PUT', body: binary })).status, 201);
    assert.deepEqual(new Uint8Array(await (await request(`/api/calibration-harness/blobs/${hash}`)).arrayBuffer()), binary);
  } finally {
    await fixture.close();
  }
});

test('deferred fixture records actual request end and real client abort termination', async () => {
  const fixture = createPreloadIpcFixture({ credential: `unit_${randomUUID()}`, harnessId: 'unit-harness' });
  const controller = new AbortController();
  let deferred;
  try {
    const origin = await fixture.start();
    deferred = fixture.deferNextSnapshot();
    const response = await fetch(`${origin}/api/calibration-harness/snapshot`, { headers: { authorization: `Bearer ${fixture.credential}` }, signal: controller.signal });
    await deferred.started;
    const open = deferred.observation();
    assert.equal(open.requestEnded, true);
    assert.equal(open.responseClosed, false);
    assert.equal(open.socketClosed, false);
    assert.equal(response.ok, true);
    controller.abort();
    const closed = await deferred.closed;
    assert.equal(closed.responseClosed || closed.socketClosed, true);
    assert.equal(closed.writableEnded, false);
  } finally {
    controller.abort();
    await fixture.close();
    await deferred?.closed.catch(() => {});
  }
});

test('request end alone remains open and fixture cleanup rejects rather than faking cancellation', async () => {
  const fixture = createPreloadIpcFixture({ credential: `unit_${randomUUID()}`, harnessId: 'unit-harness' });
  let deferred;
  try {
    const origin = await fixture.start();
    deferred = fixture.deferNextSnapshot();
    const response = await fetch(`${origin}/api/calibration-harness/snapshot`, { headers: { authorization: `Bearer ${fixture.credential}` } });
    await deferred.started;
    const open = deferred.observation();
    assert.equal(open.requestEnded, true);
    assert.equal(open.responseClosed, false);
    assert.equal(open.socketClosed, false);
    assert.equal(response.ok, true);
    await fixture.close();
    await assert.rejects(deferred.closed, /fixture closed before deferred client cancellation/);
  } finally {
    await fixture.close();
    await deferred?.closed.catch(() => {});
  }
});

test('stopOwned injects all fake PID operations and observes a normal owned exit', async () => {
  const calls = [];
  const fake = fakeChild();
  const result = await stopOwned(fake, [{ pid: fake.pid }], {
    killFn(child, signal) { calls.push(['kill', child.pid, signal]); queueMicrotask(() => child.emit('exit', 0, null)); },
    scan: knownEmpty,
    pidAbsence: absent,
    timeoutMs: 20,
  });
  assert.equal(result.verified, true);
  assert.deepEqual(calls, [['kill', 4242, 'SIGTERM']]);
});

test('stopOwned records an injected early child error without host signals', async () => {
  const calls = [];
  const fake = fakeChild();
  const result = await stopOwned(fake, [{ pid: fake.pid }], {
    killFn(child, signal) { calls.push(signal); queueMicrotask(() => child.emit('error', new Error('spawn failed'))); },
    scan: knownEmpty,
    pidAbsence: absent,
    timeoutMs: 20,
  });
  assert.equal(result.verified, false);
  assert.equal(result.exit.error.message, 'spawn failed');
  assert.deepEqual(calls, ['SIGTERM']);
});

test('stopOwned observes already-exited and signal-terminated fake children', async () => {
  const exited = fakeChild({ exitCode: 3 });
  const already = await stopOwned(exited, [{ pid: exited.pid }], { killFn: () => { throw new Error('must not kill an exited child'); }, scan: knownEmpty, pidAbsence: absent, timeoutMs: 20 });
  assert.equal(already.exit.alreadyExited, true);
  assert.equal(already.verified, true);
  const signalled = fakeChild({ pid: 4343 });
  const signalResult = await stopOwned(signalled, [{ pid: signalled.pid }], {
    killFn(child, signal) { queueMicrotask(() => child.emit('exit', null, signal)); },
    scan: knownEmpty,
    pidAbsence: absent,
    timeoutMs: 20,
  });
  assert.equal(signalResult.exit.signal, 'SIGTERM');
  assert.equal(signalResult.verified, true);
});

test('stopOwned marks timeout and unknown process-group scans non-verified with injected operations', async () => {
  const timeoutCalls = [];
  const stuck = fakeChild({ pid: 4444 });
  const timeoutResult = await stopOwned(stuck, [{ pid: stuck.pid }], {
    killFn(_child, signal) { timeoutCalls.push(signal); },
    scan: knownEmpty,
    pidAbsence: absent,
    timeoutMs: 5,
  });
  assert.equal(timeoutResult.reaped, false);
  assert.equal(timeoutResult.verified, false);
  assert.deepEqual(timeoutCalls, ['SIGTERM', 'SIGKILL']);
  const unknown = fakeChild({ pid: 4545 });
  const unknownResult = await stopOwned(unknown, [{ pid: unknown.pid }], {
    killFn(child) { queueMicrotask(() => child.emit('exit', 0, null)); },
    scan: () => ({ supported: true, status: 'unknown', pids: null }),
    pidAbsence: absent,
    timeoutMs: 20,
  });
  assert.equal(unknownResult.reaped, true);
  assert.equal(unknownResult.verified, false);
});
