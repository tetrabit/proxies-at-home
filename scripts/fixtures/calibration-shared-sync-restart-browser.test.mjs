import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { admitOrReuseExactCurrent } from './calibration-shared-sync-restart-browser.mjs';

test('Q2 clean reuse permits an older hydration stamp and unordered keyed rows after ACK', async () => {
  const identity = { ownerId: 'owner', harnessId: 'harness', connectionId: 'connection' };
  const datasets = [{ id: 'z' }, { id: 'a' }];
  const snapshot = { version: 1, datasets, cases: [], assets: [], runs: [] };
  const state = { base: { revision: 4, snapshot }, queued: null, inFlight: null };
  const database = {
    mpcCalibrationCacheBindings: { get: async () => ({ ...identity, revision: 3 }) },
    mpcCalibrationDatasets: { toArray: async () => [...datasets].reverse() },
    mpcCalibrationCases: { toArray: async () => [] },
    mpcCalibrationAssets: { toArray: async () => [] },
    mpcCalibrationRuns: { toArray: async () => [] },
  };
  const result = await admitOrReuseExactCurrent({
    admitted: { kind: 'blocked', identity }, database,
    stateStore: { load: async () => state },
    transport: { getSnapshot: async () => ({ revision: 4, snapshot }) },
    operation: { signal: new AbortController().signal },
    canonicalHarnessJson: JSON.stringify, phase: 'electron-conflict',
  });
  assert.equal(result.reusedCurrent, true);
});

const fixture = new URL('./calibration-shared-sync-restart-browser.mjs', import.meta.url);

test('Q2 browser fixture is renderer-only and uses real C1/C5 production APIs', async () => {
  const source = await readFile(fixture, 'utf8');
  assert.doesNotMatch(source, /^\s*import\s+.*?from\s+["']node:/m);
  assert.match(source, /createMpcCalibrationMutationCoordinator/);
  assert.match(source, /createMpcCalibrationQueueRecoveryController/);
  assert.match(source, /createMpcCalibrationSyncStateStore/);
});

test('Q2 browser fixture accepts a pairing credential only from the controlled input and clears that same input', async () => {
  const source = await readFile(fixture, 'utf8');
  assert.doesNotMatch(source, /__q2Credential/);
  assert.match(source, /querySelector\('#credential'\)/);
  assert.match(source, /querySelector\('#q2-start'\)/);
  assert.match(source, /__q2ModuleReady\s*=\s*true/);
  assert.match(source, /take:\s*\(\)\s*=>\s*credentialInput\.value/);
  assert.match(source, /clear:\s*\(\)\s*=>\s*\{\s*credentialInput\.value\s*=\s*'';/);
});

test('Q2 recovery reads durable G1 and remote revision one before it admits C5', async () => {
  const source = await readFile(fixture, 'utf8');
  const recoverStart = source.indexOf("if (phase === 'recover') {");
  const before = source.indexOf('const before = await stateStore.load(admitted.identity)', recoverStart);
  const remote = source.indexOf('const remoteBefore = await transport.getSnapshot', recoverStart);
  const controller = source.indexOf('controller = controllerFor', recoverStart);
  assert.ok(before >= 0 && remote > before && controller > remote, 'recover must validate C1 and remote before controller admission');
  assert.equal(source.indexOf("if (phase === 'remote-disjoint')"), source.indexOf("if (phase === 'remote-disjoint')", controller));
  assert.ok(source.indexOf("if (phase === 'remote-disjoint')") > controller, 'browser disjoint work must be a later peer phase');
});

test('Q2 Electron only signals ready after exact blocked-equal reuse validation and waits for its peer go signal', async () => {
  const source = await readFile(fixture, 'utf8');
  assert.match(source, /async function admitOrReuseExactCurrent/);
  assert.match(source, /binding\.revision !== state\.base\.revision/);
  assert.match(source, /remote\.revision !== state\.base\.revision/);
  assert.match(source, /canonicalHarnessJson\(remote\.snapshot\) !== canonicalHarnessJson\(state\.base\.snapshot\)/);
  assert.match(source, /rowsMatchSnapshot\(database, state\.base\.snapshot, canonicalHarnessJson\)/);
  assert.match(source, /admitted\.kind === 'needs-reconciliation' && phase === 'recover'/);
  assert.match(source, /canonicalHarnessJson\(state\.queued\.snapshot\) !== canonicalHarnessJson\(state\.inFlight\.snapshot\)/);
  assert.match(source, /__q2AdmissionReady\s*=\s*true/);
  assert.match(source, /__q2RestartGo === true/);
});

test('Q2 blocked admission rejects malicious mismatched physical binding and actual cache content', async () => {
  const identity = { ownerId: 'owner', harnessId: 'harness', connectionId: 'connection' };
  const snapshot = { version: 1, datasets: [], cases: [], assets: [], runs: [] };
  const state = { base: { revision: 4, snapshot }, queued: null, inFlight: null };
  const admitted = { kind: 'blocked', identity };
  const transport = { getSnapshot: async () => ({ revision: 4, snapshot }) };
  const operation = { signal: new AbortController().signal };
  const canonicalHarnessJson = value => JSON.stringify(value);
  const rows = extra => ({
    mpcCalibrationCacheBindings: { get: async () => ({ id: 'mpc-calibration-cache-binding', ...identity, revision: 4 }) },
    mpcCalibrationDatasets: { toArray: async () => extra ? [{ id: 'malicious-extra' }] : [] },
    mpcCalibrationCases: { toArray: async () => [] },
    mpcCalibrationAssets: { toArray: async () => [] },
    mpcCalibrationRuns: { toArray: async () => [] },
  });
  await assert.rejects(
    admitOrReuseExactCurrent({
      admitted,
      database: { ...rows(false), mpcCalibrationCacheBindings: { get: async () => ({ id: 'mpc-calibration-cache-binding', ...identity, ownerId: 'other-owner', revision: 4 }) } },
      stateStore: { load: async () => state }, transport, operation, canonicalHarnessJson, phase: 'electron-conflict',
    }),
    /exact clean current reuse/,
  );
  await assert.rejects(
    admitOrReuseExactCurrent({
      admitted, database: rows(true), stateStore: { load: async () => state }, transport, operation, canonicalHarnessJson, phase: 'electron-conflict',
    }),
    /exact clean current reuse/,
  );
});
