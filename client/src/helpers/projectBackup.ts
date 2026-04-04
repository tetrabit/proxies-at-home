/**
 * Project Backup — Export/Import full project state as JSON
 *
 * Exports: project metadata, all cards (with art selections, overrides,
 * DFC links, categories), project settings, and custom image uploads
 * (as base64 data URIs for portability).
 *
 * Import creates a new project from the backup, re-mapping UUIDs to
 * avoid collisions with existing data.
 */

import { db, type Project } from '../db';
import type { CardOption } from '@/types';
import { inferImageSource } from './imageSourceUtils';

// ============================================================================
// Schema
// ============================================================================

/** Bump when the backup format changes in a breaking way */
const BACKUP_VERSION = 1;

/** Serialised card — CardOption minus ephemeral/runtime fields */
interface BackupCard {
  /** Original UUID (used only for DFC link resolution during import) */
  uuid: string;
  name: string;
  order: number;
  imageId?: string;
  isUserUpload: boolean;
  hasBuiltInBleed?: boolean;
  bleedMode?: string;
  existingBleedMm?: number;
  generateBleedMm?: number;
  set?: string;
  number?: string;
  scryfall_id?: string;
  oracle_id?: string;
  lang?: string;
  colors?: string[];
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  rarity?: string;
  category?: string;
  overrides?: CardOption['overrides'];
  // DFC references (original UUIDs — remapped on import)
  linkedFrontId?: string;
  linkedBackId?: string;
  usesDefaultCardback?: boolean;
  // Token metadata
  token_parts?: CardOption['token_parts'];
  needs_token?: boolean;
  isToken?: boolean;
  tokenAddedFrom?: string[];
}

/** A custom image included in the backup */
interface BackupUserImage {
  /** Content-addressed SHA-256 hash (original key in user_images table) */
  hash: string;
  /** MIME type */
  type: string;
  /** Base64-encoded image data */
  data: string;
}

/** Top-level backup envelope */
export interface ProjectBackup {
  /** Format version */
  version: typeof BACKUP_VERSION;
  /** ISO timestamp of export */
  exportedAt: string;
  /** Proxxied app identifier */
  app: 'proxxied';
  /** Project metadata */
  project: {
    name: string;
    createdAt: number;
    settings: Project['settings'];
  };
  /** All cards in display order */
  cards: BackupCard[];
  /** Custom image uploads referenced by cards (base64) */
  userImages: BackupUserImage[];
}

// ============================================================================
// Export
// ============================================================================

/**
 * Strips a CardOption to only the fields worth persisting.
 * Drops enrichment bookkeeping, lookup errors, and runtime flags.
 */
function cardToBackup(card: CardOption): BackupCard {
  return {
    uuid: card.uuid,
    name: card.name,
    order: card.order,
    imageId: card.imageId,
    isUserUpload: card.isUserUpload,
    hasBuiltInBleed: card.hasBuiltInBleed,
    bleedMode: card.bleedMode,
    existingBleedMm: card.existingBleedMm,
    generateBleedMm: card.generateBleedMm,
    set: card.set,
    number: card.number,
    scryfall_id: card.scryfall_id,
    oracle_id: card.oracle_id,
    lang: card.lang,
    colors: card.colors,
    mana_cost: card.mana_cost,
    cmc: card.cmc,
    type_line: card.type_line,
    rarity: card.rarity,
    category: card.category,
    overrides: card.overrides,
    linkedFrontId: card.linkedFrontId,
    linkedBackId: card.linkedBackId,
    usesDefaultCardback: card.usesDefaultCardback,
    token_parts: card.token_parts,
    needs_token: card.needs_token,
    isToken: card.isToken,
    tokenAddedFrom: card.tokenAddedFrom,
  };
}

/**
 * Convert a Blob to a base64 string.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Strip the data:mime;base64, prefix — we store mime separately
      const base64 = result.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Export a project as a JSON backup object.
 * Includes all cards and referenced custom uploads.
 */
export async function exportProject(projectId: string): Promise<ProjectBackup> {
  const project = await db.projects.get(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  // Fetch all cards for this project, sorted by order
  const cards = await db.cards
    .where('projectId')
    .equals(projectId)
    .sortBy('order');

  // Identify custom upload image hashes that need to be included
  const customHashes = new Set<string>();
  for (const card of cards) {
    if (card.isUserUpload && card.imageId) {
      const source = inferImageSource(card.imageId);
      if (source === 'custom') {
        customHashes.add(card.imageId);
      }
    }
  }

  // Fetch custom images from user_images table
  const userImages: BackupUserImage[] = [];
  for (const hash of customHashes) {
    const img = await db.user_images.get(hash);
    if (img) {
      const base64 = await blobToBase64(img.data);
      userImages.push({
        hash: img.hash,
        type: img.type,
        data: base64,
      });
    }
  }

  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    app: 'proxxied',
    project: {
      name: project.name,
      createdAt: project.createdAt,
      settings: project.settings,
    },
    cards: cards.map(cardToBackup),
    userImages,
  };
}

/**
 * Trigger a browser download of the backup JSON.
 */
export function downloadBackup(backup: ProjectBackup): void {
  const json = JSON.stringify(backup, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = backup.project.name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .substring(0, 60);
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `proxxied_${safeName}_${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============================================================================
// Import
// ============================================================================

/**
 * Validate a parsed JSON object as a ProjectBackup.
 * Returns a typed backup or throws with a human-readable message.
 */
export function validateBackup(data: unknown): ProjectBackup {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid backup: not a JSON object');
  }

  const obj = data as Record<string, unknown>;

  if (obj.app !== 'proxxied') {
    throw new Error('Invalid backup: not a Proxxied backup file');
  }

  if (typeof obj.version !== 'number' || obj.version > BACKUP_VERSION) {
    throw new Error(
      `Unsupported backup version ${obj.version}. ` +
      `This app supports version ${BACKUP_VERSION}. Try updating the app.`
    );
  }

  if (!obj.project || typeof obj.project !== 'object') {
    throw new Error('Invalid backup: missing project metadata');
  }

  if (!Array.isArray(obj.cards)) {
    throw new Error('Invalid backup: missing cards array');
  }

  return data as ProjectBackup;
}

/**
 * Convert a base64 string to a Blob.
 */
function base64ToBlob(base64: string, mimeType: string): Blob {
  const byteChars = atob(base64);
  const byteArrays: Uint8Array[] = [];

  // Process in 1KB slices to avoid stack overflow on large images
  for (let offset = 0; offset < byteChars.length; offset += 1024) {
    const slice = byteChars.slice(offset, offset + 1024);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    byteArrays.push(new Uint8Array(byteNumbers));
  }

  return new Blob(byteArrays, { type: mimeType });
}

/**
 * Import a backup into a new project.
 *
 * Returns the new project ID.
 * Cards get fresh UUIDs; DFC links are remapped.
 */
export async function importProject(
  backup: ProjectBackup,
  projectName?: string
): Promise<string> {
  const newProjectId = crypto.randomUUID();
  const name = projectName || `${backup.project.name} (Imported)`;

  // 1. Restore custom images first (idempotent — content-addressed)
  for (const img of backup.userImages) {
    const existing = await db.user_images.get(img.hash);
    if (!existing) {
      const blob = base64ToBlob(img.data, img.type);
      await db.user_images.put({
        hash: img.hash,
        data: blob,
        type: img.type,
        createdAt: Date.now(),
      });
    }
  }

  // 2. Build UUID remap table (old → new)
  const uuidMap = new Map<string, string>();
  for (const card of backup.cards) {
    uuidMap.set(card.uuid, crypto.randomUUID());
  }

  // 3. Create card records with new UUIDs and remapped links
  const newCards: CardOption[] = backup.cards.map((card) => {
    const newUuid = uuidMap.get(card.uuid)!;
    const newLinkedFrontId = card.linkedFrontId
      ? uuidMap.get(card.linkedFrontId)
      : undefined;
    const newLinkedBackId = card.linkedBackId
      ? uuidMap.get(card.linkedBackId)
      : undefined;

    return {
      ...card,
      uuid: newUuid,
      projectId: newProjectId,
      linkedFrontId: newLinkedFrontId,
      linkedBackId: newLinkedBackId,
      // Re-trigger enrichment so images get fetched
      needsEnrichment: !card.isUserUpload,
    };
  });

  // 4. Write project + cards in a single transaction
  await db.transaction('rw', db.projects, db.cards, async () => {
    await db.projects.add({
      id: newProjectId,
      name,
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
      cardCount: newCards.filter((c) => !c.linkedFrontId).length,
      settings: backup.project.settings || {},
    });

    await db.cards.bulkAdd(newCards);
  });

  return newProjectId;
}

// ============================================================================
// File picker helper
// ============================================================================

/**
 * Open a file picker and read a JSON backup file.
 * Returns the parsed & validated backup, or null if cancelled.
 */
export function pickBackupFile(): Promise<ProjectBackup | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }

      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const backup = validateBackup(data);
        resolve(backup);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    // Handle cancel (no file selected)
    input.oncancel = () => resolve(null);

    // Some browsers don't fire oncancel — use focus fallback
    const handleFocus = () => {
      setTimeout(() => {
        if (!input.files?.length) {
          resolve(null);
        }
        window.removeEventListener('focus', handleFocus);
      }, 300);
    };
    window.addEventListener('focus', handleFocus);

    input.click();
  });
}

// ============================================================================
// Server backup API helpers
// ============================================================================

import { API_BASE } from '@/constants';

/** Metadata for a server-side backup (no data payload) */
export interface BackupMeta {
  projectId: string;
  projectName: string;
  cardCount: number;
  updatedAt: number;
  createdAt: number;
  sizeBytes: number;
}

/**
 * List all backups stored on the server (metadata only).
 */
export async function listServerBackups(): Promise<BackupMeta[]> {
  const response = await fetch(`${API_BASE}/api/backup`);
  if (!response.ok) {
    throw new Error('Failed to list server backups');
  }
  const result = await response.json();
  return result.backups;
}

/**
 * Fetch a full backup from the server by project ID.
 */
export async function fetchServerBackup(projectId: string): Promise<ProjectBackup> {
  const response = await fetch(`${API_BASE}/api/backup/${projectId}`);
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Backup not found on server');
    }
    throw new Error('Failed to fetch backup from server');
  }
  const result = await response.json();
  return validateBackup(result.data);
}

/**
 * Delete a backup from the server.
 */
export async function deleteServerBackup(projectId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/backup/${projectId}`, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404) {
    throw new Error('Failed to delete backup');
  }
}
