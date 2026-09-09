import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ownedProcessGroupMembers,
  isVerifiedOwnedChildShutdown,
} from './preload-compatibility-smoke.mjs';

test('ownedProcessGroupMembers records ps failures as unknown instead of empty', () => {
  const error = Object.assign(new Error('ps unavailable'), { code: 'ENOENT' });

  const observation = ownedProcessGroupMembers(4242, {
    execFileSyncFn: () => { throw error; },
  });

  assert.equal(observation.supported, true);
  assert.equal(observation.status, 'unknown');
  assert.equal(observation.pids, null);
  assert.deepEqual(observation.error, {
    name: 'Error',
    code: 'ENOENT',
    message: 'ps unavailable',
  });
});

test('ownedProcessGroupMembers recognizes ps no-selection exit as a known empty scan', () => {
  const error = Object.assign(new Error('Command failed: ps'), {
    status: 1,
    stdout: '',
    stderr: '',
  });

  const observation = ownedProcessGroupMembers(4242, {
    execFileSyncFn: () => { throw error; },
  });

  assert.deepEqual(observation, {
    supported: true,
    status: 'known',
    pids: [],
    source: 'ps-no-matching-process-group',
  });
});

test('isVerifiedOwnedChildShutdown requires a reaped child and a successful empty scan', () => {
  const cleanScan = { supported: true, status: 'known', pids: [] };
  const unknownScan = {
    supported: true,
    status: 'unknown',
    pids: null,
    error: { name: 'Error', code: 'ENOENT', message: 'ps unavailable' },
  };

  assert.equal(isVerifiedOwnedChildShutdown({ reaped: true, scan: cleanScan }), true);
  assert.equal(isVerifiedOwnedChildShutdown({ reaped: false, scan: cleanScan }), false);
  assert.equal(isVerifiedOwnedChildShutdown({ reaped: true, scan: unknownScan }), false);
  assert.equal(
    isVerifiedOwnedChildShutdown({
      reaped: true,
      scan: { supported: true, status: 'known', pids: [4242] },
    }),
    false
  );
});
