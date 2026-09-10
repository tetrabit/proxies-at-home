import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ownedGeneratedPaths = ['dist', '.tsbuildinfo'];
const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function ownedPath(name) {
  return join(serverRoot, name);
}

function assertGeneratedDirectory(name) {
  const target = ownedPath(name);
  if (!existsSync(target)) {
    return;
  }

  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Refusing to use generated path that is not a real directory: ${target}`);
  }
}

function clean() {
  for (const name of ownedGeneratedPaths) {
    rmSync(ownedPath(name), { recursive: true, force: true });
  }
}

function build() {
  for (const name of ownedGeneratedPaths) {
    assertGeneratedDirectory(name);
  }

  mkdirSync(ownedPath('.tsbuildinfo'), { recursive: true });
  mkdirSync(ownedPath('cardbacks'), { recursive: true });

  const compiler = spawnSync('tsc', ['-p', 'tsconfig.build.json'], {
    cwd: serverRoot,
    stdio: 'inherit',
  });
  if (compiler.error) {
    throw compiler.error;
  }
  if (compiler.status !== 0) {
    process.exitCode = compiler.status ?? 1;
    return;
  }

  const outputCardbacks = join(ownedPath('dist'), 'server', 'cardbacks');
  mkdirSync(dirname(outputCardbacks), { recursive: true });
  cpSync(ownedPath('cardbacks'), outputCardbacks, { recursive: true });
}

const [action, ...arguments_] = process.argv.slice(2);
if (arguments_.length !== 0 || (action !== 'build' && action !== 'clean')) {
  throw new Error('Usage: node scripts/server-build.mjs <build|clean>');
}

if (action === 'clean') {
  clean();
} else {
  build();
}
