import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

import {
  createPrivateRouteAuth,
  type PrivateCredentialVerifier,
  type PrivateIdentity,
} from '../auth/privateRouteAuth.js';

const fixtureRoot = path.join(
  fileURLToPath(new URL('../../../', import.meta.url)),
  '.review-artifacts',
  'backup-owner-integration-rework-01',
);
const legacyOwnerId = 'legacy-unassigned';

function createExclusiveArtifactDirectory(): string {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  while (true) {
    const artifactDirectory = path.join(fixtureRoot, randomUUID());
    try {
      fs.mkdirSync(artifactDirectory);
      return artifactDirectory;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }
}

const identities = new Map<string, PrivateIdentity>([
  ['owner-a', { ownerId: 'owner-a', capabilities: new Set(['backup:read', 'backup:write']), transport: 'server' }],
  ['owner-b', { ownerId: 'owner-b', capabilities: new Set(['backup:read', 'backup:write']), transport: 'server' }],
  ['reader', { ownerId: 'owner-a', capabilities: new Set(['backup:read']), transport: 'server' }],
  ['writer', { ownerId: 'owner-a', capabilities: new Set(['backup:write']), transport: 'server' }],
  ['legacy', { ownerId: legacyOwnerId, capabilities: new Set(['backup:read', 'backup:write']), transport: 'server' }],
]);
const verifier: PrivateCredentialVerifier = {
  verifyBearer: (bearer) => identities.get(bearer) ?? null,
};

type DbModule = typeof import('../db/db.js');

let artifactDirectory: string;
let originalServerDataDir: string | undefined;
let dbModule: DbModule | undefined;
let database: ReturnType<DbModule['initDatabase']>;
let createBackupRouter: typeof import('./backupRouter.js')['createBackupRouter'];
let backupRouter: typeof import('./backupRouter.js')['backupRouter'];

function authorized(requestBuilder: request.Test, bearer: string): request.Test {
  return requestBuilder.set('Authorization', `Bearer ${bearer}`);
}

function createApp(router = createBackupRouter({ privateRouteAuth: createPrivateRouteAuth(verifier) })): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/backup', router);
  return app;
}

describe('backupRouter owner isolation', () => {
  beforeAll(async () => {
    originalServerDataDir = process.env.SERVER_DATA_DIR;
    artifactDirectory = createExclusiveArtifactDirectory();
    process.env.SERVER_DATA_DIR = artifactDirectory;
    vi.resetModules();
    dbModule = await import('../db/db.js');
    database = dbModule.initDatabase();
    ({ createBackupRouter, backupRouter } = await import('./backupRouter.js'));
  });

  afterAll(() => {
    try {
      dbModule?.closeDatabase();
    } finally {
      if (originalServerDataDir === undefined) {
        delete process.env.SERVER_DATA_DIR;
      } else {
        process.env.SERVER_DATA_DIR = originalServerDataDir;
      }
    }
  });

  it('uses a retained, run-exclusive database fixture', () => {
    expect(path.dirname(artifactDirectory)).toBe(fixtureRoot);
    expect(path.basename(artifactDirectory)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(fs.existsSync(artifactDirectory)).toBe(true);
  });

  it('retains T16 authentication and capability gates before backup handlers', async () => {
    const projectId = `auth-project-${randomUUID()}`;
    const app = createApp();
    const anonymous = await request(app).put(`/api/backup/${projectId}`).send({ data: { denied: true } });
    const malformed = await request(app).get('/api/backup').set('Authorization', 'Basic owner-a');
    const unknown = await authorized(request(app).get('/api/backup'), 'unknown');
    const readCannotWrite = await authorized(request(app).put(`/api/backup/${projectId}`), 'reader').send({ data: { denied: true } });
    const readCannotDelete = await authorized(request(app).delete(`/api/backup/${projectId}`), 'reader');
    const writeCannotList = await authorized(request(app).get('/api/backup'), 'writer');
    const writeCannotRead = await authorized(request(app).get(`/api/backup/${projectId}`), 'writer');

    for (const response of [anonymous, malformed, unknown]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'unauthorized' });
    }
    for (const response of [readCannotWrite, readCannotDelete, writeCannotList, writeCannotRead]) {
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'forbidden' });
    }
    expect(database.prepare('SELECT COUNT(*) AS count FROM backups WHERE project_id = ?').get(projectId)).toEqual({ count: 0 });
  });

  it('returns 401 for malformed and unknown credentials before handlers run', async () => {
    const app = createApp();
    const malformed = await request(app).get('/api/backup').set('Authorization', 'Basic reader');
    const unknown = await authorized(request(app).get('/api/backup'), 'unknown');

    expect(malformed.status).toBe(401);
    expect(malformed.body).toEqual({ error: 'unauthorized' });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual({ error: 'unauthorized' });
  });

  it('isolates CRUD by server-derived owner even with identical project IDs and forged owner input', async () => {
    const projectId = `shared-project-${randomUUID()}`;
    const aOnlyProjectId = `owner-a-only-${randomUUID()}`;
    const app = createApp();

    const createdA = await authorized(request(app).put(`/api/backup/${projectId}?ownerId=owner-b`), 'owner-a')
      .set('X-Owner-Id', 'owner-b')
      .send({ ownerId: 'owner-b', data: { project: { name: 'A original' }, cards: ['A'] }, projectName: 'A original', cardCount: 1 });
    const createdB = await authorized(request(app).put(`/api/backup/${projectId}`), 'owner-b')
      .send({ ownerId: 'owner-a', data: { project: { name: 'B original' }, cards: ['B'] }, projectName: 'B original', cardCount: 2 });

    expect(createdA.status).toBe(200);
    expect(createdB.status).toBe(200);
    expect(database.prepare('SELECT owner_id, project_name FROM backups WHERE project_id = ? ORDER BY owner_id').all(projectId)).toEqual([
      { owner_id: 'owner-a', project_name: 'A original' },
      { owner_id: 'owner-b', project_name: 'B original' },
    ]);

    const aOnlyCreated = await authorized(request(app).put(`/api/backup/${aOnlyProjectId}`), 'owner-a')
      .send({ data: { project: { name: 'A only' }, cards: ['A-only'] }, projectName: 'A only', cardCount: 7 });
    const listA = await authorized(request(app).get('/api/backup'), 'owner-a');
    const listB = await authorized(request(app).get('/api/backup'), 'owner-b');
    const readA = await authorized(request(app).get(`/api/backup/${projectId}`), 'owner-a');
    const readB = await authorized(request(app).get(`/api/backup/${projectId}`), 'owner-b');
    const readAOnlyFromB = await authorized(request(app).get(`/api/backup/${aOnlyProjectId}`), 'owner-b');
    const deleteAOnlyFromB = await authorized(request(app).delete(`/api/backup/${aOnlyProjectId}`), 'owner-b');

    expect(aOnlyCreated.status).toBe(200);
    expect(listA.body.backups).toEqual(expect.arrayContaining([expect.objectContaining({ projectId, projectName: 'A original', cardCount: 1 })]));
    expect(listB.body.backups).toEqual([expect.objectContaining({ projectId, projectName: 'B original', cardCount: 2 })]);
    expect(readA.body).toMatchObject({ data: { project: { name: 'A original' }, cards: ['A'] }, projectName: 'A original', cardCount: 1 });
    expect(readB.body).toMatchObject({ data: { project: { name: 'B original' }, cards: ['B'] }, projectName: 'B original', cardCount: 2 });
    for (const response of [readAOnlyFromB, deleteAOnlyFromB]) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'not_found' });
    }
    expect((await authorized(request(app).get(`/api/backup/${aOnlyProjectId}`), 'owner-a')).body).toMatchObject({
      projectName: 'A only', cardCount: 7,
    });

    const recreatedB = await authorized(request(app).put(`/api/backup/${projectId}`), 'owner-b')
      .send({ data: { project: { name: 'B replacement' }, cards: ['B2'] }, projectName: 'B replacement', cardCount: 3 });
    const aAfterBWrite = await authorized(request(app).get(`/api/backup/${projectId}`), 'owner-a');
    const bAfterBWrite = await authorized(request(app).get(`/api/backup/${projectId}`), 'owner-b');
    const deleteA = await authorized(request(app).delete(`/api/backup/${projectId}`), 'owner-a');
    const bAfterDeleteA = await authorized(request(app).get(`/api/backup/${projectId}`), 'owner-b');

    expect(recreatedB.status).toBe(200);
    expect(aAfterBWrite.body).toMatchObject({ data: { project: { name: 'A original' }, cards: ['A'] }, projectName: 'A original', cardCount: 1 });
    expect(bAfterBWrite.body).toMatchObject({ data: { project: { name: 'B replacement' }, cards: ['B2'] }, projectName: 'B replacement', cardCount: 3 });
    expect(deleteA.body).toEqual({ deleted: true });
    expect(bAfterDeleteA.status).toBe(200);
    expect(bAfterDeleteA.body).toMatchObject({ projectName: 'B replacement', cardCount: 3 });
  });

  it('denies an injected reserved legacy identity before list, read, write, or delete access', async () => {
    const projectId = `legacy-project-${randomUUID()}`;
    database.prepare(
      'INSERT INTO backups (owner_id, project_id, project_name, data, card_count, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(legacyOwnerId, projectId, 'Legacy data', Buffer.from('legacy bytes'), 9, 20, 10);
    const app = createApp();

    const list = await authorized(request(app).get('/api/backup'), 'legacy');
    const read = await authorized(request(app).get(`/api/backup/${projectId}`), 'legacy');
    const write = await authorized(request(app).put(`/api/backup/${projectId}`), 'legacy').send({ data: { replacement: true } });
    const remove = await authorized(request(app).delete(`/api/backup/${projectId}`), 'legacy');

    for (const response of [list, read, write, remove]) {
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'forbidden' });
    }
    expect(database.prepare('SELECT project_name, data, card_count, updated_at, created_at FROM backups WHERE owner_id = ? AND project_id = ?').get(legacyOwnerId, projectId)).toEqual({
      project_name: 'Legacy data',
      data: Buffer.from('legacy bytes'),
      card_count: 9,
      updated_at: 20,
      created_at: 10,
    });
  });

  it('fails closed for the default exported router', async () => {
    const response = await request(createApp(backupRouter)).get('/api/backup');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
  });

  it('denies anonymous list, read, write, and delete before changing stored data', async () => {
    const projectId = `anonymous-project-${randomUUID()}`;
    const storedData = gzipSync(Buffer.from(JSON.stringify({ preserved: true }), 'utf-8'));
    database.prepare(
      'INSERT INTO backups (owner_id, project_id, project_name, data, card_count, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('owner-a', projectId, 'Preserved backup', storedData, 3, 10, 9);
    const app = createApp();

    const list = await request(app).get('/api/backup');
    const read = await request(app).get(`/api/backup/${projectId}`);
    const write = await request(app).put(`/api/backup/${projectId}`).send({ data: { replaced: true }, projectName: 'Replacement', cardCount: 99 });
    const remove = await request(app).delete(`/api/backup/${projectId}`);

    for (const response of [list, read, write, remove]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'unauthorized' });
    }
    expect(database.prepare(
      'SELECT project_name, data, card_count, updated_at, created_at FROM backups WHERE owner_id = ? AND project_id = ?',
    ).get('owner-a', projectId)).toEqual({
      project_name: 'Preserved backup',
      data: storedData,
      card_count: 3,
      updated_at: 10,
      created_at: 9,
    });
  });

  it('allows authenticated backup readers and writers to preserve current handler semantics', async () => {
    const projectId = `authorized-project-${randomUUID()}`;
    const app = createApp();

    const created = await authorized(request(app).put(`/api/backup/${projectId}`), 'writer')
      .send({ data: { project: { name: 'From data' }, cards: ['Sol Ring'] } });
    const listed = await authorized(request(app).get('/api/backup'), 'reader');
    const retrieved = await authorized(request(app).get(`/api/backup/${projectId}`), 'reader');
    const updated = await authorized(request(app).put(`/api/backup/${projectId}`), 'writer')
      .send({ data: { cards: ['Mana Crypt'] }, projectName: 'Explicit backup', cardCount: 1 });
    const deleted = await authorized(request(app).delete(`/api/backup/${projectId}`), 'writer');

    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ projectId, projectName: 'From data', cardCount: 0 });
    expect(listed.status).toBe(200);
    expect(listed.body.backups).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId, projectName: 'From data', cardCount: 0 }),
    ]));
    expect(retrieved.status).toBe(200);
    expect(retrieved.body).toMatchObject({
      data: { project: { name: 'From data' }, cards: ['Sol Ring'] },
      projectName: 'From data',
      cardCount: 0,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ projectId, projectName: 'Explicit backup', cardCount: 1 });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });
  });

  it('retains expected handler error logging for an authorized invalid gzip record', async () => {
    const projectId = `invalid-gzip-project-${randomUUID()}`;
    database.prepare(
      'INSERT INTO backups (owner_id, project_id, project_name, data, card_count, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('owner-a', projectId, 'Broken backup', Buffer.from('not gzip'), 1, 12, 11);
    const errorSpy = vi.spyOn(console, 'error');

    const response = await authorized(request(createApp()).get(`/api/backup/${projectId}`), 'reader');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to retrieve backup' });
    expect(errorSpy).toHaveBeenCalledWith('[Backup] Error retrieving backup:', expect.any(Error));
    errorSpy.mockRestore();
  });
});
