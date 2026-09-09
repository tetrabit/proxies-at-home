import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRuntimeArguments,
  buildRuntimeCommand,
  chooseArtifactId,
  imageTagForArtifactId,
  validateArtifactId,
} from './calibration-image-smoke.mjs';

test('chooseArtifactId preserves an unused requested id and allocates a numbered collision suffix', () => {
  const taken = new Set(['b21-image-smoke-01', 'b21-image-smoke-01-2']);
  assert.equal(chooseArtifactId('b21-image-smoke-01', (candidate) => taken.has(candidate)), 'b21-image-smoke-01-3');
  assert.equal(chooseArtifactId('b21-image-smoke-02', (candidate) => taken.has(candidate)), 'b21-image-smoke-02');
});

test('image tag tracks the resolved collision-safe artifact id', () => {
  assert.equal(imageTagForArtifactId('b21-image-smoke-01-3'), 'proxxied-b21-image-smoke-01-3:latest');
});

test('validateArtifactId rejects traversal and non-artifact names', () => {
  assert.equal(validateArtifactId('b21-image-smoke-01'), 'b21-image-smoke-01');
  for (const unsafe of ['', '../outside', 'b21/image', '.review-artifacts', 'name with spaces']) {
    assert.throws(() => validateArtifactId(unsafe), /artifact id/i);
  }
});

test('runtime command uses image defaults and performs the bounded CLI PDF smoke', () => {
  const command = buildRuntimeCommand('/output');
  for (const required of [
    '$PRINTER_CALIBRATION_BIN profile set',
    '$PRINTER_CALIBRATION_BIN profile list',
    '$PRINTER_CALIBRATION_BIN sheet --output /output/input.pdf',
    '$PRINTER_CALIBRATION_BIN apply --profile smoke',
    '$PRINTER_CALIBRATION_PYTHON -c',
    'PdfReader',
    '612.0',
    '792.0',
    'printer-calibration',
  ]) {
    assert.match(command, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(command, /\b(?:rm|docker\s+(?:rm|prune)|find\s+.*-delete)\b/);
});

test('runtime arguments use a writable bind by Docker default rather than invalid rw mount syntax', () => {
  const args = buildRuntimeArguments({
    imageTag: 'proxxied-test:latest',
    containerName: 'b21-test-runtime',
    outputDirectory: '/repo/.review-artifacts/b21-test/runtime-output',
    uid: 1000,
    gid: 1000,
  });
  const mountIndex = args.indexOf('--mount');
  assert.notEqual(mountIndex, -1);
  assert.equal(args[mountIndex + 1], 'type=bind,src=/repo/.review-artifacts/b21-test/runtime-output,dst=/output');
  assert.equal(args.includes('rw'), false);
});
