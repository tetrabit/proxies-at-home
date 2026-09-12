import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  buildSharedSyncService,
  isSafeLaunchArguments,
  isSafeOwnedRun,
  parseRunArguments,
} from './calibration-shared-sync-smoke.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const artifactParent = path.join(
  root,
  '.review-artifacts',
  'task-completion-1bc8140c4bff4f698267aaef96c44f34',
  'td-d361f7',
  'calibration-shared-sync-tests',
);

async function allocateRun() {
  await mkdir(artifactParent, { recursive: true, mode: 0o700 });
  const run = path.join(artifactParent, randomUUID());
  await mkdir(run, { mode: 0o700 });
  await mkdir(path.join(run, 'reports'), { mode: 0o700 });
  return run;
}

async function startupLine(child, timeoutMs = 5_000) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return await new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      callback(value);
    };
    const onError = (error) => finish(reject, new Error(`service spawn error: ${error.message}; stderr=${stderr}`));
    const onExit = (code, signal) => finish(reject, new Error(`service exited before readiness (${code ?? signal}); stderr=${stderr}`));
    const timer = setTimeout(() => finish(reject, new Error(`service readiness timeout; stdout=${stdout}; stderr=${stderr}`)), timeoutMs);
    child.stdout.on('data', () => {
      const line = stdout.split('\n').find((value) => value.length > 0);
      if (line !== undefined) {
        try {
          finish(resolve, JSON.parse(line));
        } catch (error) {
          finish(reject, new Error(`service emitted invalid readiness JSON: ${error.message}; stdout=${stdout}; stderr=${stderr}`));
        }
      }
    });
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function settleOwned(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('service did not exit after SIGTERM')), 2_500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

test('Q1 smoke parser accepts full and startup-only entrypoints', () => {
  assert.deepEqual(parseRunArguments([]), { startupOnly: false });
  assert.deepEqual(parseRunArguments(['--startup-only']), { startupOnly: true });
  assert.throws(() => parseRunArguments(['--run', '/tmp/unsafe']), /usage/);
});

test('Q1 smoke rejects paths outside its exclusively allocated run', () => {
  const run = '/repo/.review-artifacts/task/td-d361f7/run';
  assert.equal(isSafeOwnedRun(run, `${run}/electron-profile/user-data`), true);
  assert.equal(isSafeOwnedRun(run, '/repo/.review-artifacts/task/td-d361f7/run-escape'), false);
  assert.equal(isSafeOwnedRun(run, `${run}/../other`), false);
});

test('Q1 smoke rejects Chromium sandbox disabling switches', () => {
  assert.equal(isSafeLaunchArguments(['--disable-gpu', '--ozone-platform=x11']), true);
  assert.equal(isSafeLaunchArguments(['--no-sandbox']), false);
  assert.equal(isSafeLaunchArguments(['--disable-setuid-sandbox=1']), false);
});

test('Q1 service bundle starts the production runtime with the native Node ABI and bounded readiness', async () => {
  const run = await allocateRun();
  const runtime = await buildSharedSyncService({ root, run });
  assert.equal(runtime.nodeExecutable, process.execPath);
  assert.equal(runtime.servicePath.endsWith('.cjs'), true);
  assert.equal(runtime.environment.NODE_PATH, [
    path.join(root, 'server', 'node_modules'),
    path.join(root, 'node_modules'),
  ].join(path.delimiter));

  const child = spawn(runtime.nodeExecutable, [
    runtime.servicePath,
    '--run',
    root,
    run,
    path.join(run, 'server-data'),
    path.join(run, 'browser-credential'),
    path.join(run, 'electron-connection.json'),
  ], {
    cwd: root,
    env: { PATH: process.env.PATH, ...runtime.environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const ready = await startupLine(child);
    assert.equal(ready.kind, 'ready');
    assert.match(ready.origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
  } finally {
    await settleOwned(child);
  }
});
