import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(serverRoot, '..');
const artifactsRoot = join(serverRoot, '.review-artifacts');
const fixtureParent = join(artifactsRoot, 'td-b1b266-h3-emitted-real-builder');
const buildHelper = join(serverRoot, 'scripts', 'server-build.mjs');

function assertRealDirectory(directory) {
  const entry = lstatSync(directory);
  assert.equal(entry.isSymbolicLink(), false, `fixture ancestor must not be a symlink: ${directory}`);
  assert.equal(entry.isDirectory(), true, `fixture ancestor must be a directory: ${directory}`);
}

function ensureDirectChild(parent, name) {
  assertRealDirectory(parent);
  const child = join(parent, name);
  if (!existsSync(child)) mkdirSync(child, { mode: 0o700 });
  assertRealDirectory(child);
  return child;
}

function createExclusiveDirectory(parent, identifier = randomUUID()) {
  assert.match(identifier, /^[0-9a-f-]+$/i, 'fixture identifier must be one safe path segment');
  assertRealDirectory(parent);
  const fixture = join(parent, identifier);
  assert.equal(relative(parent, fixture).includes('..'), false, 'fixture must remain under its controlled parent');
  try {
    mkdirSync(fixture, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('exclusive fixture collision');
    throw error;
  }
  assertRealDirectory(fixture);
  return fixture;
}

function createFixture() {
  const parent = ensureDirectChild(ensureDirectChild(serverRoot, '.review-artifacts'), 'td-b1b266-h3-emitted-real-builder');
  const collisionIdentifier = randomUUID();
  createExclusiveDirectory(parent, collisionIdentifier);
  assert.throws(() => createExclusiveDirectory(parent, collisionIdentifier), /exclusive fixture collision/);
  return createExclusiveDirectory(parent);
}

function runRealBuilder(fixture) {
  const result = spawnSync(process.execPath, [join(fixture, 'scripts', 'server-build.mjs'), 'build'], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(serverRoot, 'node_modules', '.bin')}:${process.env.PATH}`,
    },
  });
  assert.equal(result.status, 0, `real server-build.mjs failed:\n${result.stdout}\n${result.stderr}`);
}

test('real server-build.mjs writes the package boundary consumed by fresh emitted runtime and route imports', async () => {
  const fixture = createFixture();
  const scripts = ensureDirectChild(fixture, 'scripts');
  const cardbacks = ensureDirectChild(fixture, 'cardbacks');
  copyFileSync(buildHelper, join(scripts, 'server-build.mjs'));
  assert.deepEqual(readFileSync(join(scripts, 'server-build.mjs')), readFileSync(buildHelper));
  writeFileSync(join(cardbacks, 'fixture-cardback.txt'), 'owned emitted fixture\n', { mode: 0o600 });
  writeFileSync(join(fixture, 'tsconfig.build.json'), JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      declaration: false,
      incremental: true,
      rootDir: repositoryRoot,
      outDir: './dist',
      tsBuildInfoFile: './.tsbuildinfo/tsconfig.build.tsbuildinfo',
    },
    include: [join(serverRoot, 'src', '**', '*'), join(repositoryRoot, 'shared', '**', '*')],
    exclude: [join(serverRoot, 'src', '**', '*.test.ts'), join(repositoryRoot, 'shared', '**', '*.test.ts')],
  }, null, 2));
  symlinkSync(join(serverRoot, 'node_modules'), join(fixture, 'node_modules'), 'dir');

  runRealBuilder(fixture);

  const output = join(fixture, 'dist');
  assertRealDirectory(output);
  assertRealDirectory(join(output, 'server'));
  assertRealDirectory(join(output, 'shared'));
  assert.equal(readFileSync(join(output, 'shared', 'package.json'), 'utf8'), '{"type":"commonjs"}\n');
  assert.equal(readFileSync(join(output, 'server', 'cardbacks', 'fixture-cardback.txt'), 'utf8'), 'owned emitted fixture\n');

  const runtimePath = join(output, 'server', 'src', 'services', 'calibrationHarnessRuntime.js');
  const routerPath = join(output, 'server', 'src', 'routes', 'calibrationHarnessRouter.js');
  assert.ok(existsSync(runtimePath), 'real compiler output must contain the runtime module');
  assert.ok(existsSync(routerPath), 'real compiler output must contain the route module');

  const runtimeModule = await import(pathToFileURL(runtimePath).href);
  const routerModule = await import(pathToFileURL(routerPath).href);
  assert.equal(typeof runtimeModule.createCalibrationHarnessRuntime, 'function');
  assert.equal(typeof runtimeModule.resolveCalibrationHarnessServiceOptions, 'function');
  assert.equal(typeof routerModule.createCalibrationHarnessRouter, 'function');

  const dataDirectory = join(fixture, 'runtime-data');
  const options = runtimeModule.resolveCalibrationHarnessServiceOptions({
    dataDirectory,
    allowedWebOrigins: ['https://calibration.example.test'],
  });
  const runtime = runtimeModule.createCalibrationHarnessRuntime(options);
  try {
    assert.equal(runtime.filename, join(dataDirectory, 'calibration-harness.db'));
    assert.equal(typeof runtime.router, 'function');
  } finally {
    runtime.close();
    runtime.close();
  }
  assert.equal(runtime.database.open, false);
});
