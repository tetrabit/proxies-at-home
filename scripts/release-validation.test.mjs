import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseScript = path.join(repositoryRoot, 'scripts', 'release.mjs');
const releaseValidationTestScript = fileURLToPath(import.meta.url);
const fixtureRoot = path.join(
  repositoryRoot,
  '.review-artifacts',
  `release-validation-test-fixtures-${randomUUID()}`,
);

const componentBuildCommand = 'npm:run build:parallel';
const downstreamValidationCommands = [
  'npm:run typecheck --prefix client',
  'npm:run lint --prefix client',
  'npm:run test --prefix client',
  'npm:run test --prefix server',
  'npx:--no-install vitest --config electron/vitest.config.ts run',
];
const validationCommandEvents = [componentBuildCommand, ...downstreamValidationCommands];
const parallelInitialGates = downstreamValidationCommands.slice(0, 3);

function writeExecutable(filePath, source) {
  writeFileSync(filePath, source, { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

function lifecycleEvent(command, phase) {
  return `${command}:${phase}`;
}

function createFixture({
  failingNpmCommand = 'run typecheck --prefix client',
  failingNpxCommand = '',
  delays = {},
} = {}) {
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
command="npm:$*"
printf '%s\\n' "$command" >> "$RELEASE_VALIDATION_EVENT_LOG"
printf '%s:start\\n' "$command" >> "$RELEASE_VALIDATION_EVENT_LOG"
case "$*" in
  'run build:parallel') delay="$RELEASE_VALIDATION_BUILD_DELAY" ;;
  'run typecheck --prefix client') delay="$RELEASE_VALIDATION_TYPECHECK_DELAY" ;;
  'run lint --prefix client') delay="$RELEASE_VALIDATION_LINT_DELAY" ;;
  'run test --prefix client') delay="$RELEASE_VALIDATION_CLIENT_TEST_DELAY" ;;
  'run test --prefix server') delay="$RELEASE_VALIDATION_SERVER_TEST_DELAY" ;;
  *) delay=0 ;;
esac
sleep "\${delay:-0}"
printf '%s:finish\\n' "$command" >> "$RELEASE_VALIDATION_EVENT_LOG"
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
command="npx:$*"
printf '%s\\n' "$command" >> "$RELEASE_VALIDATION_EVENT_LOG"
printf '%s:start\\n' "$command" >> "$RELEASE_VALIDATION_EVENT_LOG"
sleep "\${RELEASE_VALIDATION_ELECTRON_TEST_DELAY:-0}"
printf '%s:finish\\n' "$command" >> "$RELEASE_VALIDATION_EVENT_LOG"
if [ "$*" = "$RELEASE_VALIDATION_FAIL_NPX_COMMAND" ]; then
  printf 'fixture npx failure: %s\\n' "$*" >&2
  exit 43
fi
exit 0
`,
  );

  return {
    fixtureDirectory,
    binDirectory,
    eventLog,
    failingNpmCommand,
    failingNpxCommand,
    delays,
  };
}

function releaseEnvironment(fixture) {
  const environment = {
    ...process.env,
    PATH: `${fixture.binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
    RELEASE_VALIDATION_EVENT_LOG: fixture.eventLog,
    RELEASE_VALIDATION_FAIL_NPM_COMMAND: fixture.failingNpmCommand,
    RELEASE_VALIDATION_FAIL_NPX_COMMAND: fixture.failingNpxCommand,
    RELEASE_VALIDATION_BUILD_DELAY: fixture.delays.build ?? '0',
    RELEASE_VALIDATION_TYPECHECK_DELAY: fixture.delays.typecheck ?? '0',
    RELEASE_VALIDATION_LINT_DELAY: fixture.delays.lint ?? '0',
    RELEASE_VALIDATION_CLIENT_TEST_DELAY: fixture.delays.clientTest ?? '0',
    RELEASE_VALIDATION_SERVER_TEST_DELAY: fixture.delays.serverTest ?? '0',
    RELEASE_VALIDATION_ELECTRON_TEST_DELAY: fixture.delays.electronTest ?? '0',
  };

  delete environment.RELEASE_NOTES_PROVIDER_COMMAND;
  delete environment.RELEASE_NOTES_PROVIDER_ARGS;
  delete environment.RELEASE_NOTES_PROVIDER_EXPECTED_VERSION;
  return environment;
}

function runReleaseFixture(fixture, args = ['1.0.1', '--dry-run']) {
  const result = spawnSync(process.execPath, [releaseScript, ...args], {
    cwd: fixture.fixtureDirectory,
    encoding: 'utf8',
    env: releaseEnvironment(fixture),
  });
  const events = existsSync(fixture.eventLog)
    ? readFileSync(fixture.eventLog, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  return { result, events, output: `${result.stdout}\n${result.stderr}` };
}

function assertCommandOccurredBefore(events, earlierCommand, laterCommand) {
  assert.ok(events.indexOf(earlierCommand) >= 0, `missing event: ${earlierCommand}`);
  assert.ok(events.indexOf(laterCommand) >= 0, `missing event: ${laterCommand}`);
  assert.ok(
    events.indexOf(earlierCommand) < events.indexOf(laterCommand),
    `expected ${earlierCommand} before ${laterCommand}`,
  );
}

function assertNoReleaseMutation(events) {
  assert.equal(events.some((event) => /^git:(?:commit|push|tag -[ad])\b/.test(event)), false);
}

function assertDownstreamGatesStartAfterBuild(events) {
  const buildFinished = events.indexOf(lifecycleEvent(componentBuildCommand, 'finish'));
  assert.ok(buildFinished >= 0, `missing aggregate build completion: ${events.join(', ')}`);
  for (const command of downstreamValidationCommands) {
    const start = events.indexOf(lifecycleEvent(command, 'start'));
    assert.ok(start > buildFinished, `${command} started before aggregate build completed`);
  }
}

function assertBoundedConcurrency(events, maximum) {
  let active = 0;
  let observedMaximum = 0;
  for (const event of events) {
    if (!downstreamValidationCommands.some((command) => event === lifecycleEvent(command, 'start') || event === lifecycleEvent(command, 'finish'))) {
      continue;
    }
    if (event.endsWith(':start')) {
      active += 1;
      observedMaximum = Math.max(observedMaximum, active);
    } else {
      active -= 1;
    }
    assert.ok(active >= 0, `gate completed without an active process: ${event}`);
    assert.ok(active <= maximum, `active validation gates exceeded ${maximum}: ${events.join(', ')}`);
  }
  assert.equal(active, 0, `validation gates did not settle: ${events.join(', ')}`);
  assert.equal(observedMaximum, maximum, `expected to observe concurrency ${maximum}: ${events.join(', ')}`);
}

function assertStartedSiblingsSettled(events, commands) {
  for (const command of commands) {
    assert.ok(events.includes(lifecycleEvent(command, 'start')), `missing started sibling: ${command}`);
    assert.ok(events.includes(lifecycleEvent(command, 'finish')), `started sibling did not settle: ${command}`);
  }
}

test('fixture creation ignores an externally supplied root', () => {
  assert.match(fixtureRoot, new RegExp(`^${repositoryRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.review-artifacts/`));

  const fixture = createFixture();
  assert.equal(path.dirname(fixture.fixtureDirectory), fixtureRoot);
});

test('an external fixture-root environment value cannot redirect fixture writes', () => {
  const externalFixtureRoot = path.join(repositoryRoot, `release-validation-unsafe-target-${randomUUID()}`);
  const environment = { ...process.env, RELEASE_VALIDATION_FIXTURE_ROOT: externalFixtureRoot };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-name-pattern', '^fixture creation ignores an externally supplied root$', releaseValidationTestScript],
    { cwd: repositoryRoot, encoding: 'utf8', env: environment },
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /fixture creation ignores an externally supplied root/);
  assert.match(output, /pass 1/);
  assert.equal(existsSync(externalFixtureRoot), false, `fixture writer created ${externalFixtureRoot}`);
});

test('a failing aggregate component build aborts release validation before downstream gates', () => {
  const fixture = createFixture({ failingNpmCommand: 'run build:parallel' });
  const { result, events, output } = runReleaseFixture(fixture);

  assert.equal(result.status, 1, output);
  assert.match(output, /fixture npm failure: run build:parallel/);
  assert.ok(events.includes(componentBuildCommand));
  assert.equal(events.some((event) => downstreamValidationCommands.includes(event)), false);
  assertNoReleaseMutation(events);
  assert.equal(output.includes('Release Summary'), false);
});

test('a failing initial gate rejects before promotion, launches no queued gates, and settles started siblings', () => {
  const fixture = createFixture({
    delays: { typecheck: '0.05', lint: '0.20', clientTest: '0.20' },
  });
  const { result, events, output } = runReleaseFixture(fixture);

  assert.equal(result.status, 1, output);
  assert.match(output, /fixture npm failure: run typecheck --prefix client/);
  assertCommandOccurredBefore(events, lifecycleEvent(componentBuildCommand, 'finish'), lifecycleEvent('npm:run typecheck --prefix client', 'start'));
  assertStartedSiblingsSettled(events, parallelInitialGates);
  assert.equal(events.includes('npm:run test --prefix server'), false);
  assert.equal(events.includes('npx:--no-install vitest --config electron/vitest.config.ts run'), false);
  assertNoReleaseMutation(events);
  assert.equal(output.includes('Release Summary'), false);
});

test('a failing client test rejects before promotion and does not start queued gates', () => {
  const fixture = createFixture({
    failingNpmCommand: 'run test --prefix client',
    delays: { typecheck: '0.20', lint: '0.20', clientTest: '0.05' },
  });
  const { result, events, output } = runReleaseFixture(fixture);

  assert.equal(result.status, 1, output);
  assert.match(output, /fixture npm failure: run test --prefix client/);
  assert.ok(events.includes('npm:run test --prefix client'));
  assertCommandOccurredBefore(events, lifecycleEvent(componentBuildCommand, 'finish'), lifecycleEvent('npm:run test --prefix client', 'start'));
  assertStartedSiblingsSettled(events, parallelInitialGates);
  assert.equal(events.includes('npm:run test --prefix server'), false);
  assertNoReleaseMutation(events);
  assert.equal(output.includes('Release Summary'), false);
});

test('a failing server test rejects before promotion after its queued gate starts', () => {
  const fixture = createFixture({
    failingNpmCommand: 'run test --prefix server',
    delays: { typecheck: '0.20', lint: '0.25', clientTest: '0.05', serverTest: '0.05' },
  });
  const { result, events, output } = runReleaseFixture(fixture);

  assert.equal(result.status, 1, output);
  assert.match(output, /fixture npm failure: run test --prefix server/);
  assert.ok(events.includes('npm:run test --prefix client'));
  assert.ok(events.includes('npm:run test --prefix server'));
  assertCommandOccurredBefore(events, lifecycleEvent(componentBuildCommand, 'finish'), lifecycleEvent('npm:run test --prefix server', 'start'));
  assert.equal(events.includes('npx:--no-install vitest --config electron/vitest.config.ts run'), false);
  assertStartedSiblingsSettled(events, ['npm:run typecheck --prefix client', 'npm:run lint --prefix client']);
  assertNoReleaseMutation(events);
  assert.equal(output.includes('Release Summary'), false);
});

test('a failing Electron test rejects before promotion after its queued gate starts', () => {
  const fixture = createFixture({
    failingNpmCommand: '',
    failingNpxCommand: '--no-install vitest --config electron/vitest.config.ts run',
    delays: { typecheck: '0.20', lint: '0.05', clientTest: '0.10', electronTest: '0.05' },
  });
  const { result, events, output } = runReleaseFixture(fixture);

  assert.equal(result.status, 1, output);
  assert.match(output, /fixture npx failure: --no-install vitest --config electron\/vitest\.config\.ts run/);
  assert.ok(events.includes('npm:run lint --prefix client'));
  assert.ok(events.includes('npx:--no-install vitest --config electron/vitest.config.ts run'));
  assertCommandOccurredBefore(events, lifecycleEvent(componentBuildCommand, 'finish'), lifecycleEvent('npx:--no-install vitest --config electron/vitest.config.ts run', 'start'));
  assertNoReleaseMutation(events);
  assert.equal(output.includes('Release Summary'), false);
});

test('skip-validation labels all validation gates as skipped rather than passed', () => {
  const fixture = createFixture();
  const { result, events, output } = runReleaseFixture(fixture, ['1.0.1', '--dry-run', '--skip-validation']);

  assert.equal(result.status, 0, output);
  assert.match(output, /Skipping pre-release validation \(--skip-validation\)/);
  assert.equal(events.some((event) => /^(npm|npx):/.test(event)), false);
  assert.equal(events.includes(componentBuildCommand), false);
  assertNoReleaseMutation(events);
  assert.equal(output.includes('Pre-release validation complete!'), false);
  assert.equal(output.includes('Component builds passed!'), false);
  assert.equal(output.includes('Typecheck passed!'), false);
  assert.equal(output.includes('Lint passed!'), false);
  assert.equal(output.includes('Client tests passed!'), false);
  assert.equal(output.includes('Server tests passed!'), false);
  assert.equal(output.includes('Electron tests passed!'), false);
});

test('successful validation runs aggregate build before bounded parallel downstream gates without release mutation', () => {
  const fixture = createFixture({
    failingNpmCommand: '',
    failingNpxCommand: '',
    delays: { typecheck: '0.25', lint: '0.20', clientTest: '0.05', serverTest: '0.05', electronTest: '0.05' },
  });
  const { result, events, output } = runReleaseFixture(fixture);
  const validationEvents = events.filter((event) => validationCommandEvents.includes(event));

  assert.equal(result.status, 0, output);
  assert.deepEqual(validationEvents, validationCommandEvents);
  assertDownstreamGatesStartAfterBuild(events);
  const firstDownstreamCompletion = Math.min(
    ...parallelInitialGates.map((command) => events.indexOf(lifecycleEvent(command, 'finish'))),
  );
  for (const command of parallelInitialGates) {
    assert.ok(
      events.indexOf(lifecycleEvent(command, 'start')) < firstDownstreamCompletion,
      `${command} was not launched with the initial parallel gates`,
    );
  }
  assertBoundedConcurrency(events, 3);
  assertNoReleaseMutation(events);
});
