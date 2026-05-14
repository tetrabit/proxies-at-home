import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { gunzipSync, gzipSync } from 'zlib';

const prepare = vi.fn();
const db = { prepare };
vi.mock('../db/db.js', () => ({ getDatabase: vi.fn(() => db) }));

const { backupRouter } = await import('./backupRouter.js');

const app = express();
app.use(express.json());
app.use('/api/backup', backupRouter);

describe('backupRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    prepare.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT project_id')) return { get: vi.fn(() => undefined) };
      if (sql.startsWith('INSERT INTO backups')) return { run: vi.fn() };
      if (sql.startsWith('UPDATE backups')) return { run: vi.fn() };
      if (sql.startsWith('SELECT data')) return { get: vi.fn(() => undefined) };
      if (sql.startsWith('SELECT project_id, project_name')) return { all: vi.fn(() => []) };
      if (sql.startsWith('DELETE FROM backups')) return { run: vi.fn(() => ({ changes: 1 })) };
      return { get: vi.fn(), all: vi.fn(), run: vi.fn() };
    });
  });

  it('rejects invalid project IDs and invalid backup data', async () => {
    expect((await request(app).put('/api/backup/short').send({ data: {} })).status).toBe(400);
    const invalidData = await request(app).put('/api/backup/project123').send({ data: null });
    expect(invalidData.status).toBe(400);
    expect(invalidData.body.error).toBe('Missing or invalid backup data');
  });

  it('creates a compressed backup with fallback name and card count', async () => {
    let inserted: unknown[] = [];
    prepare.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT project_id')) return { get: vi.fn(() => undefined) };
      if (sql.startsWith('INSERT INTO backups')) return { run: vi.fn((...args: unknown[]) => { inserted = args; }) };
      return { run: vi.fn(), get: vi.fn(), all: vi.fn() };
    });

    const response = await request(app)
      .put('/api/backup/project123')
      .send({ data: { project: { name: 'From Data' }, cards: [1] } });

    expect(response.status).toBe(200);
    expect(response.body.projectName).toBe('From Data');
    expect(response.body.cardCount).toBe(0);
    expect(gunzipSync(inserted[2] as Buffer).toString('utf-8')).toBe(JSON.stringify({ project: { name: 'From Data' }, cards: [1] }));
  });

  it('updates an existing backup with explicit metadata', async () => {
    const updateRun = vi.fn();
    prepare.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT project_id')) return { get: vi.fn(() => ({ project_id: 'project123' })) };
      if (sql.startsWith('UPDATE backups')) return { run: updateRun };
      return { run: vi.fn(), get: vi.fn(), all: vi.fn() };
    });

    const response = await request(app)
      .put('/api/backup/project123')
      .send({ data: { project: { name: 'Ignored' } }, projectName: 'Explicit', cardCount: 7 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ projectId: 'project123', projectName: 'Explicit', cardCount: 7 });
    expect(updateRun).toHaveBeenCalled();
  });

  it('returns 500 when saving a backup throws', async () => {
    prepare.mockImplementation(() => { throw new Error('db down'); });
    const response = await request(app).put('/api/backup/project123').send({ data: {} });
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to save backup');
  });

  it('retrieves, validates, and handles missing backups', async () => {
    expect((await request(app).get('/api/backup/short')).status).toBe(400);

    const missing = await request(app).get('/api/backup/project123');
    expect(missing.status).toBe(404);

    const stored = { cards: ['Sol Ring'] };
    prepare.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT data')) return { get: vi.fn(() => ({
        data: gzipSync(Buffer.from(JSON.stringify(stored), 'utf-8')),
        project_name: 'Deck',
        card_count: 1,
        updated_at: 2,
        created_at: 1,
      })) };
      return { run: vi.fn(), get: vi.fn(), all: vi.fn() };
    });

    const response = await request(app).get('/api/backup/project123');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: stored, projectName: 'Deck', cardCount: 1, updatedAt: 2, createdAt: 1 });
  });

  it('returns 500 when retrieving backup data fails', async () => {
    prepare.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT data')) return { get: vi.fn(() => ({ data: Buffer.from('not gzip') })) };
      return { run: vi.fn(), get: vi.fn(), all: vi.fn() };
    });
    const response = await request(app).get('/api/backup/project123');
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to retrieve backup');
  });

  it('lists backup metadata and reports list failures', async () => {
    prepare.mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT project_id, project_name')) return { all: vi.fn(() => [{
        project_id: 'project123', project_name: 'Deck', card_count: 2, updated_at: 4, created_at: 3, size_bytes: 99,
      }]) };
      return { run: vi.fn(), get: vi.fn(), all: vi.fn() };
    });
    const response = await request(app).get('/api/backup');
    expect(response.status).toBe(200);
    expect(response.body.backups[0]).toEqual({ projectId: 'project123', projectName: 'Deck', cardCount: 2, updatedAt: 4, createdAt: 3, sizeBytes: 99 });

    prepare.mockImplementation(() => { throw new Error('db'); });
    const failed = await request(app).get('/api/backup');
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe('Failed to list backups');
  });

  it('deletes backups with validation, not-found, and failure handling', async () => {
    expect((await request(app).delete('/api/backup/short')).status).toBe(400);

    prepare.mockImplementation((sql: string) => {
      if (sql.startsWith('DELETE FROM backups')) return { run: vi.fn(() => ({ changes: 0 })) };
      return { run: vi.fn(), get: vi.fn(), all: vi.fn() };
    });
    expect((await request(app).delete('/api/backup/project123')).status).toBe(404);

    prepare.mockImplementation((sql: string) => {
      if (sql.startsWith('DELETE FROM backups')) return { run: vi.fn(() => ({ changes: 1 })) };
      return { run: vi.fn(), get: vi.fn(), all: vi.fn() };
    });
    const deleted = await request(app).delete('/api/backup/project123');
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true });

    prepare.mockImplementation(() => { throw new Error('db'); });
    const failed = await request(app).delete('/api/backup/project123');
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe('Failed to delete backup');
  });
});
