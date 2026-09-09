import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientDirectory = path.join(repositoryRoot, 'client');
const fixtureDirectory = path.join(
  repositoryRoot,
  '.review-artifacts',
  'client-typecheck-contract-01',
);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function writeFixture(name, source) {
  const sourcePath = path.join(fixtureDirectory, `${name}.ts`);
  const configPath = path.join(fixtureDirectory, `${name}.tsconfig.json`);

  writeFileSync(sourcePath, source);
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          noEmit: true,
          incremental: false,
          skipLibCheck: true,
        },
        files: [sourcePath],
      },
      null,
      2,
    ) + '\n',
  );

  return configPath;
}

function runTypecheck(configPath) {
  return execFileSync(
    npmCommand,
    ['run', 'typecheck', '--', '--project', configPath],
    {
      cwd: clientDirectory,
      encoding: 'utf8',
      stdio: 'pipe',
    },
  );
}

test('client typecheck npm script rejects TypeScript errors outside Vite transpilation', () => {
  mkdirSync(fixtureDirectory, { recursive: true });
  const validConfig = writeFixture('valid', 'export const answer: number = 42;\n');
  const invalidConfig = writeFixture(
    'invalid',
    'export const answer: number = "not a number";\n',
  );
  const packageJson = JSON.parse(
    readFileSync(path.join(clientDirectory, 'package.json'), 'utf8'),
  );
  const typecheckScript = packageJson.scripts?.typecheck;

  assert.equal(typeof typecheckScript, 'string', 'client package must define typecheck');
  assert.match(typecheckScript, /(?:^|\s)tsc(?:\s|$)/, 'typecheck must invoke tsc');
  assert.match(
    typecheckScript,
    /--project\s+tsconfig\.app\.json(?:\s|$)/,
    'typecheck must target the client application configuration',
  );
  assert.match(typecheckScript, /--noEmit(?:\s|$)/, 'typecheck must disable emit');
  assert.match(
    typecheckScript,
    /--incremental(?:\s+)false(?:\s|$)/,
    'typecheck must disable incremental cache writes',
  );

  assert.doesNotThrow(() => runTypecheck(validConfig));
  assert.throws(
    () => runTypecheck(invalidConfig),
    (error) => {
      const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      return /invalid\.ts/.test(output) && /TS2322/.test(output);
    },
    'the npm typecheck script must reject an invalid fixture',
  );
});
