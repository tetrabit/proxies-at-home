import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'zlib';

import {
  createPrivateRouteAuth,
  type PrivateCredentialVerifier,
  type PrivateIdentity,
} from '../auth/privateRouteAuth.js';

const fixtureRoot = path.join(
  fileURLToPath(new URL('../../../', import.meta.url)),
  '.review-artifacts',
  'backup-auth-fixture-rework-01',
);

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

const reader: PrivateIdentity = {
  ownerId: 'backup-test-owner',
  capabilities: new Set(['backup:read']),
  transport: 'server',
};
const writer: PrivateIdentity = {
  ownerId: 'backup-test-owner',
  capabilities: new Set(['backup:write']),
  transport: 'server',
};
const readerWriter: PrivateIdentity = {
  ownerId: 'backup-test-owner',
  capabilities: new Set(['backup:read', 'backup:write']),
  transport: 'server',
};

const identities = new Map<string, PrivateIdentity>([
  ['reader', reader],
  ['writer', writer],
  ['reader-writer', readerWriter],
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

describe('backupRouter private route authorization', () => {
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

  it('fails closed for the legacy exported router', async () => {
    const app = createApp(backupRouter);

    const response = await request(app).get('/api/backup');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
  });

  it('denies anonymous list, read, write, and delete before changing stored data', async () => {
    const projectId = `anonymous-project-${randomUUID()}`;
    const storedData = gzipSync(Buffer.from(JSON.stringify({ preserved: true }), 'utf-8'));
    database
      .prepare('INSERT INTO backups (project_id, project_name, data, card_count, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(projectId, 'Preserved backup', storedData, 3, 10, 9);
    const app = createApp();

    const list = await request(app).get('/api/backup');
    const read = await request(app).get(`/api/backup/${projectId}`);
    const write = await request(app)
      .put(`/api/backup/${projectId}`)
      .send({ data: { replaced: true }, projectName: 'Replacement', cardCount: 99 });
    const remove = await request(app).delete(`/api/backup/${projectId}`);
    const stored = database
      .prepare('SELECT project_name, data, card_count, updated_at, created_at FROM backups WHERE project_id = ?')
      .get(projectId) as { project_name: string; data: Buffer; card_count: number; updated_at: number; created_at: number };

    for (const response of [list, read, write, remove]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'unauthorized' });
    }
    expect(stored).toEqual({
      project_name: 'Preserved backup',
      data: storedData,
      card_count: 3,
      updated_at: 10,
      created_at: 9,
    });
  });

  it('returns 401 for malformed and unknown credentials before handlers run', async () => {
    const app = createApp();

    const malformed = await request(app)
      .get('/api/backup')
      .set('Authorization', 'Basic reader');
    const unknown = await authorized(request(app).get('/api/backup'), 'unknown').expect(401);

    expect(malformed.status).toBe(401);
    expect(malformed.body).toEqual({ error: 'unauthorized' });
    expect(unknown.body).toEqual({ error: 'unauthorized' });
  });

  it('returns 403 for the wrong backup capability before handler effects', async () => {
    const projectId = 'capability-project-001';
    const app = createApp();

    const readCannotWrite = await authorized(request(app).put(`/api/backup/${projectId}`), 'reader')
      .send({ data: { denied: true } });
    const readCannotDelete = await authorized(request(app).delete(`/api/backup/${projectId}`), 'reader');
    const writeCannotList = await authorized(request(app).get('/api/backup'), 'writer');
    const writeCannotRead = await authorized(request(app).get(`/api/backup/${projectId}`), 'writer');

    for (const response of [readCannotWrite, readCannotDelete, writeCannotList, writeCannotRead]) {
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'forbidden' });
    }
    expect(database.prepare('SELECT project_id FROM backups WHERE project_id = ?').get(projectId)).toBeUndefined();
  });

  it('allows authenticated backup readers and writers to preserve current handler semantics', async () => {
    const projectId = 'authorized-project-001';
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
    database
      .prepare('INSERT INTO backups (project_id, project_name, data, card_count, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(projectId, 'Broken backup', Buffer.from('not gzip'), 1, 12, 11);
    const errorSpy = vi.spyOn(console, 'error');

    const response = await authorized(request(createApp()).get(`/api/backup/${projectId}`), 'reader');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to retrieve backup' });
    expect(errorSpy).toHaveBeenCalledWith('[Backup] Error retrieving backup:', expect.any(Error));
    errorSpy.mockRestore();
  });
});
