/**
 * Auto-Restore — Recovers projects from server backups when IndexedDB is empty.
 *
 * Called once during app initialization (App.tsx), BEFORE the "create default
 * project" fallback. If IndexedDB has zero projects but the server has backups,
 * restores all of them silently.
 *
 * Flow:
 *   1. Check IndexedDB project count
 *   2. If > 0 → return (nothing to do)
 *   3. Fetch backup list from server
 *   4. For each backup: fetch full data, import as new project
 *   5. Return the list of restored project IDs (caller picks which to switch to)
 *
 * Design decisions:
 *   - Runs as a plain async function, not a React hook (called once from init)
 *   - Uses sessionStorage flag to avoid re-triggering on hot reload
 *   - Fails silently if server is unreachable (user sees normal empty state)
 *   - Restores custom images (base64) and DFC links via existing importProject()
 */

import { db } from '@/db';
import {
  listServerBackups,
  fetchServerBackup,
  importProject,
  type BackupMeta,
} from './projectBackup';
import { debugLog } from './debug';

/** SessionStorage key to prevent re-triggering on hot reload */
const RESTORE_FLAG = 'proxxied_auto_restore_done';

export interface RestoreResult {
  /** How many projects were restored */
  restoredCount: number;
  /** IDs of the newly created projects (in restore order) */
  projectIds: string[];
  /** Names of restored projects */
  projectNames: string[];
}

/**
 * Attempt to restore projects from server backups if IndexedDB is empty.
 *
 * Returns null if no restore was needed or possible.
 * Returns RestoreResult if projects were restored.
 */
export async function autoRestore(): Promise<RestoreResult | null> {
  // Guard: don't re-run in the same browser session (hot reload, StrictMode)
  if (sessionStorage.getItem(RESTORE_FLAG)) {
    return null;
  }

  try {
    // 1. Check if IndexedDB already has projects
    const existingCount = await db.projects.count();
    if (existingCount > 0) {
      // Mark as done — no restore needed
      sessionStorage.setItem(RESTORE_FLAG, 'has_data');
      return null;
    }

    // 2. Fetch backup list from server
    let backups: BackupMeta[];
    try {
      backups = await listServerBackups();
    } catch {
      // Server unreachable — fail silently
      debugLog('[AutoRestore] Server unreachable, skipping restore');
      sessionStorage.setItem(RESTORE_FLAG, 'server_unreachable');
      return null;
    }

    if (backups.length === 0) {
      debugLog('[AutoRestore] No server backups found');
      sessionStorage.setItem(RESTORE_FLAG, 'no_backups');
      return null;
    }

    // 3. Restore each backup
    debugLog(`[AutoRestore] Found ${backups.length} server backup(s), restoring...`);

    const projectIds: string[] = [];
    const projectNames: string[] = [];

    // Sort by updatedAt descending (most recent first)
    const sorted = [...backups].sort((a, b) => b.updatedAt - a.updatedAt);

    for (const meta of sorted) {
      try {
        const fullBackup = await fetchServerBackup(meta.projectId);

        // Use the original project name (no "(Imported)" suffix for auto-restore)
        const newId = await importProject(fullBackup, fullBackup.project.name);

        projectIds.push(newId);
        projectNames.push(meta.projectName);

        debugLog(
          `[AutoRestore] Restored "${meta.projectName}" (${meta.cardCount} cards)`
        );
      } catch (err) {
        // Log but continue with other backups
        console.warn(
          `[AutoRestore] Failed to restore "${meta.projectName}":`,
          err
        );
      }
    }

    sessionStorage.setItem(RESTORE_FLAG, `restored_${projectIds.length}`);

    if (projectIds.length === 0) {
      return null;
    }

    return {
      restoredCount: projectIds.length,
      projectIds,
      projectNames,
    };
  } catch (err) {
    // Catch-all: never break app init
    console.warn('[AutoRestore] Unexpected error:', err);
    sessionStorage.setItem(RESTORE_FLAG, 'error');
    return null;
  }
}
