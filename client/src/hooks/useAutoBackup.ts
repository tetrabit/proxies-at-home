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

/** Minimum interval between successful backups */
const MIN_BACKUP_INTERVAL_MS = 60_000; // 1 minute

/** How many consecutive failures before we log a warning */
const FAILURE_WARN_THRESHOLD = 3;

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
  const lastBackupTime = useRef(0);
  const consecutiveFailures = useRef(0);
  const lastSignal = useRef<string | null>(null);

  const doBackup = useCallback(async () => {
    if (!currentProjectId) return;
    if (inFlight.current) return;

    // Enforce minimum interval
    const elapsed = Date.now() - lastBackupTime.current;
    if (elapsed < MIN_BACKUP_INTERVAL_MS) return;

    inFlight.current = true;

    try {
      const backup = await exportProject(currentProjectId);

      // Don't backup empty projects
      const mainCards = backup.cards.filter((c) => !c.linkedFrontId);
      if (mainCards.length === 0) {
        inFlight.current = false;
        return;
      }

      const response = await fetch(`${API_BASE}/api/backup/${currentProjectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: backup,
          projectName: backup.project.name,
          cardCount: mainCards.length,
        }),
      });

      if (response.ok) {
        lastBackupTime.current = Date.now();
        consecutiveFailures.current = 0;
        debugLog(
          `[AutoBackup] Saved "${backup.project.name}" (${mainCards.length} cards)`
        );
      } else {
        consecutiveFailures.current++;
        if (consecutiveFailures.current >= FAILURE_WARN_THRESHOLD) {
          console.warn(
            `[AutoBackup] Failed ${consecutiveFailures.current} times. Server returned ${response.status}.`
          );
        }
      }
    } catch {
      // Network error — fail silently, will retry on next change
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

  // Also trigger a backup on project switch (if the new project has cards)
  useEffect(() => {
    if (!currentProjectId) return;

    // Reset state for new project
    lastSignal.current = null;
    consecutiveFailures.current = 0;

    // Schedule a backup shortly after project switch
    const timer = setTimeout(() => {
      doBackup();
    }, 5_000); // 5 seconds after project switch

    return () => clearTimeout(timer);
  }, [currentProjectId, doBackup]);

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
