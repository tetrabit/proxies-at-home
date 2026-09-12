import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import {
  EXPECTED_CANONICAL_COUNTS,
  assertReadonlyRequestLog,
  createReadonlyReport,
  parseReadonlyRunArguments,
  requestAllowedForBrowser,
  validateCanonicalEndpoints,
} from './calibration-canonical-readonly-smoke.mjs';

test('Q3 accepts only exact canonical loopback endpoints and private file references', () => {
  const parsed = parseReadonlyRunArguments([
    '--backend-origin=http://127.0.0.1:3001',
    '--web-origin=http://127.0.0.1:5173',
    '--browser-credential-file=/operator/private/browser-credential',
    '--electron-connection-file=/operator/private/electron-connection.json',
    '--electron=/opt/electron/electron',
    '--preload=/owned/preload.cjs',
    '--ipc=/owned/calibration-harness-ipc.js',
    '--chromium=/opt/chromium/chrome',
  ]);

  assert.deepEqual(parsed, {
    backendOrigin: 'http://127.0.0.1:3001',
    webOrigin: 'http://127.0.0.1:5173',
    browserCredentialFile: '/operator/private/browser-credential',
    electronConnectionFile: '/operator/private/electron-connection.json',
    electron: '/opt/electron/electron',
    preload: '/owned/preload.cjs',
    ipc: '/owned/calibration-harness-ipc.js',
    chromium: '/opt/chromium/chrome',
  });
  assert.deepEqual(validateCanonicalEndpoints(parsed), { backendOrigin: parsed.backendOrigin, webOrigin: parsed.webOrigin });
  assert.deepEqual(EXPECTED_CANONICAL_COUNTS, { datasets: 1, cases: 124, assets: 7227, runs: 25, uniqueBlobs: 5817, revision: 1 });
});

test('Q3 fails closed for credentials in values, untrusted origins, and optional mutation modes', () => {
  const base = [
    '--backend-origin=http://127.0.0.1:3001',
    '--web-origin=http://127.0.0.1:5173',
    '--browser-credential-file=/operator/private/browser-credential',
    '--electron-connection-file=/operator/private/electron-connection.json',
    '--electron=/opt/electron/electron',
    '--preload=/owned/preload.cjs',
    '--ipc=/owned/calibration-harness-ipc.js',
    '--chromium=/opt/chromium/chrome',
  ];
  for (const replacement of [
    '--backend-origin=http://localhost:3001',
    '--web-origin=http://127.0.0.1:4173',
    '--browser-credential=calibration_pair_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '--allow-mutations=true',
  ]) {
    const args = [...base.filter(argument => !argument.startsWith(replacement.split('=')[0])), replacement];
    assert.throws(() => parseReadonlyRunArguments(args), /Q3 canonical readonly runner/);
  }
});

test('Q3 browser route aborts forbidden API requests before send while permitting non-API web assets', () => {
  const root = new URL('http://127.0.0.1:5173/');
  const pair = new URL('/api/calibration-harness/pair', root);
  const snapshot = new URL('/api/calibration-harness/snapshot', root);
  assert.equal(typeof requestAllowedForBrowser, 'function');
  assert.equal(requestAllowedForBrowser(new URL('/assets/app.js', root), 'GET', false), true);
  assert.equal(requestAllowedForBrowser(pair, 'POST', false), true);
  assert.equal(requestAllowedForBrowser(pair, 'POST', true), false);
  assert.equal(requestAllowedForBrowser(snapshot, 'GET', true), true);
  assert.equal(requestAllowedForBrowser(snapshot, 'PUT', true), false);
  assert.equal(requestAllowedForBrowser(new URL('/api/unrelated', root), 'GET', true), false);
  assert.equal(requestAllowedForBrowser(new URL('https://example.test/api/calibration-harness/snapshot'), 'GET', true), false);
});

test('Q3 runner builds a browser bundle rather than injecting unresolved /src imports into the deployed web origin', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('./calibration-canonical-readonly-smoke.mjs', import.meta.url), 'utf8');
  assert.match(source, /async function buildBrowserFixture/);
  assert.match(source, /build\(\{[\s\S]*bundle:\s*true[\s\S]*platform:\s*'browser'/);
  assert.match(source, /page\.addScriptTag\(\{ path: browserBundle/);
});

test('Q3 request monitor permits exactly browser pairing plus read-only C3 traffic', () => {
  const allowed = [
    { role: 'browser', method: 'POST', pathname: '/api/calibration-harness/pair' },
    { role: 'browser', method: 'GET', pathname: '/api/calibration-harness/session' },
    { role: 'browser', method: 'GET', pathname: '/api/calibration-harness/snapshot' },
    { role: 'browser', method: 'GET', pathname: `/api/calibration-harness/blobs/${'a'.repeat(64)}` },
    { role: 'electron', method: 'GET', pathname: '/api/calibration-harness/session' },
    { role: 'electron', method: 'GET', pathname: '/api/calibration-harness/snapshot' },
    { role: 'electron', method: 'GET', pathname: `/api/calibration-harness/blobs/${'b'.repeat(64)}` },
  ];
  assert.deepEqual(assertReadonlyRequestLog(allowed), { browserPairCount: 1, total: 7 });
  assert.throws(
    () => assertReadonlyRequestLog([...allowed, { role: 'electron', method: 'PUT', pathname: '/api/calibration-harness/snapshot' }]),
    /forbidden request/,
  );
  assert.throws(
    () => assertReadonlyRequestLog(allowed.filter(entry => entry.method !== 'POST')),
    /exactly one browser pairing/,
  );
});

test('Q3 report redacts private references and refuses incomplete client proofs', async () => {
  const artifactRoot = path.join(process.cwd(), '.review-artifacts', 'td-80f260', 'test-q3-readonly', randomUUID());
  await mkdir(path.join(artifactRoot, 'reports'), { recursive: true, mode: 0o700 });
  const report = createReadonlyReport({
    run: artifactRoot,
    backendOrigin: 'http://127.0.0.1:3001',
    webOrigin: 'http://127.0.0.1:5173',
    browserCredentialFile: '/operator/private/browser-credential',
    electronConnectionFile: '/operator/private/electron-connection.json',
    browser: { status: 'PASS', counts: { datasets: 1, cases: 124, assets: 7227, runs: 25, uniqueBlobs: 5817 }, validatedAssets: 7227 },
    electron: { status: 'PASS', counts: { datasets: 1, cases: 124, assets: 7227, runs: 25, uniqueBlobs: 5817 }, validatedAssets: 7227 },
    requests: { browserPairCount: 1, total: 4 },
  });
  const serialized = JSON.stringify(report);
  assert.equal(report.status, 'PASS');
  assert.doesNotMatch(serialized, /operator\/private|credential|connection\.json/);
  assert.throws(() => createReadonlyReport({ ...report, browser: { status: 'PASS', counts: { datasets: 1 }, validatedAssets: 1 } }), /complete browser proof/);
});
