/**
 * Backup Router — automatic project backup endpoints.
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { createPrivateRouteAuth, type PrivateCapability } from '../auth/privateRouteAuth.js';
import { getDatabase, LEGACY_UNASSIGNED_OWNER_ID } from '../db/db.js';
import { gzipSync, gunzipSync } from 'zlib';

type PrivateRouteAuth = {
    private(capability: PrivateCapability): RequestHandler;
};

interface BackupRouterOptions {
    privateRouteAuth?: PrivateRouteAuth;
}

const denyAllPrivateRouteAuth = createPrivateRouteAuth({
    verifyBearer: () => null,
});

function getBackupOwnerId(req: Request, res: Response): string | null {
    const ownerId = req.privateIdentity?.ownerId;
    if (!ownerId || ownerId === LEGACY_UNASSIGNED_OWNER_ID) {
        res.status(403).json({ error: 'forbidden' });
        return null;
    }
    return ownerId;
}

export function createBackupRouter(options: BackupRouterOptions = {}) {
    const router = Router();
    const privateRouteAuth = options.privateRouteAuth ?? denyAllPrivateRouteAuth;

    router.put('/:projectId', privateRouteAuth.private('backup:write'), (req, res) => {
        try {
            const ownerId = getBackupOwnerId(req, res);
            if (ownerId === null) return;
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

            const now = Date.now();
            const compressed = gzipSync(Buffer.from(JSON.stringify(data), 'utf-8'));
            const name = projectName || data.project?.name || 'Unknown Project';
            const count = typeof cardCount === 'number' ? cardCount : 0;
            const db = getDatabase();
            const existing = db.prepare(
                'SELECT project_id FROM backups WHERE owner_id = ? AND project_id = ?',
            ).get(ownerId, projectId);

            db.prepare(
                `INSERT INTO backups (owner_id, project_id, project_name, data, card_count, updated_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(owner_id, project_id) DO UPDATE SET
                   project_name = excluded.project_name,
                   data = excluded.data,
                   card_count = excluded.card_count,
                   updated_at = excluded.updated_at`,
            ).run(ownerId, projectId, name, compressed, count, now, now);
            console.log(`[Backup] ${existing ? 'Updated' : 'Created'} backup for "${name}" (${(compressed.length / 1024).toFixed(1)} KB)`);

            res.json({ projectId, projectName: name, cardCount: count, updatedAt: now, sizeBytes: compressed.length });
        } catch (error) {
            console.error('[Backup] Error saving backup:', error);
            res.status(500).json({ error: 'Failed to save backup' });
        }
    });

    router.get('/:projectId', privateRouteAuth.private('backup:read'), (req, res) => {
        try {
            const ownerId = getBackupOwnerId(req, res);
            if (ownerId === null) return;
            const { projectId } = req.params;
            if (!projectId || projectId.length < 8) {
                res.status(400).json({ error: 'Invalid project ID' });
                return;
            }

            const row = getDatabase().prepare(
                'SELECT data, project_name, card_count, updated_at, created_at FROM backups WHERE owner_id = ? AND project_id = ?',
            ).get(ownerId, projectId) as {
                data: Buffer;
                project_name: string;
                card_count: number;
                updated_at: number;
                created_at: number;
            } | undefined;
            if (!row) {
                res.status(404).json({ error: 'not_found' });
                return;
            }

            res.json({
                data: JSON.parse(gunzipSync(row.data).toString('utf-8')),
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

    router.get('/', privateRouteAuth.private('backup:read'), (req, res) => {
        try {
            const ownerId = getBackupOwnerId(req, res);
            if (ownerId === null) return;
            const rows = getDatabase().prepare(
                'SELECT project_id, project_name, card_count, updated_at, created_at, length(data) as size_bytes FROM backups WHERE owner_id = ? ORDER BY updated_at DESC',
            ).all(ownerId) as Array<{
                project_id: string;
                project_name: string;
                card_count: number;
                updated_at: number;
                created_at: number;
                size_bytes: number;
            }>;
            res.json({
                backups: rows.map((row) => ({
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

    router.delete('/:projectId', privateRouteAuth.private('backup:write'), (req, res) => {
        try {
            const ownerId = getBackupOwnerId(req, res);
            if (ownerId === null) return;
            const { projectId } = req.params;
            if (!projectId || projectId.length < 8) {
                res.status(400).json({ error: 'Invalid project ID' });
                return;
            }

            const result = getDatabase().prepare(
                'DELETE FROM backups WHERE owner_id = ? AND project_id = ?',
            ).run(ownerId, projectId);
            if (result.changes === 0) {
                res.status(404).json({ error: 'not_found' });
                return;
            }
            console.log(`[Backup] Deleted backup for project ${projectId}`);
            res.json({ deleted: true });
        } catch (error) {
            console.error('[Backup] Error deleting backup:', error);
            res.status(500).json({ error: 'Failed to delete backup' });
        }
    });

    return router;
}

export const backupRouter = createBackupRouter();
