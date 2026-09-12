import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseOfflineRunArguments,
  stableLoopbackOrigin,
  serviceSeedDisposition,
} from './calibration-offline-sync-smoke.mjs';

test('Q2 runner requires its no-argument runtime entrypoint', () => {
  assert.deepEqual(parseOfflineRunArguments([]), { runtime: true });
  assert.throws(() => parseOfflineRunArguments(['--startup-only']), /usage/);
});

test('Q2 runner retains one selected loopback origin across a service restart', () => {
  assert.equal(stableLoopbackOrigin(43123), 'http://127.0.0.1:43123');
  assert.throws(() => stableLoopbackOrigin(0), /port/);
  assert.throws(() => stableLoopbackOrigin(70000), /port/);
});

test('Q2 service seed policy never overwrites a persisted current revision', () => {
  assert.equal(serviceSeedDisposition(null), 'seed');
  assert.equal(serviceSeedDisposition(1), 'preserve');
  assert.equal(serviceSeedDisposition(9), 'preserve');
  assert.throws(() => serviceSeedDisposition(0), /revision/);
});

test('Q2 outer launcher delegates the complete runtime to the accepted private namespace envelope', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const [source, envelope] = await Promise.all([
    readFile(path.join(root, 'scripts/calibration-offline-sync-smoke.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts/preload-compatibility-smoke.mjs'), 'utf8'),
  ]);
  assert.match(source, /bwrapNetworkIsolatedLaunch\(args, service\.nodeExecutable/);
  assert.match(source, /private Xvfb/);
  assert.match(source, /ownedProcessGroupMembers/);
  assert.match(envelope, /--unshare-user/);
  assert.match(envelope, /--unshare-net/);
  assert.match(envelope, /--cap-drop', 'ALL/);
  assert.doesNotMatch(source, /--no-sandbox/);
});

test('Q2 fixtures gate every Electron continuation on renderer admission and distinct owned go files', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const [runner, electron, service] = await Promise.all([
    readFile(path.join(root, 'scripts/fixtures/calibration-shared-sync-restart-runner.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts/fixtures/calibration-shared-sync-restart-electron.mjs'), 'utf8'),
    readFile(path.join(root, 'scripts/fixtures/calibration-shared-sync-service.ts'), 'utf8'),
  ]);
  assert.match(runner, /electron-disjoint-admitted/);
  assert.match(runner, /electron-disjoint-go/);
  assert.match(runner, /electron-conflict-admitted/);
  assert.match(runner, /electron-conflict-go/);
  assert.match(runner, /const activeElectrons = \[\]/);
  assert.ok(runner.indexOf('for (const electron of activeElectrons.reverse())') < runner.indexOf('matrix.serviceFinal'), 'Electron cleanup must precede service shutdown');
  assert.match(electron, /window\.__q2AdmissionReady === true/);
  assert.match(electron, /\$\{phase\}-admitted/);
  assert.match(electron, /\$\{phase\}-go/);
  assert.match(service, /id="credential" type="password"/);
  assert.match(service, /id="q2-start"/);
});
