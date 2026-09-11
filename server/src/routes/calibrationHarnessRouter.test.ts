import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createCalibrationHarnessCredentialStore } from '../auth/calibrationHarnessIdentity.js';
import { createPrivateRouteAuth, createSingleBearerVerifier } from '../auth/privateRouteAuth.js';
import { createCalibrationHarnessBlobStore } from '../db/calibrationHarnessBlobs.js';
import { initializeCalibrationHarnessSchema } from '../db/calibrationHarnessSchema.js';
import { openNativeDatabase } from '../db/openNativeDatabase.js';
import {
  closeLoopbackServer,
  createCalibrationHarnessFixtureProvider,
  listenLoopback,
} from '../testUtils/calibrationHarnessFixtures.js';
import { createCalibrationHarnessRouter } from './calibrationHarnessRouter.js';

const fixtures = createCalibrationHarnessFixtureProvider();
const now = 1_700_000_000_000;
const webOrigin = 'http://127.0.0.1:4173';

const fixtureInvocationRoot = fixtures.createInvocationRoot();

function createExclusiveDatabase() {
  const directory = fixtures.createExclusiveDirectory(fixtureInvocationRoot);
  const database = openNativeDatabase(path.join(directory, 'calibration-harness.db'));
  initializeCalibrationHarnessSchema(database);
  return database;
}

function snapshot(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    datasets: [{ id: 'dataset-a', name: 'Dataset A', targetCaseCount: 1, createdAt: 1, updatedAt: 2, version: 1, retainedUnknown: 'case-sensitive' }],
    cases: [{
      id: 'case-a', datasetId: 'dataset-a', createdAt: 1, updatedAt: 2,
      source: { name: 'Card A' }, candidates: [], retainedUnknown: { nested: ['value'] },
    }],
    assets: [],
    runs: [{
      id: 'run-a', datasetId: 'dataset-a', algorithmId: 'algorithm-a', createdAt: 3,
      summary: { totalCases: 1, matchedCases: 1, mismatchedCases: 0, accuracy: 1 },
      results: [{ caseId: 'case-a', matched: true }], retainedUnknown: true,
    }],
    retainedUnknown: { values: [1, 2, 3] },
    ...extra,
  };
}

async function createApp(database: ReturnType<typeof createExclusiveDatabase>, laterParser: RequestHandler = express.json()) {
  const app = express();
  app.use('/api/calibration-harness', createCalibrationHarnessRouter({ database, allowedWebOrigins: [webOrigin], now: () => now }));
  // H1's test app deliberately mounts the generic parser after the router.
  app.use(laterParser);
  const server = await listenLoopback(app);
  return { server, api: request(server) };
}

function bearer(token: string) {
  return `Bearer ${token}`;
}

describe('createCalibrationHarnessRouter', () => {
  it('uses module-relative exclusive fixture directories and rejects collisions and symlink ancestors before writes', () => {
    const firstInvocation = fixtures.createInvocationRoot();
    const secondInvocation = fixtures.createInvocationRoot();
    expect(firstInvocation).not.toBe(secondInvocation);
    expect(path.relative(fixtures.repositoryRoot, firstInvocation).startsWith(`..${path.sep}`)).toBe(false);
    expect(path.relative(fixtures.repositoryRoot, secondInvocation).startsWith(`..${path.sep}`)).toBe(false);

    const collisionName = randomUUID();
    const collision = fixtures.createExclusiveDirectory(firstInvocation, collisionName);
    expect(() => fixtures.createExclusiveDirectory(firstInvocation, collisionName)).toThrow('exclusive fixture collision');

    const hostileAncestor = path.join(firstInvocation, randomUUID());
    fs.symlinkSync(firstInvocation, hostileAncestor, 'dir');
    const rejectedChild = path.join(hostileAncestor, 'must-not-be-written');
    expect(() => fixtures.createExclusiveDirectory(hostileAncestor, 'must-not-be-written'))
      .toThrow('fixture path must not have a symbolic-link ancestor');
    expect(fs.existsSync(rejectedChild)).toBe(false);
    expect(fs.lstatSync(collision).isDirectory()).toBe(true);
  });

  it('contains anonymous and authenticated unsupported namespace requests before the later generic parser', async () => {
    const database = createExclusiveDatabase();
    let server: Server | undefined;
    try {
      const credential = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({
        ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000,
      });
      const parser = express.json();
      const genericParser = vi.fn((request: express.Request, response: express.Response, next: express.NextFunction) => {
        parser(request, response, next);
      });
      const bound = await createApp(database, genericParser);
      server = bound.server;
      const { api } = bound;

      const anonymous = await api.post('/api/calibration-harness/snapshot')
        .set('Content-Type', 'application/json')
        .send('{not-json');
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers['cache-control']).toBe('no-store');
      expect(anonymous.body).toEqual({ error: 'unauthorized' });

      const unknown = await api.put('/api/calibration-harness/unknown')
        .set('Authorization', bearer(credential))
        .set('Content-Type', 'application/json')
        .send('{not-json');
      expect(unknown.status).toBe(404);
      expect(unknown.headers['cache-control']).toBe('no-store');
      expect(unknown.body).toEqual({ error: 'not_found' });

      const unsupported = await api.post('/api/calibration-harness/session')
        .set('Authorization', bearer(credential))
        .set('Content-Type', 'application/json')
        .send('{not-json');
      expect(unsupported.status).toBe(405);
      expect(unsupported.headers['cache-control']).toBe('no-store');
      expect(unsupported.body).toEqual({ error: 'method_not_allowed' });
      expect(genericParser).not.toHaveBeenCalled();
    } finally {
      try {
        if (server !== undefined) await closeLoopbackServer(server);
      } finally {
        database.close();
      }
    }
  });

  it('creates, reads, and updates the full scoped snapshot with exact revision ETags', async () => {
    const database = createExclusiveDatabase();
    let server: Server | undefined;
    try {
      const credential = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({
        ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000,
      });
      const bound = await createApp(database);
      server = bound.server;
      const { api } = bound;
      const created = await api
        .put('/api/calibration-harness/snapshot?ownerId=owner-b&harnessId=harness-b')
        .set('Authorization', bearer(credential))
        .set('If-None-Match', '*')
        .send(snapshot());
      expect(created.status).toBe(201);
      expect(created.headers.etag).toBe('"1"');
      expect(created.headers['cache-control']).toBe('no-store');
      expect(created.body).toEqual({ revision: 1, snapshot: snapshot() });

      const read = await api
        .get('/api/calibration-harness/snapshot?ownerId=owner-b&harnessId=harness-b')
        .set('Authorization', bearer(credential));
      expect(read.status).toBe(200);
      expect(read.headers.etag).toBe('"1"');
      expect(read.body).toEqual(created.body);

      const updatedSnapshot = snapshot({ retainedUnknown: { values: ['new'] } });
      const updated = await api
        .put('/api/calibration-harness/snapshot')
        .set('Authorization', bearer(credential))
        .set('If-Match', '"1"')
        .send(updatedSnapshot);
      expect(updated.status).toBe(200);
      expect(updated.headers.etag).toBe('"2"');
      expect(updated.body).toEqual({ revision: 2, snapshot: updatedSnapshot });
    } finally {
      try {
        if (server !== undefined) await closeLoopbackServer(server);
      } finally {
        database.close();
      }
    }
  });

  it('requires exactly one explicit canonical precondition and preserves the current revision on rejection', async () => {
    const database = createExclusiveDatabase();
    let server: Server | undefined;
    try {
      const credential = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({
        ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000,
      });
      const bound = await createApp(database);
      server = bound.server;
      const { api } = bound;
      const initial = snapshot();
      expect((await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(credential)).set('If-None-Match', '*').send(initial)).status).toBe(201);

      const missing = await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(credential)).send(snapshot({ retainedUnknown: 'missing' }));
      expect(missing.status).toBe(428);
      for (const headers of [
        { 'If-Match': 'W/"1"' },
        { 'If-Match': '"01"' },
        { 'If-Match': '"0"' },
        { 'If-Match': '"1", "2"' },
        { 'If-Match': '*' },
        { 'If-None-Match': '"*"' },
        { 'If-Match': '"1"', 'If-None-Match': '*' },
      ]) {
        const rejected = await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(credential)).set(headers).send(snapshot({ retainedUnknown: headers }));
        expect(rejected.status).toBe(400);
      }
      const stale = await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(credential)).set('If-Match', '"2"').send(snapshot({ retainedUnknown: 'stale' }));
      expect(stale.status).toBe(412);
      const createAgain = await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(credential)).set('If-None-Match', '*').send(snapshot({ retainedUnknown: 'create-again' }));
      expect(createAgain.status).toBe(412);
      const current = await api.get('/api/calibration-harness/snapshot').set('Authorization', bearer(credential));
      expect(current.body).toEqual({ revision: 1, snapshot: initial });
    } finally {
      try {
        if (server !== undefined) await closeLoopbackServer(server);
      } finally {
        database.close();
      }
    }
  });

  it('keeps owners and harnesses isolated and authenticates before its metadata parser', async () => {
    const database = createExclusiveDatabase();
    let server: Server | undefined;
    try {
      const credentials = createCalibrationHarnessCredentialStore(database, { now: () => now });
      const ownerA = credentials.provision({ ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000 });
      const ownerB = credentials.provision({ ownerId: 'owner-b', harnessId: 'harness-b', expiresAt: now + 60_000 });
      const bound = await createApp(database);
      server = bound.server;
      const { api } = bound;
      expect((await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(ownerB)).set('If-None-Match', '*').send(snapshot({ retainedUnknown: 'owner-b' }))).status).toBe(201);

      const forged = await api.get('/api/calibration-harness/snapshot?ownerId=owner-b&harnessId=harness-b').set('Authorization', bearer(ownerA)).set('X-Owner-Id', 'owner-b');
      expect(forged.status).toBe(404);
      const own = await api.get('/api/calibration-harness/snapshot').set('Authorization', bearer(ownerB));
      expect(own.status).toBe(200);
      expect(own.body.snapshot.retainedUnknown).toBe('owner-b');

      const anonymousMalformed = await api.put('/api/calibration-harness/snapshot').set('If-None-Match', '*').set('Content-Type', 'application/json').send('{not-json');
      expect(anonymousMalformed.status).toBe(401);
      const privateCredential = 'private-route-credential';
      const privateApp = express();
      privateApp.get('/private', createPrivateRouteAuth(createSingleBearerVerifier(privateCredential, {
        ownerId: 'owner-a', capabilities: new Set(['backup:read']), transport: 'server',
      })).private('backup:read'), (_request, response) => response.status(204).end());
      const privateServer = await listenLoopback(privateApp);
      try {
        expect((await request(privateServer).get('/private').set('Authorization', bearer(privateCredential))).status).toBe(204);
      } finally {
        await closeLoopbackServer(privateServer);
      }
      const unrelatedCredential = await api.get('/api/calibration-harness/snapshot').set('Authorization', bearer(privateCredential));
      expect(unrelatedCredential.status).toBe(401);
    } finally {
      try {
        if (server !== undefined) await closeLoopbackServer(server);
      } finally {
        database.close();
      }
    }
  });

  it('supports approved pairing and cookie sessions without exposing credentials, and revokes on unpair', async () => {
    const database = createExclusiveDatabase();
    let server: Server | undefined;
    try {
      const credential = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({ ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000 });
      const bound = await createApp(database);
      server = bound.server;
      const { api } = bound;
      expect((await api.post('/api/calibration-harness/pair').set('Authorization', bearer(credential))).status).toBe(401);
      const paired = await api.post('/api/calibration-harness/pair').set('Origin', webOrigin).set('Authorization', bearer(credential));
      expect(paired.status).toBe(200);
      expect(paired.headers['cache-control']).toBe('no-store');
      expect(paired.body).toEqual({ ownerId: 'owner-a', harnessId: 'harness-a' });
      expect(JSON.stringify(paired.body)).not.toContain('calibration_');
      const cookie = paired.headers['set-cookie'][0]!;
      const session = await api.get('/api/calibration-harness/session').set('Cookie', cookie).set('Origin', webOrigin);
      expect(session.status).toBe(200);
      expect(session.body).toEqual({ ownerId: 'owner-a', harnessId: 'harness-a' });
      const foreignOrigin = await api.get('/api/calibration-harness/session').set('Cookie', cookie).set('Origin', 'http://127.0.0.1:4999');
      expect(foreignOrigin.status).toBe(401);
      const duplicateCredentials = await api.get('/api/calibration-harness/session').set('Cookie', cookie).set('Authorization', bearer(credential)).set('Origin', webOrigin);
      expect(duplicateCredentials.status).toBe(401);
      const unpaired = await api.post('/api/calibration-harness/unpair').set('Cookie', cookie).set('Origin', webOrigin);
      expect(unpaired.status).toBe(204);
      expect(unpaired.headers['cache-control']).toBe('no-store');
      const revoked = await api.get('/api/calibration-harness/session').set('Cookie', cookie).set('Origin', webOrigin);
      expect(revoked.status).toBe(401);
    } finally {
      try {
        if (server !== undefined) await closeLoopbackServer(server);
      } finally {
        database.close();
      }
    }
  });

  it('rejects bad metadata admission and validates each same-owner blob reference by SQL metadata only', async () => {
    const database = createExclusiveDatabase();
    let server: Server | undefined;
    try {
      const credentials = createCalibrationHarnessCredentialStore(database, { now: () => now });
      const ownerA = credentials.provision({ ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000 });
      const ownerB = credentials.provision({ ownerId: 'owner-b', harnessId: 'harness-b', expiresAt: now + 60_000 });
      const blob = createCalibrationHarnessBlobStore(database);
      const bytes = Buffer.from('valid-image');
      const digest = createHash('sha256').update(bytes).digest('hex');
      blob.put('owner-a', digest, bytes);
      const bound = await createApp(database);
      server = bound.server;
      const { api } = bound;
      const withAsset = snapshot({ assets: [{ id: 'asset-a', datasetId: 'dataset-a', caseId: 'case-a', role: 'source', mimeType: 'image/png', createdAt: 4, sha256: digest, byteLength: bytes.byteLength }] });
      expect((await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(ownerA)).set('If-None-Match', '*').send(withAsset)).status).toBe(201);
      const missing = snapshot({ assets: [{ id: 'asset-missing', datasetId: 'dataset-a', caseId: 'case-a', role: 'source', mimeType: 'image/png', createdAt: 4, sha256: 'a'.repeat(64), byteLength: 1 }] });
      expect((await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(ownerB)).set('If-None-Match', '*').send(missing)).status).toBe(400);
      const foreign = snapshot({ assets: [{ id: 'asset-foreign', datasetId: 'dataset-a', caseId: 'case-a', role: 'source', mimeType: 'image/png', createdAt: 4, sha256: digest, byteLength: bytes.byteLength }] });
      expect((await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(ownerB)).set('If-None-Match', '*').send(foreign)).status).toBe(400);
      const invalidContentType = await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(ownerA)).set('If-Match', '"1"').set('Content-Type', 'text/plain').send('{}');
      expect(invalidContentType.status).toBe(415);
      const compressed = await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(ownerA)).set('If-Match', '"1"').set('Content-Encoding', 'gzip').set('Content-Type', 'application/json').send(Buffer.from('{}'));
      expect(compressed.status).toBe(415);
      const malformed = await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(ownerA)).set('If-Match', '"1"').set('Content-Type', 'application/json').send('{nope');
      expect(malformed.status).toBe(400);
      const invalidSnapshot = await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(ownerA)).set('If-Match', '"1"').send({ version: 2 });
      expect(invalidSnapshot.status).toBe(400);
      const unchanged = await api.get('/api/calibration-harness/snapshot').set('Authorization', bearer(ownerA));
      expect(unchanged.body.revision).toBe(1);
    } finally {
      try {
        if (server !== undefined) await closeLoopbackServer(server);
      } finally {
        database.close();
      }
    }
  });

  it('commits only one concurrent same-base update and rejects duplicate headers, oversized bodies, and inconsistent logical blob lengths', async () => {
    const database = createExclusiveDatabase();
    let server: Server | undefined;
    try {
      const credential = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({ ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000 });
      const blob = createCalibrationHarnessBlobStore(database);
      const bytes = Buffer.from('shared-image');
      const digest = createHash('sha256').update(bytes).digest('hex');
      blob.put('owner-a', digest, bytes);
      const bound = await createApp(database);
      server = bound.server;
      const { api } = bound;
      expect((await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(credential)).set('If-None-Match', '*').send(snapshot())).status).toBe(201);

      const duplicate = await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(credential)).set('If-Match', ['"1"', '"1"'] as unknown as string).send(snapshot());
      expect(duplicate.status).toBe(400);
      const oversized = await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(credential)).set('If-Match', '"1"').set('Content-Type', 'application/json').send(Buffer.alloc(32 * 1024 * 1024 + 1, 0x20));
      expect(oversized.status).toBe(413);

      const candidate = { identifier: 'candidate-a', name: 'Candidate A', rawName: 'Candidate A', smallThumbnailUrl: '', mediumThumbnailUrl: '', imageUrl: '', dpi: 72, tags: [], sourceName: '', source: '', extension: 'png', size: bytes.byteLength };
      const inconsistent = snapshot({
        cases: [{ id: 'case-a', datasetId: 'dataset-a', createdAt: 1, updatedAt: 2, source: { name: 'Card A' }, candidates: [candidate] }],
        assets: [
          { id: 'asset-source', datasetId: 'dataset-a', caseId: 'case-a', role: 'source', mimeType: 'image/png', createdAt: 4, sha256: digest, byteLength: bytes.byteLength },
          { id: 'asset-candidate', datasetId: 'dataset-a', caseId: 'case-a', role: 'candidate-small', candidateIdentifier: 'candidate-a', mimeType: 'image/png', createdAt: 4, sha256: digest, byteLength: bytes.byteLength + 1 },
        ],
      });
      const inconsistentResult = await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(credential)).set('If-Match', '"1"').send(inconsistent);
      expect(inconsistentResult.status).toBe(400);
      database.pragma('ignore_check_constraints = ON');
      database.prepare('UPDATE mpc_harness_blobs SET byte_length = ? WHERE owner_id = ? AND sha256 = ?').run(bytes.byteLength + 1, 'owner-a', digest);
      database.pragma('ignore_check_constraints = OFF');
      const corruptLength = await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(credential)).set('If-Match', '"1"').send(snapshot({ assets: [{ id: 'asset-corrupt', datasetId: 'dataset-a', caseId: 'case-a', role: 'source', mimeType: 'image/png', createdAt: 4, sha256: digest, byteLength: bytes.byteLength }] }));
      expect(corruptLength.status).toBe(400);

      const [first, second] = await Promise.all([
        api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(credential)).set('If-Match', '"1"').send(snapshot({ retainedUnknown: 'first' })),
        api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(credential)).set('If-Match', '"1"').send(snapshot({ retainedUnknown: 'second' })),
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 412]);
      const current = await api.get('/api/calibration-harness/snapshot').set('Authorization', bearer(credential));
      expect(current.body.revision).toBe(2);
      expect(['first', 'second']).toContain(current.body.snapshot.retainedUnknown);
    } finally {
      try {
        if (server !== undefined) await closeLoopbackServer(server);
      } finally {
        database.close();
      }
    }
  });

  it('returns a bounded operational error without altering current or revision history', async () => {
    const database = createExclusiveDatabase();
    let server: Server | undefined;
    try {
      const credential = createCalibrationHarnessCredentialStore(database, { now: () => now }).provision({ ownerId: 'owner-a', harnessId: 'harness-a', expiresAt: now + 60_000 });
      const bound = await createApp(database);
      server = bound.server;
      const { api } = bound;
      const initial = snapshot();
      expect((await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(credential)).set('If-None-Match', '*').send(initial)).status).toBe(201);
      database.pragma('query_only = ON');
      const unavailable = await api.put('/api/calibration-harness/snapshot').set('Authorization', bearer(credential)).set('If-Match', '"1"').send(snapshot({ retainedUnknown: 'blocked' }));
      expect(unavailable.status).toBe(500);
      expect(unavailable.body).toEqual({ error: 'storage_error' });
      database.pragma('query_only = OFF');
      const current = await api.get('/api/calibration-harness/snapshot').set('Authorization', bearer(credential));
      expect(current.body).toEqual({ revision: 1, snapshot: initial });
      const history = database.prepare('SELECT revision FROM mpc_harness_revisions WHERE owner_id = ? AND harness_id = ? ORDER BY revision').all('owner-a', 'harness-a');
      expect(history).toEqual([{ revision: 1 }]);
    } finally {
      database.pragma('query_only = OFF');
      try {
        if (server !== undefined) await closeLoopbackServer(server);
      } finally {
        database.close();
      }
    }
  });
});
