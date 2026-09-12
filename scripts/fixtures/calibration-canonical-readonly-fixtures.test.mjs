import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const browserUrl = new URL('./calibration-canonical-readonly-browser.mjs', import.meta.url);
const electronUrl = new URL('./calibration-canonical-readonly-electron.mjs', import.meta.url);

test('Q3 browser fixture is browser-safe and uses production pairing, admission, and operation scopes', async () => {
  const source = await readFile(browserUrl, 'utf8');
  assert.doesNotMatch(source, /^\s*import\s+.*?from\s+["']node:/m);
  assert.match(source, /pairMpcCalibrationWeb/);
  assert.match(source, /runMpcCalibrationInitialAdmissionWithIdentity/);
  assert.match(source, /createMpcCalibrationOperationScope/);
  assert.match(source, /new ProxxiedDexie/);
  assert.doesNotMatch(source, /publishSnapshot|putBlob|missingBlobs|QueueRecovery|MutationCoordinator/);
  const fixture = await import(`${browserUrl.href}?test=${Date.now()}`);
  assert.equal(typeof fixture.validateHydratedCache, 'function');
  assert.equal(typeof fixture.canonicalCounts, 'function');
  assert.equal(typeof fixture.assertExactRows, 'function');
});

test('Q3 browser fixture derives expected counts from the real snapshot and rejects noncanonical actual counts', async () => {
  const { canonicalCounts } = await import(`${browserUrl.href}?counts=${Date.now()}`);
  const snapshot = {
    datasets: [{}], cases: Array.from({ length: 124 }), assets: Array.from({ length: 7227 }, (_, index) => ({ sha256: (index % 5817).toString(16).padStart(64, '0') })), runs: Array.from({ length: 25 }),
  };
  assert.deepEqual(canonicalCounts(snapshot), { datasets: 1, cases: 124, assets: 7227, runs: 25, uniqueBlobs: 5817 });
  assert.throws(() => canonicalCounts({ ...snapshot, cases: [] }), /unexpected snapshot counts/);
});

test('Q3 row-parity proof rejects a same-count metadata substitution', async () => {
  const { assertExactRows } = await import(`${browserUrl.href}?rows=${Date.now()}`);
  assert.doesNotThrow(() => assertExactRows([{ id: 'one', nested: { stable: true } }], [{ id: 'one', nested: { stable: true } }], 'case'));
  assert.throws(() => assertExactRows([{ id: 'one', nested: { stable: false } }], [{ id: 'one', nested: { stable: true } }], 'case'), /case row metadata differs/);
});

test('Q3 Electron fixture keeps the credential in main and installs a restrictive loopback policy', async () => {
  const source = await readFile(electronUrl, 'utf8');
  assert.match(source, /app\.setPath\('userData'/);
  assert.match(source, /calibration-harness\.connection\.json/);
  assert.match(source, /chmod\(.*0o600/);
  assert.match(source, /webRequest\.onBeforeRequest/);
  assert.match(source, /registerCalibrationHarnessIpcHandlers/);
  assert.match(source, /sandbox: true/);
  assert.doesNotMatch(source, /--no-sandbox|disable-setuid-sandbox/);
});
