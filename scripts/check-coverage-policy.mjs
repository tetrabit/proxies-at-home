import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..');

const BASELINE_SCRIPTS = [
  'coverage:client:baseline',
  'coverage:server:baseline',
  'coverage:electron:baseline',
  'coverage:shared:baseline',
  'coverage:baseline',
];

const ENFORCEMENT_SCRIPTS = [
  'coverage:client',
  'coverage:server',
  'coverage:electron',
  'coverage:shared',
  'coverage:all',
];

const CONFIG_FRAGMENTS = {
  'client/vite.config.ts': [
    "'src/**/*.{ts,tsx}'",
    "'**/*.test.{ts,tsx}'",
    "'**/vitest.setup.ts'",
    "'**/vite-env.d.ts'",
    "'**/main.tsx'",
    "'**/*.worker.ts'",
  ],
  'server/vitest.config.ts': ["'src/**/*.ts'", "'**/*.test.ts'"],
  'electron/vitest.config.ts': [
    "'electron/*.{ts,cts}'",
    "'electron/*.test.ts'",
  ],
  'shared/vitest.config.ts': [
    "'shared/**/*.ts'",
    "'**/*.test.ts'",
    "'**/*.d.ts'",
    "'**/schema.d.ts'",
    "'**/types.ts'",
  ],
};

const POLICY_FRAGMENTS = [
  'client/src/**/*.{ts,tsx}',
  'server/src/**/*.ts',
  'electron/*.{ts,cts}',
  'shared/**/*.ts',
  '**/*.test.{ts,tsx}',
  '**/vitest.setup.ts',
  '**/vite-env.d.ts',
  '**/main.tsx',
  '**/*.worker.ts',
  '**/*.test.ts',
  '**/*.d.ts',
  '**/schema.d.ts',
  '**/types.ts',
  'bleed.webgl.worker.ts',
  'effect.worker.ts',
  'pdf.worker.ts',
  'Source-level V8 directives',
];

function requireFragments(label, text, fragments) {
  const missing = fragments.filter((fragment) => !text.includes(fragment));
  if (missing.length > 0) {
    throw new Error(`${label} is missing coverage contract fragments: ${missing.join(', ')}`);
  }
}

function walkSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return walkSourceFiles(entryPath);
    }
    return /\.(?:cts|ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

export function checkCoveragePolicy(root = REPOSITORY_ROOT) {
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const scripts = packageJson.scripts ?? {};

  for (const script of [...BASELINE_SCRIPTS, ...ENFORCEMENT_SCRIPTS]) {
    if (typeof scripts[script] !== 'string' || scripts[script].trim() === '') {
      throw new Error(`package.json is missing required coverage script: ${script}`);
    }
  }

  for (const [relativePath, fragments] of Object.entries(CONFIG_FRAGMENTS)) {
    const contents = readFileSync(path.join(root, relativePath), 'utf8');
    requireFragments(relativePath, contents, fragments);
  }

  const policy = readFileSync(path.join(root, 'docs/TEST_COVERAGE.md'), 'utf8');
  requireFragments('docs/TEST_COVERAGE.md', policy, POLICY_FRAGMENTS);

  const sourceRoots = [
    path.join(root, 'client/src'),
    path.join(root, 'server/src'),
    path.join(root, 'electron'),
    path.join(root, 'shared'),
  ];
  const fileLevelIgnores = sourceRoots
    .flatMap(walkSourceFiles)
    .flatMap((filePath) => {
      const matchingLines = readFileSync(filePath, 'utf8')
        .split('\n')
        .filter((line) => line.includes('v8 ignore file'));
      return matchingLines.map((line) => ({ filePath, line }));
    });

  const malformedIgnores = fileLevelIgnores.filter(
    ({ line }) => !line.includes(' -- ') || !line.includes('@preserve')
  );
  if (malformedIgnores.length > 0) {
    throw new Error(
      `File-level V8 exclusions require an inline rationale and @preserve: ${malformedIgnores
        .map(({ filePath }) => path.relative(root, filePath))
        .join(', ')}`
    );
  }

  return {
    scopes: ['client', 'server', 'electron', 'shared'],
    baselineScripts: [...BASELINE_SCRIPTS],
    enforcementScripts: [...ENFORCEMENT_SCRIPTS],
    fileLevelIgnoreCount: fileLevelIgnores.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(checkCoveragePolicy(), null, 2));
}
