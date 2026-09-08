import type { ProjectBackup } from './projectBackup';

/**
 * Return a deterministic representation of every stable field in a project
 * backup. `exportedAt` is intentionally excluded because it is generated for
 * each export and does not describe project content.
 *
 * Arrays retain their order because card/display order is exported state;
 * object keys are sorted so equivalent settings objects produce one digest.
 */
export function backupContentDigest(backup: ProjectBackup): string {
  const { exportedAt: _exportedAt, ...content } = backup;
  return JSON.stringify(canonicalize(content));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => [key, canonicalize(object[key])])
    );
  }

  return value;
}
