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

function createFixture() {
  const fixtureDirectory = path.join(fixtureRoot, `typecheck-failure-${randomUUID()}`);
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
if [ "$1 $2 $3 $4" = 'run typecheck --prefix client' ]; then
  printf 'fixture typecheck failure\\n' >&2
  exit 42
fi
exit 0
`,
  );

  return { fixtureDirectory, binDirectory, eventLog };
}

function releaseEnvironment(fixture) {
  const environment = {
    ...process.env,
    PATH: `${fixture.binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
    RELEASE_VALIDATION_EVENT_LOG: fixture.eventLog,
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
  assert.match(output, /fixture typecheck failure/);
  assert.ok(events.includes('npm:run typecheck --prefix client'));
  assert.equal(events.includes('npm:run lint --prefix client'), false);
  assert.equal(events.some((event) => /^git:(?:commit|push|tag -[ad])\b/.test(event)), false);
  assert.equal(output.includes('Release Summary'), false);
});
