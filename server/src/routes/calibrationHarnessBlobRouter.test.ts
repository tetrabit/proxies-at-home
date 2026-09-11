import { createHash } from 'node:crypto';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createCalibrationHarnessCredentialStore } from '../auth/calibrationHarnessIdentity.js';
import { CALIBRATION_HARNESS_MAX_BLOB_BYTES } from '../db/calibrationHarnessBlobs.js';
import { initializeCalibrationHarnessSchema } from '../db/calibrationHarnessSchema.js';
import { openNativeDatabase } from '../db/openNativeDatabase.js';
import {
  closeLoopbackServer,
  createCalibrationHarnessFixtureProvider,
  listenLoopback,
} from '../testUtils/calibrationHarnessFixtures.js';
import { createCalibrationHarnessRouter } from './calibrationHarnessRouter.js';

const fixtures = createCalibrationHarnessFixtureProvider();
const fixtureInvocationRoot = fixtures.createInvocationRoot();
const now = 1_700_000_000_000;
const webOrigin = 'http://127.0.0.1:4173';

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function createExclusiveDatabase() {
  const directory = fixtures.createExclusiveDirectory(fixtureInvocationRoot);
  const database = openNativeDatabase(path.join(directory, 'calibration-harness.db'));
  initializeCalibrationHarnessSchema(database);
  return database;
}

function bearer(token: string): string {
  return `Bearer ${token}`;
}

async function createApp(database: ReturnType<typeof createExclusiveDatabase>) {
  const app = express();
  app.use('/api/calibration-harness', createCalibrationHarnessRouter({
    database,
    allowedWebOrigins: [webOrigin],
    now: () => now,
  }));
  const server = await listenLoopback(app);
  return { server, api: request(server) };
}

describe('createCalibrationHarnessBlobRouter', () => {
  it('returns fixed namespace errors for wrong methods without admitting malformed paths', async () => {
    const database = createExclusiveDatabase();
    let server: Awaited<ReturnType<typeof listenLoopback>> | undefined;
    try {
      const credential = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({
        ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000,
      });
      const bound = await createApp(database);
      server = bound.server;
      const wrongMethod = await bound.api.post(`/api/calibration-harness/blobs/${'a'.repeat(64)}`)
        .set('Authorization', bearer(credential));
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.body).toEqual({ error: 'method_not_allowed' });
      const missingWrongMethod = await bound.api.get('/api/calibration-harness/blobs/missing')
        .set('Authorization', bearer(credential));
      expect(missingWrongMethod.status).toBe(405);
      expect(missingWrongMethod.body).toEqual({ error: 'method_not_allowed' });
      const malformedPath = await bound.api.get('/api/calibration-harness/blobs/not-a-hash')
        .set('Authorization', bearer(credential));
      expect(malformedPath.status).toBe(404);
      expect(malformedPath.body).toEqual({ error: 'not_found' });
    } finally {
      try {
        if (server !== undefined) await closeLoopbackServer(server);
      } finally {
        database.close();
      }
    }
  });

  it('preserves an immutable corrupt existing blob and returns a bounded storage error', async () => {
    const database = createExclusiveDatabase();
    let server: Awaited<ReturnType<typeof listenLoopback>> | undefined;
    try {
      const credential = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({
        ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000,
      });
      const bytes = Buffer.from('canonical');
      const corrupt = Buffer.from('corrupt!!');
      const digest = sha256(bytes);
      database.prepare(`
        INSERT INTO mpc_harness_blobs (owner_id, sha256, data, byte_length, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('owner-a', digest, corrupt, corrupt.byteLength, 1);
      const bound = await createApp(database);
      server = bound.server;

      const response = await bound.api.put(`/api/calibration-harness/blobs/${digest}`)
        .set('Authorization', bearer(credential))
        .set('Content-Type', 'application/octet-stream')
        .send(bytes);
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'storage_error' });
      expect(database.prepare('SELECT data FROM mpc_harness_blobs WHERE owner_id = ? AND sha256 = ?').get('owner-a', digest))
        .toEqual({ data: corrupt });
    } finally {
      try {
        if (server !== undefined) await closeLoopbackServer(server);
      } finally {
        database.close();
      }
    }
  });

  it('keeps foreign blobs indistinguishable from absent ones and leaves storage unchanged on malformed uploads', async () => {
    const database = createExclusiveDatabase();
    let server: Awaited<ReturnType<typeof listenLoopback>> | undefined;
    try {
      const credentials = createCalibrationHarnessCredentialStore(database, { now: () => now });
      const ownerA = credentials.provision({ ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000 });
      const ownerB = credentials.provision({ ownerId: 'owner-b', harnessId: 'harness-b', expiresAt: now + 60_000 });
      const bytes = Buffer.from('owner-a-image');
      const digest = sha256(bytes);
      const bound = await createApp(database);
      server = bound.server;
      expect((await bound.api.put(`/api/calibration-harness/blobs/${digest}`)
        .set('Authorization', bearer(ownerA))
        .set('Content-Type', 'application/octet-stream')
        .send(bytes)).status).toBe(201);

      const foreign = await bound.api.get(`/api/calibration-harness/blobs/${digest}`).set('Authorization', bearer(ownerB));
      const absent = await bound.api.get(`/api/calibration-harness/blobs/${'b'.repeat(64)}`).set('Authorization', bearer(ownerB));
      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual(absent.body);
      expect((await bound.api.put(`/api/calibration-harness/blobs/${digest.toUpperCase()}`)
        .set('Authorization', bearer(ownerA))
        .set('Content-Type', 'application/octet-stream')
        .send(bytes)).status).toBe(404);
      expect((await bound.api.put(`/api/calibration-harness/blobs/${digest}`)
        .set('Authorization', bearer(ownerA))
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('different'))).status).toBe(400);
      expect((await bound.api.put(`/api/calibration-harness/blobs/${digest}`)
        .set('Content-Type', 'application/octet-stream')
        .send('{not-json')).status).toBe(401);

      const overLimit = Buffer.alloc(CALIBRATION_HARNESS_MAX_BLOB_BYTES + 1, 0x20);
      const oversized = await bound.api.put(`/api/calibration-harness/blobs/${sha256(overLimit)}`)
        .set('Authorization', bearer(ownerA))
        .set('Content-Type', 'application/octet-stream')
        .send(overLimit);
      expect(oversized.status).toBe(413);
      expect(oversized.body).toEqual({ error: 'blob_too_large' });
      expect(database.prepare('SELECT count(*) AS count FROM mpc_harness_blobs').get()).toEqual({ count: 1 });
    } finally {
      try {
        if (server !== undefined) await closeLoopbackServer(server);
      } finally {
        database.close();
      }
    }
  });

  it('authenticates missing queries before parsing and rejects malformed, duplicate, and over-limit inputs', async () => {
    const database = createExclusiveDatabase();
    let server: Awaited<ReturnType<typeof listenLoopback>> | undefined;
    try {
      const credential = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({
        ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000,
      });
      const hash = 'c'.repeat(64);
      const bound = await createApp(database);
      server = bound.server;

      const anonymousMalformed = await bound.api.post('/api/calibration-harness/blobs/missing')
        .set('Content-Type', 'application/json')
        .send('{not-json');
      expect(anonymousMalformed.status).toBe(401);
      expect(anonymousMalformed.body).toEqual({ error: 'unauthorized' });

      const wrongMedia = await bound.api.post('/api/calibration-harness/blobs/missing')
        .set('Authorization', bearer(credential))
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({ hashes: [hash] }));
      expect(wrongMedia.status).toBe(415);
      expect(wrongMedia.body).toEqual({ error: 'unsupported_media_type' });

      const duplicate = await bound.api.post('/api/calibration-harness/blobs/missing')
        .set('Authorization', bearer(credential))
        .set('Content-Type', 'application/json')
        .send({ hashes: [hash, hash] });
      expect(duplicate.status).toBe(400);
      const uppercase = await bound.api.post('/api/calibration-harness/blobs/missing')
        .set('Authorization', bearer(credential))
        .set('Content-Type', 'application/json')
        .send({ hashes: [hash.toUpperCase()] });
      expect(uppercase.status).toBe(400);
      const overLimit = Array.from({ length: 513 }, (_, index) => index.toString(16).padStart(64, '0'));
      const tooMany = await bound.api.post('/api/calibration-harness/blobs/missing')
        .set('Authorization', bearer(credential))
        .set('Content-Type', 'application/json')
        .send({ hashes: overLimit });
      expect(tooMany.status).toBe(400);
    } finally {
      try {
        if (server !== undefined) await closeLoopbackServer(server);
      } finally {
        database.close();
      }
    }
  });

  it('reports missing hashes in request order using bounded owner-scoped metadata without blob materialization', async () => {
    const database = createExclusiveDatabase();
    let server: Awaited<ReturnType<typeof listenLoopback>> | undefined;
    try {
      const credential = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({
        ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000,
      });
      const metadataOnly = 'f'.repeat(64);
      const absentFirst = 'e'.repeat(64);
      const absentLast = 'd'.repeat(64);
      database.prepare(`
        INSERT INTO mpc_harness_blobs (owner_id, sha256, data, byte_length, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('owner-a', metadataOnly, Buffer.from('corrupt'), 7, 1);
      const bound = await createApp(database);
      server = bound.server;

      const response = await bound.api.post('/api/calibration-harness/blobs/missing')
        .set('Authorization', bearer(credential))
        .set('Content-Type', 'application/json')
        .send({ hashes: [absentFirst, metadataOnly, absentLast] });
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({ missing: [absentFirst, absentLast] });
    } finally {
      try {
        if (server !== undefined) await closeLoopbackServer(server);
      } finally {
        database.close();
      }
    }
  });

  it('rejects unsupported binary media and compression before storage', async () => {
    const database = createExclusiveDatabase();
    let server: Awaited<ReturnType<typeof listenLoopback>> | undefined;
    try {
      const credential = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({
        ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000,
      });
      const bytes = Buffer.from('not-an-image');
      const digest = sha256(bytes);
      const bound = await createApp(database);
      server = bound.server;

      const wrongMedia = await bound.api.put(`/api/calibration-harness/blobs/${digest}`)
        .set('Authorization', bearer(credential))
        .set('Content-Type', 'text/plain')
        .send(bytes);
      expect(wrongMedia.status).toBe(415);
      expect(wrongMedia.body).toEqual({ error: 'unsupported_media_type' });

      const compressed = await bound.api.put(`/api/calibration-harness/blobs/${digest}`)
        .set('Authorization', bearer(credential))
        .set('Content-Type', 'application/octet-stream')
        .set('Content-Encoding', 'gzip')
        .send(bytes);
      expect(compressed.status).toBe(415);
      expect(compressed.body).toEqual({ error: 'unsupported_content_encoding' });
      expect(database.prepare('SELECT count(*) AS count FROM mpc_harness_blobs').get()).toEqual({ count: 0 });
    } finally {
      try {
        if (server !== undefined) await closeLoopbackServer(server);
      } finally {
        database.close();
      }
    }
  });

  it('stores typed-array bytes, returns the exact raw bytes, and makes a repeated upload idempotent', async () => {
    const database = createExclusiveDatabase();
    let server: Awaited<ReturnType<typeof listenLoopback>> | undefined;
    try {
      const credential = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({
        ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000,
      });
      const bytes = new Uint8Array([0, 255, 1, 128, 64, 0]);
      const digest = sha256(bytes);
      const bound = await createApp(database);
      server = bound.server;

      const created = await bound.api.put(`/api/calibration-harness/blobs/${digest}`)
        .set('Authorization', bearer(credential))
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(bytes));
      expect(created.status).toBe(201);
      expect(created.headers['cache-control']).toBe('no-store');
      expect(created.body).toEqual({ sha256: digest, byteLength: bytes.byteLength, inserted: true });

      const loaded = await bound.api.get(`/api/calibration-harness/blobs/${digest}`)
        .set('Authorization', bearer(credential));
      expect(loaded.status).toBe(200);
      expect(loaded.headers['cache-control']).toBe('no-store');
      expect(loaded.headers['content-type']).toMatch(/^application\/octet-stream/);
      expect(loaded.headers['x-content-type-options']).toBe('nosniff');
      expect(loaded.headers['content-length']).toBe(String(bytes.byteLength));
      expect(loaded.body).toEqual(Buffer.from(bytes));

      const repeated = await bound.api.put(`/api/calibration-harness/blobs/${digest}`)
        .set('Authorization', bearer(credential))
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(bytes));
      expect(repeated.status).toBe(200);
      expect(repeated.body).toEqual({ sha256: digest, byteLength: bytes.byteLength, inserted: false });
    } finally {
      try {
        if (server !== undefined) await closeLoopbackServer(server);
      } finally {
        database.close();
      }
    }
  });
});
