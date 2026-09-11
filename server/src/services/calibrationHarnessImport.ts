import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import {
  CALIBRATION_HARNESS_LIMITS,
  type CalibrationHarnessJsonObject,
  type CalibrationHarnessRevision,
  type CalibrationHarnessSnapshot,
  validateCalibrationHarnessSnapshot,
} from '../../../shared/calibrationHarness.js';
import { createCalibrationHarnessStore } from '../db/calibrationHarnessStore.js';

const EXPORT_SCHEMA = 'proxxied-mpc-calibration-backup/v1';
const METADATA_FILENAME = 'calibration-data.json';
const ASSET_DIRECTORY = 'assets';
const MAX_READ_CHUNK_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type JsonRecord = Record<string, unknown>;

type ExportAsset = JsonRecord & {
  id: string;
  bytes: number;
  file: string;
  sha256: string;
};

export interface CalibrationHarnessImportRequest {
  /** An already opened and initialized calibration-harness SQLite database. */
  database: Database.Database;
  ownerId: string;
  harnessId: string;
  /** null is create-only; a number must name the exact current revision. */
  expectedRevision: number | null;
  /** A verified, synthetic or operator-provided export directory. */
  sourceDirectory: string;
  /** SHA-256 supplied by the caller's independently verified export anchor. */
  expectedMetadataSha256: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainRecord(value: unknown, label: string): JsonRecord {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireSafeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be a safe integer at least ${minimum}`);
  }
  return value as number;
}

function requireLowercaseSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertInitializedDatabase(database: Database.Database): void {
  const table = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mpc_harnesses'",
  ).get();
  if (table === undefined) {
    throw new TypeError('Calibration harness import requires an initialized calibration-harness database');
  }
}

function assertLiteralRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0
    || path.isAbsolute(relativePath)
    || relativePath.includes('\\')
    || relativePath.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('Calibration harness export file path must be a literal contained POSIX relative path');
  }
}

interface SourceRoot {
  path: string;
  realpath: string;
  dev: number;
  ino: number;
}

function sourceRoot(sourceDirectory: unknown): SourceRoot {
  if (typeof sourceDirectory !== 'string' || sourceDirectory.length === 0) {
    throw new TypeError('Calibration harness import sourceDirectory must be a nonempty string');
  }
  const resolved = path.resolve(sourceDirectory);
  const entry = fs.lstatSync(resolved);
  const realpath = fs.realpathSync(resolved);
  if (entry.isSymbolicLink() || !entry.isDirectory() || realpath !== resolved) {
    throw new Error('Calibration harness import sourceDirectory must be a real non-symlink directory');
  }
  return { path: resolved, realpath, dev: entry.dev, ino: entry.ino };
}

function assertStableSourceRoot(root: SourceRoot): void {
  const current = fs.lstatSync(root.path);
  if (
    current.isSymbolicLink()
    || !current.isDirectory()
    || current.dev !== root.dev
    || current.ino !== root.ino
    || fs.realpathSync(root.path) !== root.realpath
  ) {
    throw new Error('Calibration harness import sourceDirectory changed during access');
  }
}

function containedCandidate(root: SourceRoot, relativePath: string): string {
  assertStableSourceRoot(root);
  assertLiteralRelativePath(relativePath);
  const candidate = path.resolve(root.path, relativePath);
  const relative = path.relative(root.path, candidate);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Calibration harness export file must be contained by sourceDirectory');
  }
  return candidate;
}

interface PathIdentity {
  path: string;
  dev: number;
  ino: number;
}

interface NonsymlinkPath {
  entry: fs.Stats;
  ancestors: PathIdentity[];
}

function assertNonsymlinkPath(
  root: string,
  candidate: string,
  expectedAncestors?: readonly PathIdentity[],
): NonsymlinkPath {
  const relative = path.relative(root, candidate);
  let cursor = root;
  const ancestors: PathIdentity[] = [];
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const entry = fs.lstatSync(cursor);
    if (entry.isSymbolicLink()) throw new Error('Calibration harness export file must not use symbolic links');
    if (cursor !== candidate) {
      if (!entry.isDirectory()) {
        throw new Error('Calibration harness export path ancestor must be a directory');
      }
      const expected = expectedAncestors?.[ancestors.length];
      if (expected !== undefined && (entry.dev !== expected.dev || entry.ino !== expected.ino)) {
        throw new Error('Calibration harness export path ancestor changed during access');
      }
      ancestors.push({ path: cursor, dev: entry.dev, ino: entry.ino });
      continue;
    }
    return { entry, ancestors };
  }
  throw new Error('Calibration harness export path resolution failed');
}

function readBoundedContainedFile(root: SourceRoot, relativePath: string, maximumBytes: number): Buffer {
  const candidate = containedCandidate(root, relativePath);
  const before = assertNonsymlinkPath(root.path, candidate);
  if (!before.entry.isFile() || before.entry.size > maximumBytes) {
    throw new Error('Calibration harness export file is not a regular file within its configured limit');
  }

  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const nonBlocking = typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0;
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.entry.dev || opened.ino !== before.entry.ino || opened.size !== before.entry.size) {
      throw new Error('Calibration harness export file changed before descriptor verification');
    }
    assertStableSourceRoot(root);
    assertNonsymlinkPath(root.path, candidate, before.ancestors);
    const output = Buffer.allocUnsafe(opened.size);
    let total = 0;
    while (total < output.byteLength) {
      const read = fs.readSync(
        descriptor,
        output,
        total,
        Math.min(MAX_READ_CHUNK_BYTES, output.byteLength - total),
        null,
      );
      if (read === 0) break;
      total += read;
    }
    const after = fs.fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || total !== opened.size) {
      throw new Error('Calibration harness export file changed while being read');
    }
    assertStableSourceRoot(root);
    assertNonsymlinkPath(root.path, candidate, before.ancestors);
    return output;
  } finally {
    fs.closeSync(descriptor);
  }
}

function exportAsset(asset: unknown, index: number): ExportAsset {
  const record = requirePlainRecord(asset, `export assets[${index}]`);
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new Error(`export assets[${index}].id must be a nonempty string`);
  }
  const bytes = requireSafeInteger(record.bytes, `export assets[${index}].bytes`);
  if (bytes > CALIBRATION_HARNESS_LIMITS.maxAssetBytes) {
    throw new Error(`export assets[${index}].bytes exceeds the asset limit`);
  }
  if (typeof record.file !== 'string') throw new Error(`export assets[${index}].file must be a string`);
  const expectedFilename = `${sha256(Buffer.from(record.id, 'utf8'))}.blob`;
  if (record.file !== `${ASSET_DIRECTORY}/${expectedFilename}`) {
    throw new Error(`export assets[${index}].file does not match its literal id-derived filename`);
  }
  requireLowercaseSha256(record.sha256, `export assets[${index}].sha256`);
  if (record.byteLength !== undefined && record.byteLength !== bytes) {
    throw new Error(`export assets[${index}].byteLength conflicts with export bytes`);
  }
  return record as ExportAsset;
}

function wireSnapshot(metadata: unknown): { snapshot: CalibrationHarnessSnapshot; assets: ExportAsset[] } {
  const exportRecord = requirePlainRecord(metadata, 'calibration export metadata');
  if (exportRecord.schema !== EXPORT_SCHEMA) throw new Error('Calibration harness export has an unsupported schema');
  requireSafeInteger(exportRecord.databaseVersion, 'calibration export databaseVersion', 1);
  const datasets = requireArray(exportRecord.datasets, 'calibration export datasets');
  const cases = requireArray(exportRecord.cases, 'calibration export cases');
  const exportedAssets = requireArray(exportRecord.assets, 'calibration export assets');
  const runs = requireArray(exportRecord.runs, 'calibration export runs');
  const assetBytes = requireSafeInteger(exportRecord.assetBytes, 'calibration export assetBytes');
  if (exportRecord.version !== undefined && exportRecord.version !== 1) {
    throw new Error('Calibration harness export version conflicts with wire version 1');
  }

  let countedBytes = 0;
  const assets = exportedAssets.map((asset, index) => {
    const exported = exportAsset(asset, index);
    countedBytes += exported.bytes;
    if (!Number.isSafeInteger(countedBytes) || countedBytes > Number.MAX_SAFE_INTEGER) {
      throw new Error('Calibration harness export asset byte count exceeds safe integer range');
    }
    return { ...exported, byteLength: exported.bytes };
  });
  if (countedBytes !== assetBytes) throw new Error('Calibration harness export assetBytes does not match asset lengths');

  const snapshot = validateCalibrationHarnessSnapshot({
    ...exportRecord,
    version: 1,
    datasets,
    cases,
    assets,
    runs,
  } as CalibrationHarnessJsonObject);
  return { snapshot, assets: assets as ExportAsset[] };
}

function parseMetadata(root: SourceRoot, expectedMetadataSha256: unknown): { snapshot: CalibrationHarnessSnapshot; assets: ExportAsset[] } {
  const expected = requireLowercaseSha256(expectedMetadataSha256, 'expectedMetadataSha256');
  const bytes = readBoundedContainedFile(root, METADATA_FILENAME, CALIBRATION_HARNESS_LIMITS.maxMetadataBytes);
  if (sha256(bytes) !== expected) throw new Error('Calibration harness export metadata digest does not match the caller-provided anchor');
  let metadata: unknown;
  try {
    metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('Calibration harness export metadata is invalid UTF-8 or JSON');
  }
  return wireSnapshot(metadata);
}

/**
 * Imports a verified portable calibration export into an explicit initialized
 * database. Source bytes are read serially during the store-owned IMMEDIATE
 * transaction; each source read requests at most 1 MiB into one bounded full
 * asset Buffer (32 MiB maximum). Blob deduplication can transiently hold one
 * additional bounded existing blob while it verifies immutable bytes; this is
 * not a one-buffer heap bound. No source path is modified. POSIX descriptor
 * no-follow is used where Node exposes it; path/root checks remain a
 * best-effort TOCTOU defense rather than a universal filesystem sandbox.
 */
export function importCalibrationHarnessBundle(request: CalibrationHarnessImportRequest): CalibrationHarnessRevision {
  if (request === null || typeof request !== 'object') {
    throw new TypeError('Calibration harness import requires an explicit request object');
  }
  assertInitializedDatabase(request.database);
  const root = sourceRoot(request.sourceDirectory);
  const { snapshot, assets } = parseMetadata(root, request.expectedMetadataSha256);
  const store = createCalibrationHarnessStore(request.database);
  return store.publishWithAssets(
    request.ownerId,
    request.harnessId,
    request.expectedRevision,
    snapshot,
    (blobs) => {
      for (const asset of assets) {
        const bytes = readBoundedContainedFile(root, asset.file, CALIBRATION_HARNESS_LIMITS.maxAssetBytes);
        if (bytes.byteLength !== asset.bytes || sha256(bytes) !== asset.sha256) {
          throw new Error(`Calibration harness export asset ${asset.id} has a mismatched byte length or digest`);
        }
        blobs.put(asset.sha256, bytes);
      }
    },
  );
}
