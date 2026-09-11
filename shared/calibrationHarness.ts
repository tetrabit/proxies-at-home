/**
 * JSON values accepted by the calibration harness transport. The index signature
 * intentionally lets newer producers retain JSON-representable metadata that
 * this shared leaf does not yet understand.
 */
export type CalibrationHarnessJsonValue =
  | null
  | boolean
  | number
  | string
  | CalibrationHarnessJsonValue[]
  | CalibrationHarnessJsonObject;

export interface CalibrationHarnessJsonObject {
  [key: string]: CalibrationHarnessJsonValue | undefined;
}

export const CALIBRATION_HARNESS_FORMAT_VERSION = 1 as const;

export interface CalibrationHarnessDataset extends CalibrationHarnessJsonObject {
  id: string;
  name: string;
  description?: string;
  targetCaseCount: number;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface CalibrationHarnessSourceCardSnapshot extends CalibrationHarnessJsonObject {
  cardUuid?: string;
  projectId?: string;
  imageId?: string;
  name: string;
  set?: string;
  collectorNumber?: string;
  sourceImageUrl?: string;
  sourceArtImageUrl?: string;
}

export interface CalibrationHarnessCandidate extends CalibrationHarnessJsonObject {
  identifier: string;
  name: string;
  rawName: string;
  smallThumbnailUrl: string;
  mediumThumbnailUrl: string;
  imageUrl: string;
  dpi: number;
  tags: string[];
  sourceName: string;
  source: string;
  extension: string;
  size: number;
}

export interface CalibrationHarnessComparisonHints extends CalibrationHarnessJsonObject {
  fullCard?: Record<string, number | null>;
  artMatch?: Record<string, number | null>;
}

export interface CalibrationHarnessCase extends CalibrationHarnessJsonObject {
  id: string;
  datasetId: string;
  createdAt: number;
  updatedAt: number;
  source: CalibrationHarnessSourceCardSnapshot;
  candidates: CalibrationHarnessCandidate[];
  expectedIdentifier?: string;
  notes?: string;
  comparisonHints?: CalibrationHarnessComparisonHints;
}

export type CalibrationHarnessAssetRole =
  | "source"
  | "source-art"
  | "candidate-small";

/**
 * Asset transport metadata only. Binary bytes belong in the separately managed
 * cache/CAS and are identified here by sha256 plus byteLength.
 */
export interface CalibrationHarnessAsset extends CalibrationHarnessJsonObject {
  id: string;
  datasetId: string;
  caseId: string;
  role: CalibrationHarnessAssetRole;
  candidateIdentifier?: string;
  sourceUrl?: string;
  mimeType: string;
  createdAt: number;
  /** Legacy asset hash retained for existing adapters. */
  hash?: string;
  /** Complete identity for the separately stored binary asset. */
  sha256: string;
  byteLength: number;
  /** Binary/base64 payloads are deliberately not part of metadata JSON. */
  blob?: never;
  data?: never;
  base64?: never;
}

export interface CalibrationHarnessRunResult extends CalibrationHarnessJsonObject {
  caseId: string;
  expectedIdentifier?: string;
  predictedIdentifier?: string;
  matched: boolean;
  selectedReason?: string;
  fullProcessIdentifier?: string;
  artMatchIdentifier?: string;
  exactPrintingIdentifier?: string;
  fullCardIdentifier?: string;
}

export interface CalibrationHarnessRunSummary extends CalibrationHarnessJsonObject {
  totalCases: number;
  matchedCases: number;
  mismatchedCases: number;
  accuracy: number;
}

export interface CalibrationHarnessRun extends CalibrationHarnessJsonObject {
  id: string;
  datasetId: string;
  algorithmId: string;
  algorithmLabel?: string;
  createdAt: number;
  summary: CalibrationHarnessRunSummary;
  results: CalibrationHarnessRunResult[];
}

export interface CalibrationHarnessSnapshot extends CalibrationHarnessJsonObject {
  version: typeof CALIBRATION_HARNESS_FORMAT_VERSION;
  datasets: CalibrationHarnessDataset[];
  cases: CalibrationHarnessCase[];
  assets: CalibrationHarnessAsset[];
  runs: CalibrationHarnessRun[];
}

export interface CalibrationHarnessRevision extends CalibrationHarnessJsonObject {
  revision: number;
  snapshot: CalibrationHarnessSnapshot;
}

function serializeCanonicalJson(value: unknown): string | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const serializedValues = Array.from(
      value,
      (entry) =>
        // JSON.stringify turns unsupported array values, including undefined, into null.
        serializeCanonicalJson(entry) ?? "null"
    );
    return `[${serializedValues.join(",")}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const serializedEntries: string[] = [];

    for (const key of Object.keys(record).sort()) {
      const serializedValue = serializeCanonicalJson(record[key]);
      // JSON.stringify omits object properties whose values are undefined.
      if (serializedValue !== undefined) {
        serializedEntries.push(`${JSON.stringify(key)}:${serializedValue}`);
      }
    }

    return `{${serializedEntries.join(",")}}`;
  }

  // Match JSON.stringify object-property behavior for undefined, functions, and symbols.
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return undefined;
  }

  // BigInt is not JSON-representable; JSON.stringify supplies the native error.
  return JSON.stringify(value);
}

/**
 * Serializes a snapshot with lexicographically ordered object keys at every
 * depth. Arrays retain their existing order, and recognized plus unknown
 * JSON-representable metadata is serialized unchanged.
 *
 * This is intentionally a serializer, not a validator; schema/version and
 * reference-bound checks belong to the later validation layer. Its undefined
 * handling follows JSON.stringify: object properties with undefined values are
 * omitted, while undefined array entries become null. Undefined is not JSON.
 */
export function canonicalHarnessJson(
  snapshot: CalibrationHarnessSnapshot
): string {
  const serialized = serializeCanonicalJson(snapshot);

  if (serialized === undefined) {
    throw new TypeError(
      "A calibration harness snapshot must serialize to JSON"
    );
  }

  return serialized;
}
