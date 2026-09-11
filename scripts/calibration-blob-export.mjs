import { createHash } from 'node:crypto';
import { link, lstat, open, unlink, writeFile } from 'node:fs/promises';

export const MAX_CALIBRATION_BLOB_CHUNK_BYTES = 1024 * 1024;

function assertSafeByteCount(value, name, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new TypeError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
  }
}

function decodeChunk(encoded, expectedBytes, offset) {
  // Bound the response before regexp scanning or allocating a decoded Buffer.
  if (typeof encoded === 'string' && encoded.length > Math.ceil(expectedBytes / 3) * 4) {
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    const returnedBytes = Math.floor(encoded.length / 4) * 3 - padding;
    throw new Error(`Calibration Blob reader returned ${returnedBytes} bytes; expected ${expectedBytes} at byte ${offset}`);
  }
  if (typeof encoded !== 'string'
    || encoded.length === 0
    || encoded.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`Calibration Blob reader returned invalid base64 at byte ${offset}`);
  }
  const chunk = Buffer.from(encoded, 'base64');
  if (chunk.byteLength !== expectedBytes) {
    throw new Error(`Calibration Blob reader returned ${chunk.byteLength} bytes; expected ${expectedBytes} at byte ${offset}`);
  }
  return chunk;
}

async function writeFully(handle, bytes, position) {
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await handle.write(bytes, written, bytes.byteLength - written, position + written);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
      throw new Error(`Calibration asset write stopped at byte ${position + written}`);
    }
    written += result.bytesWritten;
  }
}

async function refuseExisting(pathname, label) {
  try {
    await lstat(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing calibration asset ${label}: ${pathname}`);
}

async function retainFailure(failurePath, detail) {
  try {
    await writeFile(failurePath, `${JSON.stringify(detail, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}

/**
 * Persist one renderer Blob by requesting and decoding one base64 slice at a time.
 * `readChunk(offset, length)` must return canonical base64 for exactly `length` bytes.
 */
export async function exportCalibrationBlob({ outputPath, byteLength, readChunk, chunkSize = MAX_CALIBRATION_BLOB_CHUNK_BYTES }) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) throw new TypeError('outputPath must be a non-empty string');
  assertSafeByteCount(byteLength, 'byteLength', { allowZero: true });
  assertSafeByteCount(chunkSize, 'chunkSize');
  if (chunkSize > MAX_CALIBRATION_BLOB_CHUNK_BYTES) {
    throw new RangeError(`chunkSize must not exceed ${MAX_CALIBRATION_BLOB_CHUNK_BYTES} bytes`);
  }
  if (typeof readChunk !== 'function') throw new TypeError('readChunk must be a function');

  const partialPath = `${outputPath}.partial`;
  const failurePath = `${partialPath}.failed.json`;
  await refuseExisting(outputPath, 'destination');
  await refuseExisting(partialPath, 'partial artifact');

  let handle;
  let bytesWritten = 0;
  const hash = createHash('sha256');
  try {
    handle = await open(partialPath, 'wx', 0o600);
    for (let offset = 0; offset < byteLength; offset += chunkSize) {
      const requestedBytes = Math.min(chunkSize, byteLength - offset);
      const chunk = decodeChunk(await readChunk(offset, requestedBytes), requestedBytes, offset);
      await writeFully(handle, chunk, offset);
      hash.update(chunk);
      bytesWritten += chunk.byteLength;
    }
    if (bytesWritten !== byteLength) throw new Error(`Calibration asset wrote ${bytesWritten} bytes; expected ${byteLength}`);
    await handle.close();
    handle = undefined;
    // link(2) creates the final path exclusively; unlinking leaves that exact inode.
    await link(partialPath, outputPath);
    await unlink(partialPath);
    return { outputPath, bytes: bytesWritten, sha256: hash.digest('hex') };
  } catch (error) {
    await handle?.close();
    if (handle) {
      await retainFailure(failurePath, {
        schema: 'proxxied-mpc-calibration-blob-failure/v1',
        partialPath,
        expectedBytes: byteLength,
        bytesWritten,
        error: error.stack ?? String(error),
      });
    } else {
      try {
        await lstat(partialPath);
        await retainFailure(failurePath, {
          schema: 'proxxied-mpc-calibration-blob-failure/v1',
          partialPath,
          expectedBytes: byteLength,
          bytesWritten,
          error: error.stack ?? String(error),
        });
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
      }
    }
    throw error;
  }
}

/**
 * Build a renderer-backed bounded Blob reader. Each call only materializes the
 * requested Blob.slice(), never the complete asset or asset collection.
 */
export function createCalibrationBlobChunkReader(page, assetId) {
  if (!page || typeof page.evaluate !== 'function') throw new TypeError('page must expose evaluate()');
  if (typeof assetId !== 'string' || assetId.length === 0) throw new TypeError('assetId must be a non-empty string');
  return async (offset, length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length)
      || length <= 0 || !Number.isSafeInteger(offset + length)) {
      throw new Error('Invalid bounded calibration Blob slice request');
    }
    if (length > MAX_CALIBRATION_BLOB_CHUNK_BYTES) {
      throw new RangeError(`Calibration Blob slice request must not exceed ${MAX_CALIBRATION_BLOB_CHUNK_BYTES} bytes`);
    }
    return page.evaluate(async ({ assetId: id, offset: start, length: count, maxBytes }) => {
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count)
        || count <= 0 || count > maxBytes || !Number.isSafeInteger(start + count)) {
        throw new Error('Invalid bounded calibration Blob slice request');
      }
      const blob = window.__calibrationExportAssets?.get(id);
      if (!(blob instanceof Blob)) throw new Error(`Calibration asset disappeared: ${id}`);
      const bytes = new Uint8Array(await blob.slice(start, start + count).arrayBuffer());
      let binary = '';
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      return btoa(binary);
    }, { assetId, offset, length, maxBytes: MAX_CALIBRATION_BLOB_CHUNK_BYTES });
  };
}
