import { createHash } from 'node:crypto';

import express, { type Request, type RequestHandler, type Response } from 'express';
import type Database from 'better-sqlite3';

import { isCalibrationHarnessBlobSha256 } from '../../../shared/calibrationHarnessHttp.js';
import {
  CALIBRATION_HARNESS_MAX_BLOB_BYTES,
  createCalibrationHarnessBlobStore,
} from '../db/calibrationHarnessBlobs.js';

const MAX_MISSING_HASHES = 512;
const MAX_MISSING_QUERY_BYTES = 64 * 1024;
const blobPathPattern = /^\/[0-9a-f]{64}$/;

type BlobMetadataRow = { sha256: string };

function sendError(response: Response, status: number, error: string): void {
  response.status(status).json({ error });
}

function requireAuthenticatedIdentity(request: Request, response: Response, next: () => void): void {
  if (request.calibrationHarnessIdentity === undefined) {
    sendError(response, 401, 'unauthorized');
    return;
  }
  next();
}

function requireCapability(capability: 'calibration:read' | 'calibration:write'): RequestHandler {
  return (request, response, next) => {
    if (!request.calibrationHarnessIdentity?.capabilities.has(capability)) {
      sendError(response, 401, 'unauthorized');
      return;
    }
    next();
  };
}

function requireSha256Path(request: Request, response: Response, next: () => void): void {
  if (!isCalibrationHarnessBlobSha256(request.params.sha256)) {
    sendError(response, 404, 'not_found');
    return;
  }
  next();
}

function headerValues(request: Request, headerName: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === headerName) values.push(request.rawHeaders[index + 1] ?? '');
  }
  return values;
}

function admitBinaryPut(request: Request, response: Response, next: () => void): void {
  const contentEncoding = headerValues(request, 'content-encoding');
  if (contentEncoding.length > 1 || (contentEncoding.length === 1 && contentEncoding[0]!.toLowerCase() !== 'identity')) {
    sendError(response, 415, 'unsupported_content_encoding');
    return;
  }
  const contentType = headerValues(request, 'content-type');
  if (contentType.length !== 1 || !/^application\/octet-stream$/i.test(contentType[0]!)) {
    sendError(response, 415, 'unsupported_media_type');
    return;
  }
  next();
}

function admitMissingQuery(request: Request, response: Response, next: () => void): void {
  const contentEncoding = headerValues(request, 'content-encoding');
  if (contentEncoding.length > 1 || (contentEncoding.length === 1 && contentEncoding[0]!.toLowerCase() !== 'identity')) {
    sendError(response, 415, 'unsupported_content_encoding');
    return;
  }
  const contentType = headerValues(request, 'content-type');
  if (contentType.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType[0]!)) {
    sendError(response, 415, 'unsupported_media_type');
    return;
  }
  next();
}

function missingQueryParser(): RequestHandler {
  const parser = express.json({
    inflate: false,
    limit: MAX_MISSING_QUERY_BYTES,
    strict: true,
    type: 'application/json',
  });
  return (request, response, next) => {
    parser(request, response, (error?: unknown) => {
      if (error !== undefined) {
        const typed = error as { type?: unknown; status?: unknown };
        sendError(response, typed.type === 'entity.too.large' || typed.status === 413 ? 413 : 400,
          typed.type === 'entity.too.large' || typed.status === 413 ? 'missing_query_too_large' : 'invalid_missing_query');
        return;
      }
      next();
    });
  };
}

function parseMissingHashes(value: unknown): string[] | null {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'hashes') || !Array.isArray(record.hashes)) return null;
  if (record.hashes.length > MAX_MISSING_HASHES) return null;
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const hash of record.hashes) {
    if (!isCalibrationHarnessBlobSha256(hash) || seen.has(hash)) return null;
    seen.add(hash);
    hashes.push(hash);
  }
  return hashes;
}

function isBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error as { code?: unknown }).code === 'SQLITE_BUSY';
}

function storageError(response: Response, error: unknown): void {
  sendError(response, isBusy(error) ? 503 : 500, isBusy(error) ? 'storage_unavailable' : 'storage_error');
}

function binaryParser(): RequestHandler {
  const parser = express.raw({
    inflate: false,
    limit: CALIBRATION_HARNESS_MAX_BLOB_BYTES,
    type: 'application/octet-stream',
  });
  return (request, response, next) => {
    parser(request, response, (error?: unknown) => {
      if (error !== undefined) {
        const typed = error as { type?: unknown; status?: unknown };
        sendError(response, typed.type === 'entity.too.large' || typed.status === 413 ? 413 : 400,
          typed.type === 'entity.too.large' || typed.status === 413 ? 'blob_too_large' : 'invalid_blob');
        return;
      }
      next();
    });
  };
}

/**
 * Creates the blob-only child router. Its parent authenticates before mount;
 * each child handler still requires the authenticated identity capability.
 */
export function createCalibrationHarnessBlobRouter(database: Database.Database): express.Router {
  const blobStore = createCalibrationHarnessBlobStore(database);
  const router = express.Router();
  router.use(requireAuthenticatedIdentity);

  router.post('/missing', requireCapability('calibration:read'), admitMissingQuery, missingQueryParser(), (request, response) => {
    const hashes = parseMissingHashes(request.body);
    if (hashes === null) {
      sendError(response, 400, 'invalid_missing_query');
      return;
    }
    if (hashes.length === 0) {
      response.status(200).json({ missing: [] });
      return;
    }
    try {
      const placeholders = hashes.map(() => '?').join(', ');
      const findPresentMetadata = database.prepare(`
        SELECT sha256
        FROM mpc_harness_blobs
        WHERE owner_id = ?
          AND sha256 IN (${placeholders})
          AND byte_length >= 0
          AND byte_length <= ${CALIBRATION_HARNESS_MAX_BLOB_BYTES}
          AND length(data) = byte_length
      `);
      // Metadata presence is not a fresh digest audit: materializing every blob
      // would make a 512-key missing query unbounded.
      const present = new Set((findPresentMetadata.all(
        request.calibrationHarnessIdentity!.ownerId,
        ...hashes,
      ) as BlobMetadataRow[]).map((row) => row.sha256));
      response.status(200).json({ missing: hashes.filter((hash) => !present.has(hash)) });
    } catch (error) {
      storageError(response, error);
    }
  });

  router.all('/missing', (_request, response) => sendError(response, 405, 'method_not_allowed'));

  router.get('/:sha256', requireCapability('calibration:read'), requireSha256Path, (request, response) => {
    try {
      const data = blobStore.get(request.calibrationHarnessIdentity!.ownerId, request.params.sha256);
      if (data === null) {
        sendError(response, 404, 'not_found');
        return;
      }
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', String(data.byteLength));
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.status(200).send(data);
    } catch (error) {
      storageError(response, error);
    }
  });

  router.put(
    '/:sha256',
    requireCapability('calibration:write'),
    requireSha256Path,
    admitBinaryPut,
    binaryParser(),
    (request, response) => {
      const data = request.body;
      if (!Buffer.isBuffer(data)) {
        sendError(response, 400, 'invalid_blob');
        return;
      }
      if (createHash('sha256').update(data).digest('hex') !== request.params.sha256) {
        sendError(response, 400, 'blob_digest_mismatch');
        return;
      }
      try {
        const result = blobStore.put(request.calibrationHarnessIdentity!.ownerId, request.params.sha256, data);
        response.status(result.inserted ? 201 : 200).json(result);
      } catch (error) {
        storageError(response, error);
      }
    },
  );

  router.use((request, response) => {
    const knownPath = request.path === '/missing' || blobPathPattern.test(request.path);
    sendError(response, knownPath ? 405 : 404, knownPath ? 'method_not_allowed' : 'not_found');
  });
  return router;
}
