#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'proxies-at-home-server:latest';
const IMAGE_ID = 'sha256:3f6a94ccd23cc49e83b2708e9875500127cca9b7ebc13db8f7e968ee899a5088';
const VOLUME = 'proxies-at-home_server-data';
const TARGET = '/canonical/calibration-harness.db';
const EXPORT_ROOT = path.join(ROOT, '.recovery', 'mpc-calibration-origin-47ff4d57-2bbb-436d-b347-a11f65e6ac4e');
const ARTIFACT_PARENT = path.join(ROOT, '.review-artifacts', 'td-80f260');

export const LIVE_EXPECTED = Object.freeze({
  ownerId: '8826a106-72a7-420a-b63b-b0e250e9e409',
  harnessId: 'be894898-80c6-45d3-af00-eaea874ffcfc',
  metadataSha256: 'a6a58236e8a737ce602786b7e040912ac43020b49f468b9135f6bd1032eaf416',
  snapshotSha256: '3bb05048e67fbb14d341a48771fd8fd10243694cdbafd9f5e6c101a9dc7afb57',
  schemaSha256: '4da1dac127d9a6d6cdcbc76e7b0d12ebc8454c5bf0b92137765d083224b7a582',
  logicalCounts: { datasets: 1, cases: 124, assets: 7227, runs: 25 },
  counts: { datasets: 1, cases: 124, assets: 7227, runs: 25, blobs: 5817 },
  requiredPermanentCredentials: 1,
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(`canonical preservation verifier: ${message}`); };

function identity(filename) {
  const value = fs.lstatSync(filename, { bigint: true });
  assert.ok(value.isFile() && !value.isSymbolicLink(), `${filename} must be a regular non-symlink file`);
  return Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map((key) => [key, value[key].toString()]));
}

function equal(value, expected, message) {
  if (value !== expected) fail(message);
}

function safeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`);
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry) ?? 'null').join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().flatMap((key) => {
      const serialized = canonicalJson(value[key]);
      return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
    }).join(',')}}`;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  return JSON.stringify(value);
}

export function canonicalPreservationSnapshotJson(metadata) {
  const serialized = canonicalJson({
    ...metadata,
    version: 1,
    datasets: metadata.datasets,
    cases: metadata.cases,
    assets: metadata.assets.map((asset) => ({ ...asset, byteLength: asset.bytes })),
    runs: metadata.runs,
  });
  if (serialized === undefined) fail('preserved export snapshot cannot be canonicalized');
  return serialized;
}

function requiredArray(metadata, name) {
  if (!Array.isArray(metadata?.[name])) fail(`preserved export ${name} must be an array`);
  return metadata[name];
}

function readFrame(reader) {
  const bytes = reader.readU64();
  safeCount(bytes, 'frame length');
  return reader.readExact(bytes);
}

function readExactAsset(reader, asset, blob) {
  const length = reader.readU64();
  equal(length, asset.bytes, `preserved export length differs for logical asset ${asset.id}`);
  const sourceHash = createHash('sha256');
  for (let offset = 0; offset < length;) {
    const size = Math.min(1024 * 1024, length - offset);
    const chunk = reader.readExact(size);
    if (!Buffer.from(blob).subarray(offset, offset + size).equals(chunk)) {
      fail(`immutable BLOB differs from preserved export for logical asset ${asset.id}`);
    }
    sourceHash.update(chunk);
    offset += size;
  }
  equal(sourceHash.digest('hex'), asset.sha256, `preserved export SHA-256 differs for logical asset ${asset.id}`);
}

function validateSessions(database, expected) {
  const rows = database.prepare(`
    SELECT token_hash, owner_id, harness_id, created_at, expires_at
    FROM mpc_harness_sessions
    ORDER BY token_hash
  `).all();
  let permanentCredentials = 0;
  let finiteBrowserSessions = 0;
  for (const row of rows) {
    if (typeof row.token_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.token_hash)) fail('authentication row has an invalid token hash');
    equal(row.owner_id, expected.ownerId, 'authentication row has an unexpected owner');
    equal(row.harness_id, expected.harnessId, 'authentication row has an unexpected harness');
    if (!Number.isSafeInteger(row.created_at)) fail('authentication row has an invalid creation timestamp');
    if (row.expires_at === -1) {
      permanentCredentials += 1;
    } else {
      if (!Number.isSafeInteger(row.expires_at) || row.expires_at <= row.created_at) {
        fail('browser session must have a finite expiry after its creation timestamp');
      }
      finiteBrowserSessions += 1;
    }
  }
  equal(permanentCredentials, expected.requiredPermanentCredentials, 'permanent credential count differs from the authorized post-provision state');
  return { total: rows.length, permanentCredentials, finiteBrowserSessions };
}

/**
 * Checks immutable calibration data against the framed preserved export. The only
 * tolerated mutable rows are the authorized server credential and browser sessions.
 * It intentionally never compares a whole SQLite-file hash, because live WAL/session
 * changes are legitimate after activation.
 */
export function verifyCanonicalFramedDatabase(database, expected, reader) {
  if (database.readonly !== true) fail('database connection must be readonly');
  database.pragma('query_only = ON');
  equal(database.pragma('query_only', { simple: true }), 1, 'SQLite query_only must be enabled');
  database.pragma('foreign_keys = ON');
  let transactionOpen = false;
  try {
    database.exec('BEGIN');
    transactionOpen = true;
    equal(database.pragma('user_version', { simple: true }), 1, 'unexpected SQLite schema version');
    equal(database.pragma('integrity_check', { simple: true }), 'ok', 'SQLite integrity check failed');
    assert.deepEqual(database.pragma('foreign_key_check'), [], 'SQLite foreign-key check failed');

    const metadataBytes = readFrame(reader);
    equal(sha256(metadataBytes), expected.metadataSha256, 'preserved export metadata SHA-256 differs');
    const metadata = JSON.parse(metadataBytes.toString('utf8'));
    const datasets = requiredArray(metadata, 'datasets');
    const cases = requiredArray(metadata, 'cases');
    const assets = requiredArray(metadata, 'assets');
    const runs = requiredArray(metadata, 'runs');
    assert.deepEqual({ datasets: datasets.length, cases: cases.length, assets: assets.length, runs: runs.length }, expected.logicalCounts, 'preserved export logical counts differ');
    const snapshot = canonicalPreservationSnapshotJson(metadata);
    equal(sha256(Buffer.from(snapshot)), expected.snapshotSha256, 'preserved export snapshot SHA-256 differs');

    const catalog = database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name').all();
    equal(sha256(Buffer.from(JSON.stringify(catalog))), expected.schemaSha256, 'SQLite schema catalog SHA-256 differs');

    const current = database.prepare('SELECT owner_id, harness_id, revision, snapshot_json FROM mpc_harnesses ORDER BY owner_id, harness_id').all();
    assert.deepEqual(current, [{ owner_id: expected.ownerId, harness_id: expected.harnessId, revision: 1, snapshot_json: snapshot }], 'immutable current snapshot differs');
    const history = database.prepare('SELECT owner_id, harness_id, revision, snapshot_json, digest FROM mpc_harness_revisions ORDER BY owner_id, harness_id, revision').all();
    assert.deepEqual(history, [{ owner_id: expected.ownerId, harness_id: expected.harnessId, revision: 1, snapshot_json: snapshot, digest: expected.snapshotSha256 }], 'immutable history snapshot differs');

    const totalBlobs = database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_blobs').get().count;
    equal(totalBlobs, expected.counts.blobs, 'immutable BLOB count differs');
    equal(database.prepare('SELECT COUNT(*) AS count FROM mpc_harness_blobs WHERE owner_id = ?').get(expected.ownerId).count, expected.counts.blobs, 'immutable BLOB owner scope differs');
    const getBlob = database.prepare('SELECT data, byte_length FROM mpc_harness_blobs WHERE owner_id = ? AND sha256 = ?');
    const unique = new Map();
    let logicalAssetsVerified = 0;
    for (const asset of assets) {
      if (typeof asset?.id !== 'string' || typeof asset?.file !== 'string' || !/^[0-9a-f]{64}$/.test(asset?.sha256)
        || !Number.isSafeInteger(asset?.bytes) || asset.bytes < 0 || asset.bytes > 32 * 1024 * 1024) {
        fail('preserved export contains an invalid logical asset');
      }
      equal(asset.file, `assets/${sha256(Buffer.from(asset.id))}.blob`, `preserved export filename differs for logical asset ${asset.id}`);
      const stored = getBlob.get(expected.ownerId, asset.sha256);
      if (stored === undefined) fail(`immutable BLOB is missing for logical asset ${asset.id}`);
      equal(stored.byte_length, asset.bytes, `immutable BLOB length differs for logical asset ${asset.id}`);
      const blob = Buffer.from(stored.data);
      equal(blob.byteLength, asset.bytes, `immutable BLOB data length differs for logical asset ${asset.id}`);
      readExactAsset(reader, asset, blob);
      unique.set(asset.sha256, asset.bytes);
      logicalAssetsVerified += 1;
    }
    equal(unique.size, expected.counts.blobs, 'unique immutable BLOB count differs');
    reader.assertExhausted();
    const sessions = validateSessions(database, expected);
    database.exec('COMMIT');
    transactionOpen = false;
    return {
      readonly: database.readonly,
      queryOnly: true,
      sqlite: database.prepare('SELECT sqlite_version() AS version').get().version,
      revision: 1,
      counts: expected.counts,
      sessions,
      logicalAssetsVerified,
      uniqueBlobsVerified: unique.size,
      metadataSha256: expected.metadataSha256,
      snapshotSha256: expected.snapshotSha256,
      schemaSha256: expected.schemaSha256,
    };
  } finally {
    if (transactionOpen) database.exec('ROLLBACK');
  }
}

function stdinReader() {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const readExact = (length) => {
    const output = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      let received;
      try {
        received = fs.readSync(0, output, offset, length - offset, null);
      } catch (error) {
        if (error?.code !== 'EAGAIN') throw error;
        // Docker attaches stdin as a nonblocking pipe. Retrying without opening
        // another descriptor preserves the single framed stream and read-only DB.
        Atomics.wait(wait, 0, 0, 10);
        continue;
      }
      if (received <= 0) fail('truncated framed preserved export stream');
      offset += received;
    }
    return output;
  };
  return {
    readExact,
    readU64: () => Number(readExact(8).readBigUInt64BE()),
    assertExhausted: () => equal(fs.readSync(0, Buffer.allocUnsafe(1), 0, 1, null), 0, 'unexpected trailing framed export data'),
  };
}

function innerMain() {
  const [target, expectedJson] = process.argv.slice(3);
  if (typeof target !== 'string' || typeof expectedJson !== 'string') fail('inner mode requires target and expected JSON');
  const expected = JSON.parse(expectedJson);
  const before = identity(target);
  const Database = createRequire('/app/server/package.json')('better-sqlite3');
  const database = new Database(target, { readonly: true, fileMustExist: true });
  let report;
  try {
    report = verifyCanonicalFramedDatabase(database, expected, stdinReader());
  } finally {
    database.close();
  }
  equal(database.open, false, 'database must be closed');
  const after = identity(target);
  assert.deepEqual(after, before, 'canonical database device/inode identity changed during read-only verification');
  const sidecars = Object.fromEntries(['-wal', '-shm', '-journal'].map((suffix) => [suffix.slice(1), fs.existsSync(`${target}${suffix}`)]));
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const security = Object.fromEntries(['Uid', 'Gid', 'CapEff', 'NoNewPrivs', 'Seccomp'].map((key) => [key, status.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]]));
  equal(security.CapEff, '0000000000000000', 'container capabilities must be dropped');
  equal(security.NoNewPrivs, '1', 'container no-new-privileges must be enabled');
  process.stdout.write(`${JSON.stringify({ ...report, targetIdentityBefore: before, targetIdentityAfter: after, sidecars, databaseClosed: true, security })}\n`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function requiredRun(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) fail(`${command} ${args[0] ?? ''} failed: ${result.stderr.trim()}`);
  return result;
}

async function writeStream(stream, bytes) {
  if (stream.write(bytes)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { stream.removeListener('drain', onDrain); stream.removeListener('error', onError); };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

function streamAsset(stream, filename, expectedBytes) {
  const before = identity(filename);
  equal(Number(before.size), expectedBytes, `preserved export asset size differs: ${path.basename(filename)}`);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  return (async () => {
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      assert.deepEqual(Object.fromEntries(['dev', 'ino', 'size'].map((key) => [key, opened[key].toString()])), Object.fromEntries(['dev', 'ino', 'size'].map((key) => [key, before[key]])), 'preserved export asset identity changed before read');
      const header = Buffer.allocUnsafe(8); header.writeBigUInt64BE(BigInt(expectedBytes)); await writeStream(stream, header);
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let total = 0;
      while (total < expectedBytes) {
        const wanted = Math.min(buffer.length, expectedBytes - total);
        const received = fs.readSync(fd, buffer, 0, wanted, null);
        if (received <= 0) fail(`preserved export asset truncated: ${path.basename(filename)}`);
        await writeStream(stream, buffer.subarray(0, received));
        total += received;
      }
      const afterOpen = fs.fstatSync(fd, { bigint: true });
      assert.equal(afterOpen.ino, opened.ino, 'preserved export asset inode changed while streaming');
      assert.deepEqual(identity(filename), before, 'preserved export asset identity changed while streaming');
    } finally {
      fs.closeSync(fd);
    }
  })();
}

async function outerMain() {
  if (process.argv.length !== 3 || process.argv[2] !== '--run-live') fail('usage: node scripts/verify-calibration-canonical-preservation.mjs --run-live');
  fs.mkdirSync(ARTIFACT_PARENT, { recursive: true, mode: 0o700 });
  const runDirectory = path.join(ARTIFACT_PARENT, `preservation-${randomUUID()}`);
  fs.mkdirSync(runDirectory, { mode: 0o700 });
  const writeJson = (name, value) => fs.writeFileSync(path.join(runDirectory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  const metadataPath = path.join(EXPORT_ROOT, 'calibration-data.json');
  const metadataIdentityBefore = identity(metadataPath);
  const metadataBytes = fs.readFileSync(metadataPath);
  equal(sha256(metadataBytes), LIVE_EXPECTED.metadataSha256, 'preserved export metadata SHA-256 differs before container creation');
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  assert.deepEqual({ datasets: requiredArray(metadata, 'datasets').length, cases: requiredArray(metadata, 'cases').length, assets: requiredArray(metadata, 'assets').length, runs: requiredArray(metadata, 'runs').length }, LIVE_EXPECTED.logicalCounts, 'preserved export logical counts differ before container creation');
  const users = await requiredRun('docker', ['ps', '--filter', `volume=${VOLUME}`, '--format', '{{.ID}}']);
  const image = JSON.parse((await requiredRun('docker', ['image', 'inspect', IMAGE])).stdout)[0];
  equal(image.Id, IMAGE_ID, 'server image identity differs from authorized runtime');
  const nonce = randomUUID().replaceAll('-', '');
  const name = `canonical-preservation-80f260-${nonce}`;
  const expectedJson = JSON.stringify(LIVE_EXPECTED);
  const argv = ['create', '--pull=never', '--name', name, '--label', 'com.proxxied.task=td-80f260', '--label', `com.proxxied.owner=${nonce}`, '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '512m', '--cpus', '2', '--user', '0', '--workdir', '/app/server', '--interactive', '--entrypoint', 'node', '--mount', `type=volume,src=${VOLUME},dst=/canonical,readonly,volume-nocopy`, '--mount', `type=bind,src=${path.resolve(fileURLToPath(import.meta.url))},dst=/verify-calibration-canonical-preservation.mjs,readonly`, IMAGE, '/verify-calibration-canonical-preservation.mjs', '--inner', TARGET, expectedJson];
  writeJson('command.json', { argv: ['docker', ...argv], imageId: image.Id, targetReadonlyBinding: `type=volume,src=${VOLUME},dst=/canonical,readonly,volume-nocopy`, sourceExportMethod: 'host-owned bounded framed stdin; no export bind or copy', teardown: 'inspect owner label, stop/remove only fresh owner-labelled helper; never remove volumes' });
  writeJson('preflight.json', { activeVolumeUsers: users.stdout.trim() === '' ? 0 : users.stdout.trim().split(/\n/).length, exportMetadataIdentityBefore: metadataIdentityBefore, imageId: image.Id });
  let container;
  try {
    container = (await requiredRun('docker', argv)).stdout.trim();
    const inspect = JSON.parse((await requiredRun('docker', ['inspect', container])).stdout)[0];
    const canonicalMount = inspect.Mounts.find((mount) => mount.Type === 'volume' && mount.Name === VOLUME);
    assert.ok(inspect.HostConfig.ReadonlyRootfs && inspect.HostConfig.NetworkMode === 'none' && !inspect.HostConfig.Privileged && inspect.HostConfig.CapDrop.includes('ALL'));
    assert.ok(inspect.HostConfig.SecurityOpt.some((item) => item.startsWith('no-new-privileges')));
    assert.ok(canonicalMount && canonicalMount.Destination === '/canonical' && canonicalMount.RW === false);
    assert.ok(inspect.Mounts.every((mount) => mount.RW === false) && !inspect.Mounts.some((mount) => mount.Source === '/var/run/docker.sock'));
    writeJson('isolation.json', { containerId: container, imageId: inspect.Image, host: { ReadonlyRootfs: inspect.HostConfig.ReadonlyRootfs, NetworkMode: inspect.HostConfig.NetworkMode, Privileged: inspect.HostConfig.Privileged, CapDrop: inspect.HostConfig.CapDrop, SecurityOpt: inspect.HostConfig.SecurityOpt, PidsLimit: inspect.HostConfig.PidsLimit, Memory: inspect.HostConfig.Memory, NanoCpus: inspect.HostConfig.NanoCpus }, mounts: inspect.Mounts });
    const stdout = fs.createWriteStream(path.join(runDirectory, 'stdout.log'), { mode: 0o600, flags: 'wx' });
    const stderr = fs.createWriteStream(path.join(runDirectory, 'stderr.log'), { mode: 0o600, flags: 'wx' });
    const child = spawn('docker', ['start', '--attach', '--interactive', container], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.pipe(stdout); child.stderr.pipe(stderr);
    const metadataHeader = Buffer.allocUnsafe(8); metadataHeader.writeBigUInt64BE(BigInt(metadataBytes.length)); await writeStream(child.stdin, metadataHeader); await writeStream(child.stdin, metadataBytes);
    for (const asset of metadata.assets) await streamAsset(child.stdin, path.join(EXPORT_ROOT, asset.file), asset.bytes);
    child.stdin.end();
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    await new Promise((resolve) => stdout.end(resolve)); await new Promise((resolve) => stderr.end(resolve));
    const stopped = JSON.parse((await requiredRun('docker', ['inspect', container])).stdout)[0];
    writeJson('exit.json', { cli: exit, state: stopped.State });
    equal(exit.code, 0, 'readonly helper process failed');
    equal(stopped.State.ExitCode, 0, 'readonly helper container failed');
    const report = JSON.parse(fs.readFileSync(path.join(runDirectory, 'stdout.log'), 'utf8'));
    assert.deepEqual(report.counts, LIVE_EXPECTED.counts, 'live immutable counts differ');
    equal(report.logicalAssetsVerified, LIVE_EXPECTED.counts.assets, 'live logical asset verification count differs');
    equal(report.uniqueBlobsVerified, LIVE_EXPECTED.counts.blobs, 'live unique BLOB verification count differs');
    equal(report.sessions.permanentCredentials, LIVE_EXPECTED.requiredPermanentCredentials, 'live permanent credential count differs');
    assert.deepEqual(identity(metadataPath), metadataIdentityBefore, 'preserved export metadata identity changed during verification');
    writeJson('report.json', { status: 'PASS', scope: 'session-tolerant read-only canonical data/export/history preservation after credential provisioning', report, sourceExportMetadataIdentityUnchanged: true, artifactDirectory: runDirectory });
    process.stdout.write(`${JSON.stringify({ status: 'PASS', artifactDirectory: runDirectory, report: path.join(runDirectory, 'report.json') })}\n`);
  } finally {
    if (container) {
      const current = await run('docker', ['inspect', container]);
      if (current.code === 0) {
        const inspect = JSON.parse(current.stdout)[0];
        equal(inspect.Config.Labels['com.proxxied.owner'], nonce, 'refusing to clean an unowned helper container');
        if (inspect.State.Running) await requiredRun('docker', ['kill', container]);
        await requiredRun('docker', ['rm', container]);
        const absent = await run('docker', ['inspect', container]);
        equal(absent.code, 1, 'owned helper container was not removed');
        writeJson('cleanup.json', { containerId: container, removedContainerOnly: true, absenceExit: absent.code, volumeUntouched: VOLUME });
      }
    }
  }
}

if (process.argv[2] === '--inner') innerMain();
else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await outerMain();
