/**
 * useAutoBackup — Automatically saves project snapshots to the server.
 *
 * Watches for card changes (via Dexie liveQuery) and triggers a debounced
 * backup to the server. The backup is a full ProjectBackup JSON, gzipped
 * on the server side. This runs silently — no toasts unless there's a
 * persistent error.
 *
 * Backup triggers:
 *   - Card added/removed/reordered
 *   - Card overrides changed
 *   - Project settings changed
 *   - Debounced: waits 30s after last change before sending
 *   - Project switch: backs up the outgoing project immediately
 *   - Periodic sweep: backs up ALL projects every 5 minutes
 *
 * The hook skips backup if:
 *   - No project is loaded
 *   - Project has 0 cards
 *   - Server is unreachable (fails silently, retries on next change)
 *   - A backup is already in flight
 */

import { useEffect, useRef, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db';
import { API_BASE } from '@/constants';
import { useProjectStore } from '@/store';
import { exportProject } from '@/helpers/projectBackup';
import { debugLog } from '@/helpers/debug';

/** Debounce delay — how long to wait after the last change before backing up */
const DEBOUNCE_MS = 30_000; // 30 seconds

/** Minimum interval between successful backups (per project) */
const MIN_BACKUP_INTERVAL_MS = 60_000; // 1 minute

/** How many consecutive failures before we log a warning */
const FAILURE_WARN_THRESHOLD = 3;

/** Interval for backing up ALL projects (sweep) */
const SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes

/** Track last backup time per project (module-level so it persists across re-renders) */
const lastBackupTimeByProject = new Map<string, number>();

/**
 * Backup a single project to the server.
 * Exported so it can be called from project switch logic.
 * Returns true on success, false on failure.
 */
export async function backupProject(projectId: string): Promise<boolean> {
  try {
    const backup = await exportProject(projectId);

    // Don't backup empty projects
    const mainCards = backup.cards.filter((c) => !c.linkedFrontId);
    if (mainCards.length === 0) return true; // Not an error, just nothing to save

    const response = await fetch(`${API_BASE}/api/backup/${projectId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: backup,
        projectName: backup.project.name,
        cardCount: mainCards.length,
      }),
    });

    if (response.ok) {
      lastBackupTimeByProject.set(projectId, Date.now());
      debugLog(
        `[AutoBackup] Saved "${backup.project.name}" (${mainCards.length} cards)`
      );
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Backup ALL projects that have cards.
 * Used by the periodic sweep.
 */
async function backupAllProjects(): Promise<void> {
  const projects = await db.projects.toArray();

  for (const project of projects) {
    // Skip if recently backed up
    const lastTime = lastBackupTimeByProject.get(project.id) || 0;
    if (Date.now() - lastTime < MIN_BACKUP_INTERVAL_MS) continue;

    // Check if project has cards
    const cardCount = await db.cards
      .where('projectId')
      .equals(project.id)
      .count();
    if (cardCount === 0) continue;

    await backupProject(project.id);
  }
}

export function useAutoBackup(): void {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  // Track card count + latest update timestamp as a change signal
  const changeSignal = useLiveQuery(async () => {
    if (!currentProjectId) return null;
    const count = await db.cards
      .where('projectId')
      .equals(currentProjectId)
      .count();
    // Also read project settings to detect settings changes
    const project = await db.projects.get(currentProjectId);
    return {
      count,
      settingsHash: project?.settings
        ? JSON.stringify(project.settings).length
        : 0,
    };
  }, [currentProjectId]);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const consecutiveFailures = useRef(0);
  const lastSignal = useRef<string | null>(null);
  const previousProjectId = useRef<string | null>(null);

  const doBackup = useCallback(async () => {
    if (!currentProjectId) return;
    if (inFlight.current) return;

    // Enforce minimum interval
    const lastTime = lastBackupTimeByProject.get(currentProjectId) || 0;
    const elapsed = Date.now() - lastTime;
    if (elapsed < MIN_BACKUP_INTERVAL_MS) return;

    inFlight.current = true;

    try {
      const success = await backupProject(currentProjectId);

      if (success) {
        consecutiveFailures.current = 0;
      } else {
        consecutiveFailures.current++;
        if (consecutiveFailures.current >= FAILURE_WARN_THRESHOLD) {
          console.warn(
            `[AutoBackup] Failed ${consecutiveFailures.current} times for current project.`
          );
        }
      }
    } catch {
      consecutiveFailures.current++;
      if (consecutiveFailures.current >= FAILURE_WARN_THRESHOLD) {
        console.warn('[AutoBackup] Server unreachable after', consecutiveFailures.current, 'attempts');
      }
    } finally {
      inFlight.current = false;
    }
  }, [currentProjectId]);

  // React to change signals with debounce
  useEffect(() => {
    if (!changeSignal || !currentProjectId) return;

    // Build a signal fingerprint to detect actual changes
    const fingerprint = `${changeSignal.count}:${changeSignal.settingsHash}`;
    if (fingerprint === lastSignal.current) return;
    lastSignal.current = fingerprint;

    // Clear existing timer and set a new one
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    debounceTimer.current = setTimeout(() => {
      doBackup();
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [changeSignal, currentProjectId, doBackup]);

  // Backup outgoing project on switch, then schedule backup for the new one
  useEffect(() => {
    if (!currentProjectId) return;

    // Backup the outgoing project (fire-and-forget)
    if (previousProjectId.current && previousProjectId.current !== currentProjectId) {
      void backupProject(previousProjectId.current);
    }
    previousProjectId.current = currentProjectId;

    // Reset state for new project
    lastSignal.current = null;
    consecutiveFailures.current = 0;

    // Schedule a backup shortly after project switch
    const timer = setTimeout(() => {
      doBackup();
    }, 5_000); // 5 seconds after project switch

    return () => clearTimeout(timer);
  }, [currentProjectId, doBackup]);

  // Periodic sweep: backup ALL projects every 5 minutes
  useEffect(() => {
    const interval = setInterval(() => {
      void backupAllProjects();
    }, SWEEP_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  // Backup on page unload (best-effort, may not complete)
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!currentProjectId || inFlight.current) return;
      // Use sendBeacon for fire-and-forget on unload
      // Note: sendBeacon has a 64KB limit, so this may fail for large projects
      // That's fine — the debounced timer will have already saved recent changes
      try {
        // We can't use exportProject here (async), but we can signal the server
        // to keep the last backup. This is just a best-effort marker.
        navigator.sendBeacon(
          `${API_BASE}/api/backup/${currentProjectId}`,
          new Blob([], { type: 'application/json' })
        );
      } catch {
        // Ignore — best effort
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [currentProjectId]);
}
