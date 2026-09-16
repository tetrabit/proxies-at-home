import { createHash } from 'node:crypto';
import express, { type Request, type RequestHandler, type Response } from 'express';
import type Database from 'better-sqlite3';

import {
  CALIBRATION_HARNESS_LIMITS,
  CalibrationHarnessValidationError,
  canonicalHarnessJson,
  type CalibrationHarnessSnapshot,
  validateCalibrationHarnessSnapshot,
} from '../../../shared/calibrationHarness.js';
import {
  CALIBRATION_HARNESS_HTTP,
  calibrationHarnessRevisionEtag,
  parseCalibrationHarnessRevisionEtag,
} from '../../../shared/calibrationHarnessHttp.js';
import {
  createCalibrationHarnessSessionAuth,
  type CalibrationHarnessSessionAuthOptions,
} from '../auth/calibrationHarnessSession.js';
import { CalibrationHarnessRevisionPreconditionError, createCalibrationHarnessStore } from '../db/calibrationHarnessStore.js';
import { createCalibrationHarnessBlobRouter } from './calibrationHarnessBlobRouter.js';

export interface CalibrationHarnessRouterOptions {
  /** An already opened and initialized calibration-harness SQLite database. */
  database: Database.Database;
  /** Explicit browser origins used by the A2 pairing/session authenticator. */
  allowedWebOrigins: string[];
  /** Explicit session options for deterministic hosts/tests; never credentials. */
  now?: CalibrationHarnessSessionAuthOptions['now'];
  maxAgeMs?: CalibrationHarnessSessionAuthOptions['maxAgeMs'];
}

type RevisionPrecondition = number | null;

type BlobMetadata = { byte_length: unknown; stored_length: unknown };

function noStore(_request: Request, response: Response, next: () => void): void {
  response.setHeader('Cache-Control', CALIBRATION_HARNESS_HTTP.cacheControl);
  next();
}

function sendError(response: Response, status: number, error: string): void {
  response.status(status).json({ error });
}

function headerValues(request: Request, headerName: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === headerName) {
      values.push(request.rawHeaders[index + 1] ?? '');
    }
  }
  return values;
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

function readPrecondition(request: Request): RevisionPrecondition | 'missing' | 'invalid' {
  const ifMatch = headerValues(request, 'if-match');
  const ifNoneMatch = headerValues(request, 'if-none-match');
  if (ifMatch.length === 0 && ifNoneMatch.length === 0) return 'missing';
  if (ifMatch.length + ifNoneMatch.length !== 1) return 'invalid';
  if (ifNoneMatch.length === 1) return ifNoneMatch[0] === '*' ? null : 'invalid';
  return parseCalibrationHarnessRevisionEtag(ifMatch[0]!) ?? 'invalid';
}

function admitPut(request: Request, response: Response, next: () => void): void {
  const precondition = readPrecondition(request);
  if (precondition === 'missing') {
    sendError(response, 428, 'precondition_required');
    return;
  }
  if (precondition === 'invalid') {
    sendError(response, 400, 'invalid_precondition');
    return;
  }
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
  request.calibrationHarnessExpectedRevision = precondition;
  next();
}

function metadataJsonParser(): RequestHandler {
  const parser = express.json({
    inflate: false,
    limit: CALIBRATION_HARNESS_LIMITS.maxMetadataBytes,
    strict: true,
    type: 'application/json',
  });
  return (request, response, next) => {
    parser(request, response, (error?: unknown) => {
      if (error !== undefined) {
        const typed = error as { type?: unknown; status?: unknown };
        if (typed.type === 'entity.too.large' || typed.status === 413) {
          sendError(response, 413, 'metadata_too_large');
        } else {
          sendError(response, 400, 'invalid_metadata');
        }
        return;
      }
      next();
    });
  };
}

function initializedDatabase(database: Database.Database): void {
  const table = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mpc_harnesses'",
  ).get();
  if (table === undefined) {
    throw new TypeError('Calibration harness router requires an initialized calibration-harness database');
  }
}

function isStoredReference(metadata: BlobMetadata | undefined, length: number): boolean {
  return metadata !== undefined
    && Number.isSafeInteger(metadata.byte_length)
    && Number.isSafeInteger(metadata.stored_length)
    && metadata.byte_length === length
    && metadata.stored_length === length;
}

function isBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error as { code?: unknown }).code === 'SQLITE_BUSY';
}

/** Log-safe identity prefix: never logs full owner/harness/connection ids. */
function shortId(value: unknown): string {
  return typeof value === 'string' && value.length >= 8 ? value.slice(0, 8) : 'unknown';
}

/** Log-safe snapshot digest prefix for correlating publishes with the harness history. */
function snapshotDigestPrefix(snapshot: CalibrationHarnessSnapshot): string {
  try {
    return createHash('sha256').update(canonicalHarnessJson(snapshot), 'utf8').digest('hex').slice(0, 8);
  } catch {
    return 'unknown';
  }
}

const fixedRoutePaths = new Set(['/pair', '/unpair', '/session', '/snapshot']);

function rejectUnhandledNamespaceRequest(request: Request, response: Response): void {
  sendError(response, fixedRoutePaths.has(request.path) ? 405 : 404, fixedRoutePaths.has(request.path) ? 'method_not_allowed' : 'not_found');
}

declare module 'express-serve-static-core' {
  interface Request {
    calibrationHarnessExpectedRevision?: RevisionPrecondition;
  }
}

/**
 * Creates only the credential-scoped calibration metadata router. H3 must mount
 * it at its fixed base path before any application-wide JSON parser.
 */
export function createCalibrationHarnessRouter(options: CalibrationHarnessRouterOptions): express.Router {
  if (options === null || typeof options !== 'object' || options.database === undefined) {
    throw new TypeError('Calibration harness router requires a database and explicit allowedWebOrigins');
  }
  if (!Array.isArray(options.allowedWebOrigins)) {
    throw new TypeError('Calibration harness router requires explicit allowedWebOrigins');
  }
  initializedDatabase(options.database);

  const sessionAuth = createCalibrationHarnessSessionAuth(options.database, {
    allowedWebOrigins: options.allowedWebOrigins,
    now: options.now,
    maxAgeMs: options.maxAgeMs,
  });
  const store = createCalibrationHarnessStore(options.database);
  const findBlobMetadata = options.database.prepare(`
    SELECT byte_length, length(data) AS stored_length
    FROM mpc_harness_blobs
    WHERE owner_id = ? AND sha256 = ?
  `);
  const router = express.Router();

  router.post('/pair', noStore, sessionAuth.pair);
  router.post('/unpair', noStore, sessionAuth.unpair);

  router.get('/session', noStore, sessionAuth.authenticate, (request, response) => {
    const identity = request.calibrationHarnessIdentity!;
    response.status(200).json({ ownerId: identity.ownerId, harnessId: identity.harnessId });
  });

  router.get('/snapshot', noStore, sessionAuth.authenticate, requireCapability('calibration:read'), (request, response) => {
    const identity = request.calibrationHarnessIdentity!;
    try {
      const current = store.getCurrent(identity.ownerId, identity.harnessId);
      if (current === null) {
        sendError(response, 404, 'not_found');
        return;
      }
      response.setHeader('ETag', calibrationHarnessRevisionEtag(current.revision));
      response.status(200).json(current);
    } catch {
      sendError(response, 500, 'storage_error');
    }
  });

  router.put(
    '/snapshot',
    noStore,
    sessionAuth.authenticate,
    requireCapability('calibration:write'),
    admitPut,
    metadataJsonParser(),
    (request, response) => {
      const identity = request.calibrationHarnessIdentity!;
      const expectedRevision = request.calibrationHarnessExpectedRevision!;
      let snapshot: CalibrationHarnessSnapshot;
      try {
        snapshot = validateCalibrationHarnessSnapshot(request.body);
      } catch (error) {
        if (error instanceof CalibrationHarnessValidationError) {
          sendError(response, 400, 'invalid_snapshot');
          return;
        }
        sendError(response, 400, 'invalid_snapshot');
        return;
      }

      try {
        for (const asset of snapshot.assets) {
          const metadata = findBlobMetadata.get(identity.ownerId, asset.sha256) as BlobMetadata | undefined;
          if (!isStoredReference(metadata, asset.byteLength)) {
            console.warn(
              `[calibration-harness] publish rejected owner=${shortId(identity.ownerId)} harness=${shortId(identity.harnessId)} ` +
              `reason=invalid_asset_reference asset=${asset.sha256} expectedLength=${asset.byteLength}`,
            );
            sendError(response, 400, 'invalid_asset_reference');
            return;
          }
        }
        const revision = store.publish(identity.ownerId, identity.harnessId, expectedRevision, snapshot);
        console.info(
          `[calibration-harness] publish acknowledged owner=${shortId(identity.ownerId)} harness=${shortId(identity.harnessId)} ` +
          `expectedRevision=${expectedRevision} revision=${revision.revision} digest=${snapshotDigestPrefix(snapshot)} ` +
          `cases=${snapshot.cases.length} assets=${snapshot.assets.length}`,
        );
        response.setHeader('ETag', calibrationHarnessRevisionEtag(revision.revision));
        response.status(expectedRevision === null ? 201 : 200).json(revision);
      } catch (error) {
        if (error instanceof CalibrationHarnessRevisionPreconditionError) {
          let currentRevision = 'unknown';
          try {
            const current = store.getCurrent(identity.ownerId, identity.harnessId);
            currentRevision = current === null ? 'none' : String(current.revision);
          } catch {
            // The 412 stands on its own; the observed revision is diagnostic only.
          }
          console.warn(
            `[calibration-harness] publish precondition failed owner=${shortId(identity.ownerId)} harness=${shortId(identity.harnessId)} ` +
            `expectedRevision=${expectedRevision} currentRevision=${currentRevision} submittedDigest=${snapshotDigestPrefix(snapshot)}`,
          );
          sendError(response, 412, 'precondition_failed');
          return;
        }
        console.warn(
          `[calibration-harness] publish storage failure owner=${shortId(identity.ownerId)} harness=${shortId(identity.harnessId)} ` +
          `expectedRevision=${expectedRevision} error=${error instanceof Error ? error.message : String(error)}`,
        );
        sendError(response, isBusy(error) ? 503 : 500, isBusy(error) ? 'storage_unavailable' : 'storage_error');
      }
    },
  );

  router.use(noStore, sessionAuth.authenticate);
  router.use('/blobs', createCalibrationHarnessBlobRouter(options.database));
  router.use(rejectUnhandledNamespaceRequest);

  return router;
}
