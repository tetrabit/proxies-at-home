import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCalibrationExportOrigin } from './calibration-profile-origin.mjs';

test('keeps the existing Thorium origin and IndexedDB prefix as the default', () => {
  assert.deepEqual(resolveCalibrationExportOrigin(), {
    origin: 'http://127.0.0.1:5173',
    indexedDbPrefix: 'http_127.0.0.1_5173.indexeddb',
  });
});

test('selects the existing Electron origin without normalizing or moving it', () => {
  assert.deepEqual(resolveCalibrationExportOrigin('http://localhost:5173'), {
    origin: 'http://localhost:5173',
    indexedDbPrefix: 'http_localhost_5173.indexeddb',
  });
});

for (const invalid of [
  '', null, 'http://localhost:5173/', 'http://LOCALHOST:5173',
  ' http://localhost:5173', 'http://localhost:5173\n',
  'http://localhost:5173?serverPort=3001', 'http://localhost:5173#fragment',
  'http://user@localhost:5173', 'http://localhost:3001',
  'https://localhost:5173', 'http://example.test:5173',
]) {
  test(`rejects an unapproved literal export origin ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => resolveCalibrationExportOrigin(invalid), /Unsupported calibration export origin/);
  });
}
