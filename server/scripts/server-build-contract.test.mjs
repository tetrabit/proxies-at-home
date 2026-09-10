import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(serverRoot, '..');
const packageJsonPath = join(serverRoot, 'package.json');
const buildHelperPath = join(serverRoot, 'scripts', 'server-build.mjs');

function runFixtureScript(root, action) {
  const result = spawnSync('npm', ['run', action], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(serverRoot, 'node_modules', '.bin')}:${process.env.PATH}`,
    },
  });

  assert.equal(
    result.status,
    0,
    `${action} failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

test('server manifest keeps routine builds incremental and scopes explicit clean recovery', () => {
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const rootManifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));

  assert.match(manifest.scripts.build, /server-build\.mjs build/);
  assert.doesNotMatch(manifest.scripts.build, /(?:rm\s+-rf|rmSync|rmdir|clean)/);
  assert.match(manifest.scripts.clean, /server-build\.mjs clean/);
  assert.match(manifest.scripts['build:clean'], /^npm run clean\s*&&\s*npm run build$/);
  assert.equal(manifest.scripts.prebuild, 'npm --prefix ../shared/scryfall-client run build');
  assert.equal(rootManifest.scripts['build:server'], 'npm run build --ignore-scripts --prefix server');

  const helper = readFileSync(buildHelperPath, 'utf8');
  assert.match(helper, /\['dist', '\.tsbuildinfo'\]/);
  assert.doesNotMatch(helper, /--root/);
  assert.match(helper, /lstatSync/);
  assert.match(helper, /isSymbolicLink/);
});

test('real compiler fixture retains incremental state and cleanly recovers deleted-source output', () => {
  const fixtureParent = join(serverRoot, '.review-artifacts');
  mkdirSync(fixtureParent, { recursive: true });
  const fixtureRoot = mkdtempSync(join(fixtureParent, 'td-02c5ad-parentcommitQA-'));
  const externalRoot = mkdtempSync(join(fixtureParent, 'td-02c5ad-external-'));
  const alphaSource = join(fixtureRoot, 'src', 'alpha.ts');
  const betaSource = join(fixtureRoot, 'src', 'beta.ts');
  const alphaOutput = join(fixtureRoot, 'dist', 'src', 'alpha.js');
  const betaOutput = join(fixtureRoot, 'dist', 'src', 'beta.js');
  const buildInfoDirectory = join(fixtureRoot, '.tsbuildinfo');
  const buildInfoPath = join(buildInfoDirectory, 'tsconfig.build.tsbuildinfo');
  const externalSentinel = join(externalRoot, 'must-survive.txt');

  mkdirSync(dirname(alphaSource), { recursive: true });
  mkdirSync(join(fixtureRoot, 'cardbacks'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'scripts'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'scripts', 'server-build.mjs'), readFileSync(buildHelperPath, 'utf8'));
  writeFileSync(alphaSource, 'export const alpha = 1;\n');
  writeFileSync(betaSource, 'export const beta = 2;\n');
  writeFileSync(join(fixtureRoot, 'cardbacks', 'fixture.txt'), 'fixture-cardback\n');
  writeFileSync(join(fixtureRoot, 'must-survive.txt'), 'fixture-owned non-output\n');
  writeFileSync(externalSentinel, 'outside fixture\n');
  writeFileSync(
    join(fixtureRoot, 'package.json'),
    JSON.stringify({
      private: true,
      scripts: {
        build: 'node scripts/server-build.mjs build',
        clean: 'node scripts/server-build.mjs clean',
        'build:clean': 'npm run clean && npm run build',
      },
    }),
  );
  writeFileSync(
    join(fixtureRoot, 'tsconfig.build.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        strict: true,
        incremental: true,
        outDir: './dist',
        rootDir: '.',
        tsBuildInfoFile: './.tsbuildinfo/tsconfig.build.tsbuildinfo',
      },
      include: ['src/**/*.ts'],
    }),
  );

  runFixtureScript(fixtureRoot, 'build');
  assert.ok(existsSync(alphaOutput));
  assert.ok(existsSync(betaOutput));
  assert.ok(existsSync(buildInfoPath));
  assert.ok(existsSync(join(fixtureRoot, 'dist', 'server', 'cardbacks', 'fixture.txt')));

  runFixtureScript(fixtureRoot, 'build');
  assert.ok(existsSync(buildInfoPath), 'unchanged normal build preserves configured tsbuildinfo');
  assert.ok(existsSync(betaOutput), 'normal build does not clean prior output');

  rmSync(betaSource);
  assert.ok(existsSync(betaOutput), 'deleted fixture source leaves stale emitted output before explicit clean');
  rmSync(buildInfoDirectory, { recursive: true, force: true });
  symlinkSync(externalRoot, buildInfoDirectory, 'dir');
  assert.ok(lstatSync(buildInfoDirectory).isSymbolicLink());

  runFixtureScript(fixtureRoot, 'build:clean');
  assert.ok(existsSync(alphaOutput), 'recovery build emits remaining source');
  assert.ok(!existsSync(betaOutput), 'recovery build does not restore deleted source output');
  assert.ok(existsSync(buildInfoPath), 'recovery build restores incremental state');
  assert.equal(readFileSync(externalSentinel, 'utf8'), 'outside fixture\n');
  assert.equal(readFileSync(join(fixtureRoot, 'must-survive.txt'), 'utf8'), 'fixture-owned non-output\n');
  assert.ok(existsSync(join(fixtureRoot, 'cardbacks', 'fixture.txt')));
});
