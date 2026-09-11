import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import {
  MAX_CALIBRATION_BLOB_CHUNK_BYTES,
  createCalibrationBlobChunkReader,
  exportCalibrationBlob,
} from './calibration-blob-export.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = path.join(root, '.review-artifacts');

async function fixtureDirectory() {
  await mkdir(evidenceRoot, { recursive: true });
  return mkdtemp(path.join(evidenceRoot, 'calibration-blob-export-test-'));
}

test('exports several base64 chunks with exact bytes and SHA-256', async () => {
  const directory = await fixtureDirectory();
  const outputPath = path.join(directory, 'asset.blob');
  const source = Buffer.from('bounded calibration asset payload');
  const reads = [];

  const result = await exportCalibrationBlob({
    outputPath,
    byteLength: source.length,
    chunkSize: 5,
    readChunk: async (offset, length) => {
      reads.push({ offset, length });
      return source.subarray(offset, offset + length).toString('base64');
    },
  });

  assert.deepEqual(reads, [
    { offset: 0, length: 5 },
    { offset: 5, length: 5 },
    { offset: 10, length: 5 },
    { offset: 15, length: 5 },
    { offset: 20, length: 5 },
    { offset: 25, length: 5 },
    { offset: 30, length: 3 },
  ]);
  assert.equal(await readFile(outputPath, 'utf8'), source.toString());
  assert.deepEqual(result, {
    outputPath,
    bytes: source.length,
    sha256: createHash('sha256').update(source).digest('hex'),
  });
  await assert.rejects(access(`${outputPath}.partial`));
});

test('rejects a configured chunk above the bounded maximum before reading', async () => {
  const directory = await fixtureDirectory();
  let reads = 0;

  await assert.rejects(
    exportCalibrationBlob({
      outputPath: path.join(directory, 'asset.blob'),
      byteLength: 1,
      chunkSize: MAX_CALIBRATION_BLOB_CHUNK_BYTES + 1,
      readChunk: async () => {
        reads += 1;
        return 'AA==';
      },
    }),
    /must not exceed/,
  );
  assert.equal(reads, 0);
});

test('rejects oversized encoded responses before decoding or writing', async (t) => {
  const directory = await fixtureDirectory();
  const outputPath = path.join(directory, 'asset.blob');
  const originalFrom = Buffer.from;
  let decodes = 0;
  const spy = t.mock.method(Buffer, 'from', function (value, encoding, ...rest) {
    if (encoding === 'base64') decodes += 1;
    return originalFrom(value, encoding, ...rest);
  });
  try {
    await assert.rejects(exportCalibrationBlob({
      outputPath,
      byteLength: 1,
      readChunk: async () => 'YWFh'.repeat(1024),
    }));
    assert.equal(decodes, 0);
    assert.equal((await stat(`${outputPath}.partial`)).size, 0);
    await assert.rejects(access(outputPath));
  } finally {
    spy.mock.restore();
  }
});

test('enforces reader bounds before invoking the renderer', async () => {
  let evaluations = 0;
  const reader = createCalibrationBlobChunkReader({
    evaluate: async () => { evaluations += 1; return 'AA=='; },
  }, 'synthetic');

  for (const [offset, length] of [
    [0, MAX_CALIBRATION_BLOB_CHUNK_BYTES + 1],
    [Number.MAX_SAFE_INTEGER, 1],
    [-1, 1],
    [0, 0],
  ]) {
    await assert.rejects(reader(offset, length), /slice request|must not exceed/);
  }
  assert.equal(evaluations, 0);
});

test('retains a clearly marked partial artifact when a renderer chunk is truncated', async () => {
  const directory = await fixtureDirectory();
  const outputPath = path.join(directory, 'asset.blob');
  const source = Buffer.from('abcdef');

  await assert.rejects(
    exportCalibrationBlob({
      outputPath,
      byteLength: source.length,
      chunkSize: 3,
      readChunk: async (offset, length) => source.subarray(offset, offset + length - (offset === 3 ? 1 : 0)).toString('base64'),
    }),
    /returned 2 bytes; expected 3/,
  );

  assert.equal((await stat(`${outputPath}.partial`)).size, 3);
  const failure = JSON.parse(await readFile(`${outputPath}.partial.failed.json`, 'utf8'));
  assert.equal(failure.expectedBytes, source.length);
  assert.equal(failure.bytesWritten, 3);
  assert.match(failure.error, /returned 2 bytes; expected 3/);
  await assert.rejects(access(outputPath));
});

test('retains a clearly marked partial artifact when a renderer chunk is oversized', async () => {
  const directory = await fixtureDirectory();
  const outputPath = path.join(directory, 'asset.blob');
  const source = Buffer.from('abcdefg');

  await assert.rejects(
    exportCalibrationBlob({
      outputPath,
      byteLength: source.length,
      chunkSize: 3,
      readChunk: async (offset, length) => source.subarray(offset, offset + length + (offset === 3 ? 1 : 0)).toString('base64'),
    }),
    /returned 4 bytes; expected 3/,
  );

  assert.equal((await stat(`${outputPath}.partial`)).size, 3);
  const failure = JSON.parse(await readFile(`${outputPath}.partial.failed.json`, 'utf8'));
  assert.equal(failure.bytesWritten, 3);
  assert.match(failure.error, /returned 4 bytes; expected 3/);
  await assert.rejects(access(outputPath));
});

test('refuses an existing final destination without invoking the reader', async () => {
  const directory = await fixtureDirectory();
  const outputPath = path.join(directory, 'asset.blob');
  await writeFile(outputPath, 'pre-existing', { flag: 'wx' });
  let reads = 0;

  await assert.rejects(
    exportCalibrationBlob({
      outputPath,
      byteLength: 1,
      readChunk: async () => {
        reads += 1;
        return 'AA==';
      },
    }),
    /Refusing to overwrite existing calibration asset/,
  );

  assert.equal(reads, 0);
  assert.equal(await readFile(outputPath, 'utf8'), 'pre-existing');
});

test('reads a synthetic browser Blob in bounded slices without download events', async () => {
  const directory = await fixtureDirectory();
  const outputPath = path.join(directory, 'browser-asset.blob');
  const source = randomBytes(MAX_CALIBRATION_BLOB_CHUNK_BYTES * 2 + 19);
  const context = await chromium.launchPersistentContext(path.join(directory, 'chromium-profile'), {
    headless: true,
    chromiumSandbox: true,
    acceptDownloads: false,
  });
  let downloadEvents = 0;
  try {
    await context.route('**/*', route => route.abort());
    const page = context.pages()[0] ?? await context.newPage();
    page.on('download', () => { downloadEvents += 1; });
    await page.setContent('<title>bounded Blob fixture</title>');
    await page.evaluate(bytes => {
      window.__calibrationExportAssets = new Map([
        ['synthetic', new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' })],
      ]);
    }, [...source]);

    let largestRequestedChunk = 0;
    const browserReader = createCalibrationBlobChunkReader(page, 'synthetic');
    const result = await exportCalibrationBlob({
      outputPath,
      byteLength: source.length,
      readChunk: async (offset, length) => {
        largestRequestedChunk = Math.max(largestRequestedChunk, length);
        return browserReader(offset, length);
      },
    });

    assert.equal(largestRequestedChunk, MAX_CALIBRATION_BLOB_CHUNK_BYTES);
    assert.deepEqual(await readFile(outputPath), source);
    assert.equal(result.sha256, createHash('sha256').update(source).digest('hex'));
    assert.equal(downloadEvents, 0);
  } finally {
    await context.close();
  }
});
