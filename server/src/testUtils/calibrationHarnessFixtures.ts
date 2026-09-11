import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fs.realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const reviewArtifactsRoot = path.join(repositoryRoot, '.review-artifacts');

export interface CalibrationHarnessFixtureProvider {
  readonly repositoryRoot: string;
  readonly fixtureParent: string;
  createInvocationRoot(identifier?: string): string;
  createExclusiveDirectory(parent: string, identifier?: string): string;
}

interface FixtureProviderOptions {
  /** Test-only label below the fixed repository-local .review-artifacts root. */
  parentName?: string;
}

function assertSinglePathSegment(identifier: string, label: string): void {
  if (
    identifier.length === 0
    || identifier === '.'
    || identifier === '..'
    || identifier.includes('/')
    || identifier.includes('\\')
    || path.basename(identifier) !== identifier
  ) {
    throw new Error(`${label} must be a single path segment`);
  }
}

function assertContainedWithoutSymlinkAncestors(root: string, candidate: string, allowRoot = false): void {
  const canonicalRoot = fs.realpathSync(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(canonicalRoot, resolvedCandidate);
  if (
    (!allowRoot && relative === '')
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error('fixture path must be a contained descendant');
  }

  let cursor = canonicalRoot;
  for (const segment of relative === '' ? [] : relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      const entry = fs.lstatSync(cursor);
      if (entry.isSymbolicLink()) {
        throw new Error('fixture path must not have a symbolic-link ancestor');
      }
      if (cursor !== resolvedCandidate && !entry.isDirectory()) {
        throw new Error('fixture path ancestor must be a directory');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function ensureControlledDirectory(directory: string): void {
  assertContainedWithoutSymlinkAncestors(repositoryRoot, directory);
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertContainedWithoutSymlinkAncestors(repositoryRoot, directory);
  if (!fs.lstatSync(directory).isDirectory()) {
    throw new Error('fixture parent must be a directory');
  }
}

export function createCalibrationHarnessFixtureProvider(
  { parentName = 'calibration-harness-fixtures' }: FixtureProviderOptions = {},
): CalibrationHarnessFixtureProvider {
  assertSinglePathSegment(parentName, 'fixture parent name');
  const fixtureParent = path.join(reviewArtifactsRoot, parentName);

  function initializeFixtureParent(): void {
    ensureControlledDirectory(reviewArtifactsRoot);
    ensureControlledDirectory(fixtureParent);
  }

  function createExclusiveDirectory(parent: string, identifier: string = randomUUID()): string {
    initializeFixtureParent();
    assertSinglePathSegment(identifier, 'fixture identifier');
    assertContainedWithoutSymlinkAncestors(fixtureParent, parent, true);
    const directory = path.join(parent, identifier);
    assertContainedWithoutSymlinkAncestors(fixtureParent, directory);
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('exclusive fixture collision');
      }
      throw error;
    }
    assertContainedWithoutSymlinkAncestors(fixtureParent, directory);
    return directory;
  }

  return {
    repositoryRoot,
    fixtureParent,
    createInvocationRoot(identifier: string = randomUUID()): string {
      return createExclusiveDirectory(fixtureParent, identifier);
    },
    createExclusiveDirectory,
  };
}

export async function listenLoopback(app: RequestListener): Promise<Server> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string' || address.address !== '127.0.0.1' || address.port <= 0) {
    await closeLoopbackServer(server);
    throw new Error('owned test server did not expose a loopback TCP address');
  }
  return server;
}

export async function closeLoopbackServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
