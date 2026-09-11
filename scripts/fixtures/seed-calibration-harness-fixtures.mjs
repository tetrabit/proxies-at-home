import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverRoot = path.join(repositoryRoot, 'server');
const evidenceRoot = path.join(repositoryRoot, '.review-artifacts', 'seed-calibration-harness');

function fail(message) {
  throw new Error(message);
}

function safeSegments(directory) {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  return { resolved, parsed, segments: resolved.slice(parsed.root.length).split(path.sep).filter(Boolean) };
}

export function ensureSafeDirectoryTree(directory, label = 'fixture directory') {
  const { resolved, parsed, segments } = safeSegments(directory);
  let cursor = parsed.root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      const entry = lstatSync(cursor);
      if (entry.isSymbolicLink() || !entry.isDirectory()) fail(`${label} has an unsafe ancestor`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      const parentEntry = lstatSync(parent);
      if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) fail(`${label} has an unsafe ancestor`);
      mkdirSync(cursor, { mode: 0o700 });
      const created = lstatSync(cursor);
      if (created.isSymbolicLink() || !created.isDirectory()) fail(`${label} was not created as a real directory`);
    }
  }
  return resolved;
}

export function createExclusiveFixture(parent, identifier = randomUUID()) {
  assert.match(identifier, /^[0-9a-f-]+$/i, 'fixture identifier must be one safe path segment');
  const safeParent = ensureSafeDirectoryTree(parent);
  const fixture = path.join(safeParent, identifier);
  assert.equal(path.dirname(fixture), safeParent, 'fixture must remain under its controlled parent');
  try {
    mkdirSync(fixture, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') fail('exclusive fixture collision');
    throw error;
  }
  const entry = lstatSync(fixture);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    fail('exclusive fixture was not created as a real directory');
  }
  return fixture;
}

export function createDataFixture() {
  return createExclusiveFixture(path.join(evidenceRoot, 'test-fixtures'));
}

function writeRuntimeConfiguration(fixture) {
  const scripts = ensureSafeDirectoryTree(path.join(fixture, 'scripts'));
  const cardbacks = ensureSafeDirectoryTree(path.join(fixture, 'cardbacks'));
  copyFileSync(path.join(serverRoot, 'scripts', 'server-build.mjs'), path.join(scripts, 'server-build.mjs'));
  assert.deepEqual(
    readFileSync(path.join(scripts, 'server-build.mjs')),
    readFileSync(path.join(serverRoot, 'scripts', 'server-build.mjs')),
    'fresh runtime must use an exact production builder copy',
  );
  writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module' }), { flag: 'wx', mode: 0o600 });
  writeFileSync(path.join(fixture, 'tsconfig.build.json'), JSON.stringify({
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
    include: [path.join(serverRoot, 'src', '**', '*'), path.join(repositoryRoot, 'shared', '**', '*')],
    exclude: [path.join(serverRoot, 'src', '**', '*.test.ts'), path.join(repositoryRoot, 'shared', '**', '*.test.ts')],
  }, null, 2), { flag: 'wx', mode: 0o600 });
  writeFileSync(path.join(cardbacks, 'fixture-cardback.txt'), 'owned emitted fixture\n', { flag: 'wx', mode: 0o600 });
  symlinkSync(path.join(serverRoot, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
}

export function createFreshRuntimeFixture() {
  const fixture = createExclusiveFixture(path.join(serverRoot, '.review-artifacts', 'seed-calibration-harness', 'runtime-fixtures'));
  writeRuntimeConfiguration(fixture);
  const builder = path.join(fixture, 'scripts', 'server-build.mjs');
  const result = spawnSync(process.execPath, [builder, 'build'], {
    cwd: fixture,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(serverRoot, 'node_modules', '.bin')}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, `real server-build.mjs failed:\n${result.stdout}\n${result.stderr}`);
  const runtimeDirectory = path.join(fixture, 'dist');
  const output = lstatSync(path.join(runtimeDirectory, 'server', 'src', 'db', 'openNativeDatabase.js'));
  if (output.isSymbolicLink() || !output.isFile()) fail('fresh runtime is missing emitted native database module');
  return { fixture, runtimeDirectory, builder, compilerOutput: `${result.stdout}${result.stderr}` };
}

export { evidenceRoot, repositoryRoot, serverRoot };
