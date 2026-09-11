#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FINAL_BASENAME = 'calibration-harness.db';
const SHA256 = /^[0-9a-f]{64}$/;

export class PublicationUncertaintyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublicationUncertaintyError';
    this.publicationMayBeVisible = true;
  }
}

function fail(message) {
  throw new Error(message);
}

function assertSafeTargetDirectory(directory) {
  if (typeof directory !== 'string' || directory.length === 0) fail('targetDirectory must be an explicit nonempty path');
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const entry = fs.lstatSync(cursor);
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail('targetDirectory has an unsafe ancestor');
  }
  if (fs.realpathSync(resolved) !== resolved) fail('targetDirectory must not resolve through a symbolic link');
  return resolved;
}

function captureDirectoryIdentity(directory) {
  const resolved = assertSafeTargetDirectory(directory);
  const entry = fs.lstatSync(resolved);
  return { directory: resolved, dev: entry.dev, ino: entry.ino };
}

function assertDirectoryIdentity(identity) {
  const resolved = assertSafeTargetDirectory(identity.directory);
  const entry = fs.lstatSync(resolved);
  if (entry.dev !== identity.dev || entry.ino !== identity.ino) {
    fail('targetDirectory identity changed during publication');
  }
  return resolved;
}

function assertAbsentPublicationPaths(directory) {
  for (const basename of [FINAL_BASENAME, `${FINAL_BASENAME}-wal`, `${FINAL_BASENAME}-shm`, `${FINAL_BASENAME}-journal`]) {
    try {
      fs.lstatSync(path.join(directory, basename));
      fail('publication target or SQLite sidecar already exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function assertExpected(expectedBytes, expectedSha256) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) fail('expectedBytes must be a finite nonnegative safe integer');
  if (typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256)) fail('expectedSha256 must be lowercase SHA-256');
}

function fsyncDirectory(identity) {
  const directory = assertDirectoryIdentity(identity);
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isDirectory() || opened.dev !== identity.dev || opened.ino !== identity.ino) {
      fail('targetDirectory identity changed before directory fsync');
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  assertDirectoryIdentity(identity);
}

function asBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  fail('stdin yielded a non-byte chunk');
}

function writeAll(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) fail('could not write publisher temporary file');
    offset += written;
  }
}

function sameIdentity(filename, identity) {
  const current = fs.lstatSync(filename);
  return current.isFile() && current.dev === identity.dev && current.ino === identity.ino;
}

/**
 * Streams one explicit sealed byte sequence into an existing controlled directory.
 * It never creates the target directory and never overwrites the final database.
 * Failures before hard-link publication retain the current-run temporary input.
 * Failures after the hard link report uncertainty because the final name may be visible.
 */
export async function publishCalibrationHarnessDatabase({
  targetDirectory,
  expectedBytes,
  expectedSha256,
  input,
  onAfterLink,
} = {}) {
  assertExpected(expectedBytes, expectedSha256);
  if (input === null || typeof input?.[Symbol.asyncIterator] !== 'function' && typeof input?.[Symbol.iterator] !== 'function') {
    fail('input must be an iterable or async iterable of bytes');
  }
  const directoryIdentity = captureDirectoryIdentity(targetDirectory);
  const directory = directoryIdentity.directory;
  assertAbsentPublicationPaths(directory);
  const temporaryPath = path.join(directory, `.${FINAL_BASENAME}.${randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
  let temporaryIdentity;
  let linked = false;
  try {
    const hash = createHash('sha256');
    let total = 0;
    for await (const chunk of input) {
      assertDirectoryIdentity(directoryIdentity);
      const bytes = asBuffer(chunk);
      if (bytes.byteLength > expectedBytes - total) fail('stdin contains more bytes than expected');
      writeAll(descriptor, bytes);
      hash.update(bytes);
      total += bytes.byteLength;
    }
    if (total !== expectedBytes) fail('stdin ended before the expected byte length');
    if (hash.digest('hex') !== expectedSha256) fail('stdin SHA-256 does not match expectedSha256');
    fs.fsyncSync(descriptor);
    temporaryIdentity = fs.fstatSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }

  const finalPath = path.join(directory, FINAL_BASENAME);
  try {
    assertDirectoryIdentity(directoryIdentity);
    assertAbsentPublicationPaths(directory);
    if (!sameIdentity(temporaryPath, temporaryIdentity)) fail('publisher temporary identity changed before publication');
    fs.linkSync(temporaryPath, finalPath);
    linked = true;
  } catch (error) {
    if (linked) throw new PublicationUncertaintyError('publication may be visible after hard-link failure');
    if (error?.code === 'EEXIST') fail('publication target was claimed by another writer; winner preserved');
    throw error;
  }

  try {
    await onAfterLink?.({ finalPath, temporaryPath, byteLength: expectedBytes, sha256: expectedSha256 });
    assertDirectoryIdentity(directoryIdentity);
    if (!sameIdentity(finalPath, temporaryIdentity)) throw new Error('published final identity changed after hard-link publication');
    fsyncDirectory(directoryIdentity);
    assertDirectoryIdentity(directoryIdentity);
    if (!sameIdentity(finalPath, temporaryIdentity)) throw new Error('published final identity changed after directory fsync');
    if (!sameIdentity(temporaryPath, temporaryIdentity)) throw new Error('publisher temporary identity changed after publication');
    fs.unlinkSync(temporaryPath);
    fsyncDirectory(directoryIdentity);
    assertDirectoryIdentity(directoryIdentity);
    if (!sameIdentity(finalPath, temporaryIdentity)) throw new Error('published final identity changed after temporary cleanup');
    try {
      fs.lstatSync(temporaryPath);
      throw new Error('publisher temporary path remained after cleanup');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  } catch (error) {
    if (error instanceof PublicationUncertaintyError) throw error;
    throw new PublicationUncertaintyError(`publication is visible but final durability or cleanup is uncertain: ${error?.message ?? 'unknown error'}`);
  }
  return { status: 'published', targetPath: finalPath, byteLength: expectedBytes, sha256: expectedSha256 };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!['--target-directory', '--expected-bytes', '--expected-sha256'].includes(option) || typeof value !== 'string' || values.has(option)) {
      fail('usage: --target-directory DIRECTORY --expected-bytes BYTES --expected-sha256 SHA256 < stdin');
    }
    values.set(option, value);
  }
  if (values.size !== 3) fail('missing publisher arguments');
  if (!/^(?:0|[1-9][0-9]*)$/.test(values.get('--expected-bytes'))) fail('expectedBytes must be decimal');
  const expectedBytes = Number(values.get('--expected-bytes'));
  return { targetDirectory: values.get('--target-directory'), expectedBytes, expectedSha256: values.get('--expected-sha256'), input: process.stdin };
}

async function main() {
  const result = await publishCalibrationHarnessDatabase(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(error instanceof PublicationUncertaintyError ? 'calibration database publication uncertain\n' : 'calibration database publication failed\n');
    process.exitCode = 1;
  });
}
