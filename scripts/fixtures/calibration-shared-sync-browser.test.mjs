import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const fixtureUrl = new URL('./calibration-shared-sync-browser.mjs', import.meta.url);
const fixturePath = fixtureUrl.pathname;
const repositoryRoot = new URL('../../', import.meta.url);

async function source(relativePath) {
  return readFile(new URL(relativePath, repositoryRoot), 'utf8');
}

test('browser renderer module contains no static Node import or raw snapshot bootstrap', async () => {
  const text = await readFile(fixtureUrl, 'utf8');

  assert.doesNotMatch(text, /^\s*import\s+.*?from\s+["']node:/m);
  assert.doesNotMatch(text, /publishSnapshot\(empty,\s*null\)/);
  assert.match(text, /createMpcCalibrationOperationScope/);
  assert.match(text, /captureAppOperation\(\)/);
  assert.match(text, /captureScope\(\)/);
  assert.match(text, /createMpcCalibrationQueueRecoveryController/);
  assert.match(text, /transport\.getBlob\(/);
});

test('renderer fixture imports in Node without starting the browser CLI', async () => {
  const fixture = await import(`${fixtureUrl.href}?node-test=${Date.now()}`);

  assert.equal(typeof fixture.parseBrowserDriverArguments, 'function');
  assert.equal(typeof fixture.browserResultEnvelope, 'function');
  assert.equal(typeof fixture.assertExactBytes, 'function');
});

test('CLI parser restricts browser driver to loopback origin and absolute owned inputs', async () => {
  const { parseBrowserDriverArguments } = await import(`${fixtureUrl.href}?parser-test=${Date.now()}`);

  assert.deepEqual(
    parseBrowserDriverArguments(['seed', 'http://127.0.0.1:43123', '/owned/profile', '/owned/credential']),
    { mode: 'seed', origin: 'http://127.0.0.1:43123', profile: '/owned/profile', credentialFile: '/owned/credential' },
  );
  for (const args of [
    ['other', 'http://127.0.0.1:43123', '/owned/profile', '/owned/credential'],
    ['seed', 'https://127.0.0.1:43123', '/owned/profile', '/owned/credential'],
    ['seed', 'http://localhost:43123', '/owned/profile', '/owned/credential'],
    ['seed', 'http://127.0.0.1:43123/path', '/owned/profile', '/owned/credential'],
    ['seed', 'http://127.0.0.1:43123', 'relative-profile', '/owned/credential'],
    ['seed', 'http://127.0.0.1:43123', '/owned/profile', 'relative-credential'],
    ['seed', 'http://127.0.0.1:43123', '/owned/profile', '/owned/credential', 'unexpected'],
  ]) {
    assert.throws(() => parseBrowserDriverArguments(args), /browser fixture requires mode, loopback origin, and absolute owned paths/);
  }
});

test('result envelope never serializes a credential-like field', async () => {
  const { browserResultEnvelope } = await import(`${fixtureUrl.href}?envelope-test=${Date.now()}`);
  const credential = 'calibration_pair_abcdefghijklmnopqrstuvwxyz_0123456789-ABC';
  const serialized = JSON.stringify(browserResultEnvelope('seed', {
    status: 'PASS',
    proof: { credential, nested: { token: credential }, assetBytes: 6 },
  }));

  assert.deepEqual(JSON.parse(serialized), {
    kind: 'browser-result',
    mode: 'seed',
    result: { status: 'PASS', proof: { nested: {}, assetBytes: 6 } },
  });
  assert.doesNotMatch(serialized, /calibration_pair_/);
});

test('exact byte assertion rejects same-size Blob replacements', async () => {
  const { assertExactBytes } = await import(`${fixtureUrl.href}?bytes-test=${Date.now()}`);
  const expected = new Uint8Array([2, 7, 1, 8, 2, 8]);

  await assert.doesNotReject(() => assertExactBytes(new Blob([expected], { type: 'application/octet-stream' }), expected));
  await assert.rejects(
    () => assertExactBytes(new Blob([new Uint8Array([2, 7, 9, 8, 2, 8])], { type: 'application/octet-stream' }), expected),
    /byte mismatch at offset 2/,
  );
});

test('fixture source uses the production operation, mutation, and C5 APIs', async () => {
  const [operationScope, mutations, queue, admission, pairing] = await Promise.all([
    source('client/src/helpers/mpcCalibrationOperationScope.ts'),
    source('client/src/helpers/mpcCalibrationMutations.ts'),
    source('client/src/helpers/mpcCalibrationQueueRecoveryController.ts'),
    source('client/src/helpers/mpcCalibrationInitialAdmission.ts'),
    source('client/src/helpers/mpcCalibrationWebPairing.ts'),
  ]);

  assert.match(operationScope, /export function createMpcCalibrationOperationScope/);
  assert.match(mutations, /captureScope\(\)/);
  assert.match(mutations, /async mutate<T>/);
  assert.match(queue, /dispatchMpcCalibrationQueuedRecovery/);
  assert.match(admission, /runMpcCalibrationInitialAdmissionWithIdentity/);
  assert.match(pairing, /pairMpcCalibrationWeb/);
  assert.equal(fixturePath.endsWith('/scripts/fixtures/calibration-shared-sync-browser.mjs'), true);
});
