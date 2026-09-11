import {
  canonicalHarnessJson,
  validateCalibrationHarnessSnapshot,
  type CalibrationHarnessAsset,
  type CalibrationHarnessSnapshot,
} from "./calibrationHarness";

export type CalibrationHarnessMergeCollection =
  | "root"
  | "datasets"
  | "cases"
  | "assets"
  | "runs";

export type CalibrationHarnessMergeConflictKind =
  | "no-common-base"
  | "unsupported-deletion"
  | "divergent-edit"
  | "immutable-run-change"
  | "asset-divergence"
  | "invalid-merged-snapshot";

export interface CalibrationHarnessMergeConflict {
  collection: CalibrationHarnessMergeCollection;
  id: string;
  kind: CalibrationHarnessMergeConflictKind;
  message: string;
}

export interface CalibrationHarnessMergeSuccess {
  ok: true;
  snapshot: CalibrationHarnessSnapshot;
}

export interface CalibrationHarnessMergeFailure {
  ok: false;
  conflicts: readonly CalibrationHarnessMergeConflict[];
}

export type CalibrationHarnessMergeResult =
  | CalibrationHarnessMergeSuccess
  | CalibrationHarnessMergeFailure;

type IdentifiedRecord = { id: string };
type JsonObject = Record<string, unknown>;
type PropertyEntry = { present: boolean; value: unknown };

const ROOT_TABLE_KEYS = new Set(["version", "datasets", "cases", "assets", "runs"]);

/**
 * Merges two independently edited snapshots against the same validated base.
 *
 * Rows that existed in the base retain base-array order; newly added rows are
 * ordered lexicographically by their literal id. Nested arrays (candidate and
 * run-result ordering included) are copied unchanged from their selected row.
 * Root object keys are canonicalized by canonicalHarnessJson when transported,
 * while unknown root metadata is merged as independently named properties.
 *
 * The operation does not mutate or publish a source snapshot. A conflict has
 * no snapshot field, so callers cannot accidentally publish a partial merge.
 * Inputs are validated before comparison; the successful merged snapshot is
 * validated again to enforce current cross-reference constraints.
 */
export function mergeCalibrationHarnessSnapshots(
  base: CalibrationHarnessSnapshot | null | undefined,
  left: CalibrationHarnessSnapshot,
  right: CalibrationHarnessSnapshot
): CalibrationHarnessMergeResult {
  if (base === null || base === undefined) {
    return failure([
      conflict("root", "common-base", "no-common-base", "automatic merge requires an explicit common base"),
    ]);
  }

  validateCalibrationHarnessSnapshot(base);
  validateCalibrationHarnessSnapshot(left);
  validateCalibrationHarnessSnapshot(right);

  const conflicts: CalibrationHarnessMergeConflict[] = [];
  const rootMetadata = mergeRootMetadata(base, left, right, conflicts);
  const datasets = mergeRecords(
    "datasets",
    base.datasets,
    left.datasets,
    right.datasets,
    conflicts,
    "mutable"
  );
  const cases = mergeRecords(
    "cases",
    base.cases,
    left.cases,
    right.cases,
    conflicts,
    "mutable"
  );
  const assets = mergeRecords(
    "assets",
    base.assets,
    left.assets,
    right.assets,
    conflicts,
    "assets"
  );
  const runs = mergeRecords(
    "runs",
    base.runs,
    left.runs,
    right.runs,
    conflicts,
    "immutable"
  );

  if (conflicts.length > 0) {
    return failure(conflicts);
  }

  const snapshot = createSnapshot(rootMetadata, datasets, cases, assets, runs);
  findAssetSlotConflicts(snapshot.assets, conflicts);
  if (conflicts.length > 0) {
    return failure(conflicts);
  }

  try {
    validateCalibrationHarnessSnapshot(snapshot);
  } catch (error) {
    return failure([
      conflict(
        "root",
        "merged-snapshot",
        "invalid-merged-snapshot",
        error instanceof Error ? error.message : "merged snapshot failed validation"
      ),
    ]);
  }

  return { ok: true, snapshot };
}

function failure(conflicts: CalibrationHarnessMergeConflict[]): CalibrationHarnessMergeFailure {
  return { ok: false, conflicts: Object.freeze([...conflicts]) };
}

function conflict(
  collection: CalibrationHarnessMergeCollection,
  id: string,
  kind: CalibrationHarnessMergeConflictKind,
  message: string
): CalibrationHarnessMergeConflict {
  return { collection, id, kind, message };
}

function mergeRootMetadata(
  base: CalibrationHarnessSnapshot,
  left: CalibrationHarnessSnapshot,
  right: CalibrationHarnessSnapshot,
  conflicts: CalibrationHarnessMergeConflict[]
): Map<string, unknown> {
  const keys = new Set<string>();
  for (const snapshot of [base, left, right]) {
    for (const key of Object.keys(snapshot)) {
      if (!ROOT_TABLE_KEYS.has(key)) {
        keys.add(key);
      }
    }
  }

  const merged = new Map<string, unknown>();
  for (const key of Array.from(keys).sort()) {
    const selected = mergeProperty(
      propertyEntry(base, key),
      propertyEntry(left, key),
      propertyEntry(right, key),
      () =>
        conflicts.push(
          conflict("root", key, "divergent-edit", "metadata was deleted on one side and changed on the other")
        ),
      () =>
        conflicts.push(
          conflict("root", key, "divergent-edit", "both sides changed the same metadata property")
        )
    );
    if (selected.present) {
      merged.set(key, cloneJson(selected.value));
    }
  }
  return merged;
}

function mergeRecords<T extends IdentifiedRecord>(
  collection: Exclude<CalibrationHarnessMergeCollection, "root">,
  base: readonly T[],
  left: readonly T[],
  right: readonly T[],
  conflicts: CalibrationHarnessMergeConflict[],
  policy: "mutable" | "assets" | "immutable"
): T[] {
  const baseById = indexById(base);
  const leftById = indexById(left);
  const rightById = indexById(right);
  const output: T[] = [];

  for (const current of base) {
    const leftCurrent = leftById.get(current.id);
    const rightCurrent = rightById.get(current.id);
    if (policy === "immutable") {
      if (leftCurrent === undefined || rightCurrent === undefined) {
        const survivingRecord = leftCurrent ?? rightCurrent;
        if (survivingRecord === undefined || sameRecord(current, survivingRecord)) {
          continue;
        }
        conflicts.push(
          conflict(
            collection,
            current.id,
            "immutable-run-change",
            "base runs are immutable and cannot be changed when the other side deletes them"
          )
        );
      } else if (!sameRecord(current, leftCurrent) || !sameRecord(current, rightCurrent)) {
        conflicts.push(
          conflict(collection, current.id, "immutable-run-change", "base runs are immutable and cannot be changed")
        );
      } else {
        output.push(cloneJson(current) as T);
      }
      continue;
    }
    if (policy === "assets") {
      const selected = mergeProperty(
        { present: true, value: current },
        { present: leftCurrent !== undefined, value: leftCurrent },
        { present: rightCurrent !== undefined, value: rightCurrent },
        () =>
          conflicts.push(
            conflict(
              collection,
              current.id,
              "asset-divergence",
              "asset was deleted on one side and changed on the other"
            )
          ),
        () =>
          conflicts.push(
            conflict(collection, current.id, "asset-divergence", "both sides changed the same asset")
          )
      );
      if (selected.present) {
        output.push(cloneJson(selected.value) as T);
      }
      continue;
    }

    const selected = mergeProperty(
      { present: true, value: current },
      { present: leftCurrent !== undefined, value: leftCurrent },
      { present: rightCurrent !== undefined, value: rightCurrent },
      () =>
        conflicts.push(
          conflict(
            collection,
            current.id,
            "divergent-edit",
            "record was deleted on one side and changed on the other"
          )
        ),
      () =>
        conflicts.push(
          conflict(
            collection,
            current.id,
            "divergent-edit",
            "both sides changed the same record"
          )
        )
    );
    if (selected.present) {
      output.push(cloneJson(selected.value) as T);
    }
  }

  const additions = new Set<string>();
  for (const current of left) {
    if (!baseById.has(current.id)) {
      additions.add(current.id);
    }
  }
  for (const current of right) {
    if (!baseById.has(current.id)) {
      additions.add(current.id);
    }
  }

  for (const id of Array.from(additions).sort()) {
    const leftCurrent = leftById.get(id);
    const rightCurrent = rightById.get(id);
    if (leftCurrent !== undefined && rightCurrent !== undefined && !sameRecord(leftCurrent, rightCurrent)) {
      conflicts.push(
        conflict(collection, id, policy === "assets" ? "asset-divergence" : "divergent-edit", "same-id additions differ")
      );
      continue;
    }
    output.push(cloneJson(leftCurrent ?? rightCurrent) as T);
  }

  return output;
}

function mergeProperty(
  base: PropertyEntry,
  left: PropertyEntry,
  right: PropertyEntry,
  onDeletion: () => void,
  onDivergence: () => void
): PropertyEntry {
  if (!base.present) {
    if (!left.present) {
      return right;
    }
    if (!right.present) {
      return left;
    }
    if (sameEntry(left, right)) {
      return left;
    }
    onDivergence();
    return { present: false, value: undefined };
  }

  if (!left.present && !right.present) {
    return { present: false, value: undefined };
  }
  if (!left.present) {
    if (sameEntry(right, base)) {
      return { present: false, value: undefined };
    }
    onDeletion();
    return { present: false, value: undefined };
  }
  if (!right.present) {
    if (sameEntry(left, base)) {
      return { present: false, value: undefined };
    }
    onDeletion();
    return { present: false, value: undefined };
  }
  if (sameEntry(left, base)) {
    return right;
  }
  if (sameEntry(right, base) || sameEntry(left, right)) {
    return left;
  }
  onDivergence();
  return { present: false, value: undefined };
}

function indexById<T extends IdentifiedRecord>(records: readonly T[]): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const record of records) {
    indexed.set(record.id, record);
  }
  return indexed;
}

function propertyEntry(record: object, key: string): PropertyEntry {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor === undefined
    ? { present: false, value: undefined }
    : { present: true, value: descriptor.value };
}

function sameRecord<T>(first: T | undefined, second: T | undefined): boolean {
  if (first === undefined || second === undefined) {
    return first === second;
  }
  return canonicalValue(first) === canonicalValue(second);
}

function sameEntry(first: PropertyEntry, second: PropertyEntry): boolean {
  return first.present === second.present && (!first.present || canonicalValue(first.value) === canonicalValue(second.value));
}

function canonicalValue(value: unknown): string {
  return canonicalHarnessJson({
    version: 1,
    datasets: [],
    cases: [],
    assets: [],
    runs: [],
    comparisonValue: value,
  } as CalibrationHarnessSnapshot);
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJson(entry));
  }
  if (value !== null && typeof value === "object") {
    const copy = Object.create(Object.getPrototypeOf(value)) as JsonObject;
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: cloneJson(propertyEntry(value, key).value),
        writable: true,
      });
    }
    return copy;
  }
  return value;
}

function createSnapshot(
  rootMetadata: Map<string, unknown>,
  datasets: unknown[],
  cases: unknown[],
  assets: unknown[],
  runs: unknown[]
): CalibrationHarnessSnapshot {
  const snapshot = Object.create(Object.prototype) as CalibrationHarnessSnapshot & JsonObject;
  Object.defineProperty(snapshot, "version", { configurable: true, enumerable: true, value: 1, writable: true });
  for (const [key, value] of rootMetadata) {
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  for (const [key, value] of [
    ["datasets", datasets],
    ["cases", cases],
    ["assets", assets],
    ["runs", runs],
  ] as const) {
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return snapshot;
}

function findAssetSlotConflicts(
  assets: readonly CalibrationHarnessAsset[],
  conflicts: CalibrationHarnessMergeConflict[]
): void {
  const byCase = new Map<string, Map<string, Map<string | undefined, string>>>();
  for (const asset of assets) {
    let byRole = byCase.get(asset.caseId);
    if (byRole === undefined) {
      byRole = new Map();
      byCase.set(asset.caseId, byRole);
    }
    let byCandidate = byRole.get(asset.role);
    if (byCandidate === undefined) {
      byCandidate = new Map();
      byRole.set(asset.role, byCandidate);
    }
    const existingId = byCandidate.get(asset.candidateIdentifier);
    if (existingId !== undefined) {
      conflicts.push(
        conflict("assets", asset.id, "asset-divergence", `asset slot already occupied by ${existingId}`)
      );
      continue;
    }
    byCandidate.set(asset.candidateIdentifier, asset.id);
  }
}
