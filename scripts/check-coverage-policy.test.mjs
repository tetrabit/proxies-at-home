import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkCoveragePolicy } from './check-coverage-policy.mjs';

test('coverage policy, package scripts, and instrumentation exclusions stay synchronized', () => {
  const result = checkCoveragePolicy();

  assert.deepEqual(result.scopes, ['client', 'server', 'electron', 'shared']);
  assert.equal(result.baselineScripts.length, 5);
  assert.equal(result.enforcementScripts.length, 5);
  assert.ok(result.fileLevelIgnoreCount > 0);
});
