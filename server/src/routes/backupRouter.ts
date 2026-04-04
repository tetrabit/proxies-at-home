/**
 * Backup Router — automatic project backup endpoints
 *
 * PUT  /api/backup/:projectId  — Upsert a project backup (gzipped)
 * GET  /api/backup/:projectId  — Retrieve a project backup
 * GET  /api/backup             — List all backups (metadata only)
 * DELETE /api/backup/:projectId — Delete a backup
 */

import { Router } from 'express';
import { getDatabase } from '../db/db.js';
import { gzipSync, gunzipSync } from 'zlib';

const router = Router();

/**
 * PUT /api/backup/:projectId
 * Create or update a project backup.
 * Body: { data: ProjectBackup object, projectName: string, cardCount: number }
 */
router.put('/:projectId', (req, res) => {
    try {
        const { projectId } = req.params;
        const { data, projectName, cardCount } = req.body;

        if (!projectId || projectId.length < 8) {
            res.status(400).json({ error: 'Invalid project ID' });
            return;
        }

        if (!data || typeof data !== 'object') {
            res.status(400).json({ error: 'Missing or invalid backup data' });
            return;
        }

        const db = getDatabase();
        const now = Date.now();

        // Serialize and compress
        const jsonStr = JSON.stringify(data);
        const compressed = gzipSync(Buffer.from(jsonStr, 'utf-8'));

        const name = projectName || data.project?.name || 'Unknown Project';
        const count = typeof cardCount === 'number' ? cardCount : 0;

        // UPSERT
        const existing = db.prepare('SELECT project_id FROM backups WHERE project_id = ?').get(projectId);
        if (existing) {
            db.prepare(
                'UPDATE backups SET project_name = ?, data = ?, card_count = ?, updated_at = ? WHERE project_id = ?'
            ).run(name, compressed, count, now, projectId);
            console.log(`[Backup] Updated backup for "${name}" (${(compressed.length / 1024).toFixed(1)} KB)`);
        } else {
            db.prepare(
                'INSERT INTO backups (project_id, project_name, data, card_count, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(projectId, name, compressed, count, now, now);
            console.log(`[Backup] Created backup for "${name}" (${(compressed.length / 1024).toFixed(1)} KB)`);
        }

        res.json({
            projectId,
            projectName: name,
            cardCount: count,
            updatedAt: now,
            sizeBytes: compressed.length,
        });
    } catch (error) {
        console.error('[Backup] Error saving backup:', error);
        res.status(500).json({ error: 'Failed to save backup' });
    }
});

/**
 * GET /api/backup/:projectId
 * Retrieve a project backup.
 */
router.get('/:projectId', (req, res) => {
    try {
        const { projectId } = req.params;

        if (!projectId || projectId.length < 8) {
            res.status(400).json({ error: 'Invalid project ID' });
            return;
        }

        const db = getDatabase();
        const row = db.prepare(
            'SELECT data, project_name, card_count, updated_at, created_at FROM backups WHERE project_id = ?'
        ).get(projectId) as {
            data: Buffer;
            project_name: string;
            card_count: number;
            updated_at: number;
            created_at: number;
        } | undefined;

        if (!row) {
            res.status(404).json({ error: 'Backup not found' });
            return;
        }

        // Decompress and parse
        const decompressed = gunzipSync(row.data).toString('utf-8');
        const data = JSON.parse(decompressed);

        res.json({
            data,
            projectName: row.project_name,
            cardCount: row.card_count,
            updatedAt: row.updated_at,
            createdAt: row.created_at,
        });
    } catch (error) {
        console.error('[Backup] Error retrieving backup:', error);
        res.status(500).json({ error: 'Failed to retrieve backup' });
    }
});

/**
 * GET /api/backup
 * List all backups (metadata only, no data payload).
 */
router.get('/', (_req, res) => {
    try {
        const db = getDatabase();
        const rows = db.prepare(
            'SELECT project_id, project_name, card_count, updated_at, created_at, length(data) as size_bytes FROM backups ORDER BY updated_at DESC'
        ).all() as Array<{
            project_id: string;
            project_name: string;
            card_count: number;
            updated_at: number;
            created_at: number;
            size_bytes: number;
        }>;

        res.json({
            backups: rows.map(row => ({
                projectId: row.project_id,
                projectName: row.project_name,
                cardCount: row.card_count,
                updatedAt: row.updated_at,
                createdAt: row.created_at,
                sizeBytes: row.size_bytes,
            })),
        });
    } catch (error) {
        console.error('[Backup] Error listing backups:', error);
        res.status(500).json({ error: 'Failed to list backups' });
    }
});

/**
 * DELETE /api/backup/:projectId
 * Delete a project backup.
 */
router.delete('/:projectId', (req, res) => {
    try {
        const { projectId } = req.params;

        if (!projectId || projectId.length < 8) {
            res.status(400).json({ error: 'Invalid project ID' });
            return;
        }

        const db = getDatabase();
        const result = db.prepare('DELETE FROM backups WHERE project_id = ?').run(projectId);

        if (result.changes === 0) {
            res.status(404).json({ error: 'Backup not found' });
            return;
        }

        console.log(`[Backup] Deleted backup for project ${projectId}`);
        res.json({ deleted: true });
    } catch (error) {
        console.error('[Backup] Error deleting backup:', error);
        res.status(500).json({ error: 'Failed to delete backup' });
    }
});

export { router as backupRouter };
