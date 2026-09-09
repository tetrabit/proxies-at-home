import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseScript = path.join(repositoryRoot, 'scripts', 'release.mjs');
const fixtureRoot = path.join(
  repositoryRoot,
  '.review-artifacts',
  'release-validation-test-fixtures',
);

function writeExecutable(filePath, source) {
  writeFileSync(filePath, source, { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

function createFixture({ failingNpmCommand = 'run typecheck --prefix client', failingNpxCommand = '' } = {}) {
  const fixtureDirectory = path.join(fixtureRoot, `validation-failure-${randomUUID()}`);
  const binDirectory = path.join(fixtureDirectory, 'bin');
  const eventLog = path.join(fixtureDirectory, 'events.log');

  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(
    path.join(fixtureDirectory, 'package.json'),
    JSON.stringify({ name: 'release-validation-fixture', private: true, version: '1.0.0' }) + '\n',
  );
  writeExecutable(
    path.join(binDirectory, 'git'),
    `#!/bin/sh
printf 'git:%s\\n' "$*" >> "$RELEASE_VALIDATION_EVENT_LOG"
case "$1 $2" in
  'status --porcelain') exit 0 ;;
  'branch --show-current') printf 'main\\n'; exit 0 ;;
  'ls-remote --exit-code') printf 'fixture-head\\n'; exit 0 ;;
  'ls-remote --tags') exit 0 ;;
  'tag -l') exit 0 ;;
  'describe --tags') exit 1 ;;
  'log HEAD') exit 0 ;;
  'pull --rebase') exit 0 ;;
esac
exit 0
`,
  );
  writeExecutable(
    path.join(binDirectory, 'which'),
    `#!/bin/sh
printf 'which:%s\\n' "$*" >> "$RELEASE_VALIDATION_EVENT_LOG"
exit 1
`,
  );
  writeExecutable(
    path.join(binDirectory, 'npm'),
    `#!/bin/sh
printf 'npm:%s\\n' "$*" >> "$RELEASE_VALIDATION_EVENT_LOG"
if [ "$*" = "$RELEASE_VALIDATION_FAIL_NPM_COMMAND" ]; then
  printf 'fixture npm failure: %s\\n' "$*" >&2
  exit 42
fi
exit 0
`,
  );
  writeExecutable(
    path.join(binDirectory, 'npx'),
    `#!/bin/sh
printf 'npx:%s\\n' "$*" >> "$RELEASE_VALIDATION_EVENT_LOG"
if [ "$*" = "$RELEASE_VALIDATION_FAIL_NPX_COMMAND" ]; then
  printf 'fixture npx failure: %s\\n' "$*" >&2
  exit 43
fi
exit 0
`,
  );

  return { fixtureDirectory, binDirectory, eventLog, failingNpmCommand, failingNpxCommand };
}

function releaseEnvironment(fixture) {
  const environment = {
    ...process.env,
    PATH: `${fixture.binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
    RELEASE_VALIDATION_EVENT_LOG: fixture.eventLog,
    RELEASE_VALIDATION_FAIL_NPM_COMMAND: fixture.failingNpmCommand,
    RELEASE_VALIDATION_FAIL_NPX_COMMAND: fixture.failingNpxCommand,
  };

  delete environment.RELEASE_NOTES_PROVIDER_COMMAND;
  delete environment.RELEASE_NOTES_PROVIDER_ARGS;
  delete environment.RELEASE_NOTES_PROVIDER_EXPECTED_VERSION;
  return environment;
}

test('a failing client typecheck aborts release validation before promotion', () => {
  const fixture = createFixture();
  const result = spawnSync(process.execPath, [releaseScript, '1.0.1', '--dry-run'], {
    cwd: fixture.fixtureDirectory,
    encoding: 'utf8',
    env: releaseEnvironment(fixture),
  });

  const output = `${result.stdout}\n${result.stderr}`;
  const events = readFileSync(fixture.eventLog, 'utf8').trim().split('\n');

  assert.equal(result.status, 1, output);
  assert.match(output, /fixture npm failure: run typecheck --prefix client/);
  assert.ok(events.includes('npm:run typecheck --prefix client'));
  assert.equal(events.includes('npm:run lint --prefix client'), false);
  assert.equal(events.some((event) => /^git:(?:commit|push|tag -[ad])\b/.test(event)), false);
  assert.equal(output.includes('Release Summary'), false);
});

test('a failing client test aborts release validation before promotion', () => {
  const fixture = createFixture({ failingNpmCommand: 'run test --prefix client' });
  const result = spawnSync(process.execPath, [releaseScript, '1.0.1', '--dry-run'], {
    cwd: fixture.fixtureDirectory,
    encoding: 'utf8',
    env: releaseEnvironment(fixture),
  });

  const output = `${result.stdout}\n${result.stderr}`;
  const events = readFileSync(fixture.eventLog, 'utf8').trim().split('\n');

  assert.equal(result.status, 1, output);
  assert.match(output, /fixture npm failure: run test --prefix client/);
  assert.ok(events.includes('npm:run test --prefix client'));
  assert.equal(events.includes('npm:run lint --prefix client'), true);
  assert.equal(events.includes('npm:run test --prefix server'), false);
  assert.equal(events.some((event) => /^git:(?:commit|push|tag -[ad])\b/.test(event)), false);
  assert.equal(output.includes('Release Summary'), false);
});

test('a failing server test aborts release validation before promotion', () => {
  const fixture = createFixture({ failingNpmCommand: 'run test --prefix server' });
  const result = spawnSync(process.execPath, [releaseScript, '1.0.1', '--dry-run'], {
    cwd: fixture.fixtureDirectory,
    encoding: 'utf8',
    env: releaseEnvironment(fixture),
  });

  const output = `${result.stdout}\n${result.stderr}`;
  const events = readFileSync(fixture.eventLog, 'utf8').trim().split('\n');

  assert.equal(result.status, 1, output);
  assert.match(output, /fixture npm failure: run test --prefix server/);
  assert.ok(events.includes('npm:run test --prefix client'));
  assert.ok(events.includes('npm:run test --prefix server'));
  assert.equal(events.some((event) => /^git:(?:commit|push|tag -[ad])\b/.test(event)), false);
  assert.equal(output.includes('Release Summary'), false);
});

test('a failing Electron test aborts release validation before promotion', () => {
  const fixture = createFixture({
    failingNpmCommand: '',
    failingNpxCommand: '--no-install vitest --config electron/vitest.config.ts run',
  });
  const result = spawnSync(process.execPath, [releaseScript, '1.0.1', '--dry-run'], {
    cwd: fixture.fixtureDirectory,
    encoding: 'utf8',
    env: releaseEnvironment(fixture),
  });

  const output = `${result.stdout}\n${result.stderr}`;
  const events = readFileSync(fixture.eventLog, 'utf8').trim().split('\n');

  assert.equal(result.status, 1, output);
  assert.match(output, /fixture npx failure: --no-install vitest --config electron\/vitest\.config\.ts run/);
  assert.ok(events.includes('npm:run test --prefix server'));
  assert.ok(events.includes('npx:--no-install vitest --config electron/vitest.config.ts run'));
  assert.equal(events.some((event) => /^git:(?:commit|push|tag -[ad])\b/.test(event)), false);
  assert.equal(output.includes('Release Summary'), false);
});

test('skip-validation labels all validation gates as skipped rather than passed', () => {
  const fixture = createFixture();
  const result = spawnSync(process.execPath, [releaseScript, '1.0.1', '--dry-run', '--skip-validation'], {
    cwd: fixture.fixtureDirectory,
    encoding: 'utf8',
    env: releaseEnvironment(fixture),
  });

  const output = `${result.stdout}\n${result.stderr}`;
  const events = readFileSync(fixture.eventLog, 'utf8').trim().split('\n');

  assert.equal(result.status, 0, output);
  assert.match(output, /Skipping pre-release validation \(--skip-validation\)/);
  assert.equal(events.some((event) => /^(npm|npx):/.test(event)), false);
  assert.equal(output.includes('Pre-release validation complete!'), false);
  assert.equal(output.includes('Client tests passed!'), false);
  assert.equal(output.includes('Server tests passed!'), false);
  assert.equal(output.includes('Electron tests passed!'), false);
});
