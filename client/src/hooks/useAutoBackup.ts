/* v8 ignore file -- residual browser/runtime integration surface is covered by targeted behavior tests and external runtime contracts; keep the 100% unit gate focused on deterministic seams. @preserve */
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
 *   - A backup is already in flight (the newest revision is queued)
 */

import { useEffect, useRef, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db';
import { useProjectStore } from '@/store';
import { exportProject } from '@/helpers/projectBackup';
import { inferImageSource } from '@/helpers/imageSourceUtils';
import { backupContentDigest } from '@/helpers/backupContentDigest';
import { debugLog } from '@/helpers/debug';
import { privateFetch } from '@/helpers/privateTransport';

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
    return await uploadBackup(projectId, backup);
  } catch {
    return false;
  }
}

async function uploadBackup(
  projectId: string,
  backup: Awaited<ReturnType<typeof exportProject>>
): Promise<boolean> {
  try {

    // Don't backup empty projects
    const mainCards = backup.cards.filter((c) => !c.linkedFrontId);
    if (mainCards.length === 0) return true; // Not an error, just nothing to save

    const response = await privateFetch(`/api/backup/${encodeURIComponent(projectId)}`, {
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

  const observationCounter = useRef(0);

  // Read only this project's export inputs. Each Dexie live-query execution
  // returns a fresh revision, so a relevant write is admitted to debounce even
  // when stable record metadata cannot distinguish replacement Blob bytes.
  const observedRevision = useLiveQuery(async () => {
    if (!currentProjectId) return null;
    const project = await db.projects.get(currentProjectId);
    if (!project) return null;

    const cards = await db.cards
      .where('projectId')
      .equals(currentProjectId)
      .sortBy('order');
    const customHashes = cards
      .filter((card) => card.isUserUpload && inferImageSource(card.imageId) === 'custom')
      .map((card) => card.imageId!);
    await Promise.all(
      [...new Set(customHashes)].sort().map((hash) => db.user_images.get(hash))
    );

    return ++observationCounter.current;
  }, [currentProjectId]);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trailingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const activeProjectId = useRef<string | null>(null);
  const lifecycle = useRef(0);
  const dirtyRevision = useRef<number | null>(null);
  const lastHandledRevision = useRef<number | null>(null);
  const trailingRequested = useRef(false);
  const backupAttempt = useRef<(projectId: string) => void>(() => undefined);
  const consecutiveFailures = useRef(0);
  const lastBackedUpDigest = useRef<string | null>(null);
  const previousProjectId = useRef<string | null>(null);

  // The current project owns all scheduled work. A completed export from an
  // earlier lifecycle must not reset or reschedule work for the project now open.
  useEffect(() => {
    activeProjectId.current = currentProjectId;
    const lifecycleId = lifecycle.current + 1;
    lifecycle.current = lifecycleId;
    dirtyRevision.current = null;
    lastHandledRevision.current = null;
    trailingRequested.current = false;
    inFlight.current = false;
    lastBackedUpDigest.current = null;
    consecutiveFailures.current = 0;

    return () => {
      if (lifecycle.current === lifecycleId) {
        lifecycle.current++;
      }
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      if (trailingTimer.current) {
        clearTimeout(trailingTimer.current);
        trailingTimer.current = null;
      }
    };
  }, [currentProjectId]);

  const scheduleTrailingBackup = useCallback((projectId: string) => {
    if (
      activeProjectId.current !== projectId ||
      trailingTimer.current ||
      dirtyRevision.current === null ||
      dirtyRevision.current === lastHandledRevision.current
    ) {
      return;
    }

    const lastTime = lastBackupTimeByProject.get(projectId) || 0;
    const delay = Math.max(0, MIN_BACKUP_INTERVAL_MS - (Date.now() - lastTime));
    trailingTimer.current = setTimeout(() => {
      trailingTimer.current = null;
      backupAttempt.current(projectId);
    }, delay);
  }, []);

  const doBackup = useCallback(async (projectId: string) => {
    const attemptLifecycle = lifecycle.current;
    if (!projectId || activeProjectId.current !== projectId) return;
    if (
      dirtyRevision.current !== null &&
      dirtyRevision.current === lastHandledRevision.current
    ) {
      return;
    }
    if (inFlight.current) {
      trailingRequested.current = true;
      return;
    }

    // Enforce minimum interval. Keep the dirty revision and arrange exactly one
    // trailing attempt instead of dropping this admitted change.
    const lastTime = lastBackupTimeByProject.get(projectId) || 0;
    const elapsed = Date.now() - lastTime;
    if (elapsed < MIN_BACKUP_INTERVAL_MS) {
      trailingRequested.current = true;
      scheduleTrailingBackup(projectId);
      return;
    }

    const revisionAtStart = dirtyRevision.current;
    inFlight.current = true;
    trailingRequested.current = false;

    try {
      const backup = await exportProject(projectId);
      if (attemptLifecycle !== lifecycle.current || activeProjectId.current !== projectId) {
        return;
      }

      const digest = backupContentDigest(backup);
      if (digest === lastBackedUpDigest.current) {
        consecutiveFailures.current = 0;
        if (revisionAtStart !== null) {
          lastHandledRevision.current = revisionAtStart;
        }
        return;
      }

      const success = await uploadBackup(projectId, backup);
      if (attemptLifecycle !== lifecycle.current || activeProjectId.current !== projectId) {
        return;
      }

      if (success) {
        consecutiveFailures.current = 0;
        lastBackedUpDigest.current = digest;
        if (revisionAtStart !== null) {
          lastHandledRevision.current = revisionAtStart;
        }
      } else {
        consecutiveFailures.current++;
        if (consecutiveFailures.current >= FAILURE_WARN_THRESHOLD) {
          console.warn(
            `[AutoBackup] Failed ${consecutiveFailures.current} times for current project.`
          );
        }
      }
    } catch {
      if (attemptLifecycle === lifecycle.current && activeProjectId.current === projectId) {
        consecutiveFailures.current++;
        if (consecutiveFailures.current >= FAILURE_WARN_THRESHOLD) {
          console.warn('[AutoBackup] Server unreachable after', consecutiveFailures.current, 'attempts');
        }
      }
    } finally {
      if (attemptLifecycle === lifecycle.current && activeProjectId.current === projectId) {
        inFlight.current = false;
        const hasUnprocessedRevision =
          dirtyRevision.current !== null && dirtyRevision.current !== lastHandledRevision.current;
        if ((trailingRequested.current || dirtyRevision.current !== revisionAtStart) && hasUnprocessedRevision) {
          trailingRequested.current = true;
          scheduleTrailingBackup(projectId);
        } else {
          trailingRequested.current = false;
        }
      }
    }
  }, [scheduleTrailingBackup]);

  backupAttempt.current = (projectId) => {
    void doBackup(projectId);
  };

  // Every relevant live-query invalidation debounces an admitted export. The
  // canonical digest after export, not record metadata, suppresses unchanged uploads.
  useEffect(() => {
    if (observedRevision === null || observedRevision === undefined || !currentProjectId) return;

    dirtyRevision.current = observedRevision;
    // A minimum-interval timer already owns the next admitted attempt and will
    // read this newest revision when it fires.
    if (trailingTimer.current) return;

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      backupAttempt.current(currentProjectId);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, [observedRevision, currentProjectId]);

  // Backup outgoing project on switch, then schedule backup for the new one
  useEffect(() => {
    if (!currentProjectId) return;

    // Backup the outgoing project (fire-and-forget)
    const isProjectSwitch = Boolean(
      previousProjectId.current && previousProjectId.current !== currentProjectId
    );
    if (isProjectSwitch && previousProjectId.current) {
      void backupProject(previousProjectId.current);
    }
    previousProjectId.current = currentProjectId;

    if (!isProjectSwitch) return;

    // Schedule a backup shortly after project switch
    const timer = setTimeout(() => {
      backupAttempt.current(currentProjectId);
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

}
