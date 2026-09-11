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

/** Bounded limits for untrusted, metadata-only calibration harness snapshots. */
export const CALIBRATION_HARNESS_LIMITS = Object.freeze({
  maxMetadataBytes: 32 * 1024 * 1024,
  maxAssetBytes: 32 * 1024 * 1024,
  maxDepth: 32,
  maxDatasets: 100,
  maxCases: 5_000,
  maxAssets: 100_000,
  maxRuns: 1_000,
  maxCandidatesPerCase: 5_000,
  maxResultsPerRun: 5_000,
  maxUnknownArrayLength: 100_000,
  maxObjectProperties: 100_000,
  maxNodes: 2_000_000,
  maxStringBytes: 32 * 1024 * 1024,
} as const);

export class CalibrationHarnessValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalibrationHarnessValidationError";
  }
}

type JsonRecord = Record<string, unknown>;

const textEncoder = new TextEncoder();
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function invalid(path: string, message: string): never {
  throw new CalibrationHarnessValidationError(`${path}: ${message}`);
}

function isPlainJsonObject(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializedStringBytes(value: string, path: string, availableMetadataBytes: number): number {
  let rawBytes = 0;
  let serializedBytes = 2; // Opening and closing JSON string quotes.

  const reserveRaw = (amount: number): void => {
    rawBytes += amount;
    if (rawBytes > CALIBRATION_HARNESS_LIMITS.maxStringBytes) {
      invalid(path, "string bytes exceed the configured limit");
    }
  };
  const reserveSerialized = (amount: number): void => {
    serializedBytes += amount;
    if (serializedBytes > availableMetadataBytes) {
      invalid(path, "metadata bytes exceed the configured limit");
    }
  };

  if (serializedBytes > availableMetadataBytes) {
    invalid(path, "metadata bytes exceed the configured limit");
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      reserveRaw(1);
      reserveSerialized(2);
    } else if (codeUnit === 0x08 || codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0c || codeUnit === 0x0d) {
      reserveRaw(1);
      reserveSerialized(2);
    } else if (codeUnit <= 0x1f) {
      reserveRaw(1);
      reserveSerialized(6);
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        reserveRaw(4);
        reserveSerialized(4);
        index += 1;
      } else {
        // JSON.stringify's well-formed JSON behavior escapes lone surrogates.
        reserveRaw(3);
        reserveSerialized(6);
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      // TextEncoder encodes a lone surrogate as U+FFFD; JSON.stringify escapes it.
      reserveRaw(3);
      reserveSerialized(6);
    } else if (codeUnit <= 0x7f) {
      reserveRaw(1);
      reserveSerialized(1);
    } else if (codeUnit <= 0x7ff) {
      reserveRaw(2);
      reserveSerialized(2);
    } else {
      reserveRaw(3);
      reserveSerialized(3);
    }
  }
  return serializedBytes;
}

/**
 * Rejects non-JSON values and measures the canonical JSON envelope without
 * creating that full envelope. Object properties set to undefined retain
 * JSON.stringify omission semantics; undefined array entries are rejected.
 */
function validateJsonEnvelope(value: unknown): void {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();

  const reserve = (amount: number, path: string): void => {
    bytes += amount;
    if (bytes > CALIBRATION_HARNESS_LIMITS.maxMetadataBytes) {
      invalid(path, "metadata bytes exceed the configured limit");
    }
  };

  const visit = (entry: unknown, path: string, depth: number): void => {
    if (depth > CALIBRATION_HARNESS_LIMITS.maxDepth) {
      invalid(path, "metadata depth exceeds the configured limit");
    }
    nodes += 1;
    if (nodes > CALIBRATION_HARNESS_LIMITS.maxNodes) {
      invalid(path, "metadata node count exceeds the configured limit");
    }

    if (entry === null) {
      reserve(4, path);
      return;
    }
    switch (typeof entry) {
      case "boolean":
        reserve(entry ? 4 : 5, path);
        return;
      case "string":
        reserve(
          serializedStringBytes(entry, path, CALIBRATION_HARNESS_LIMITS.maxMetadataBytes - bytes),
          path
        );
        return;
      case "number": {
        if (!Number.isFinite(entry)) {
          invalid(path, "numbers must be finite JSON numbers");
        }
        reserve(textEncoder.encode(JSON.stringify(entry)).byteLength, path);
        return;
      }
      case "undefined":
        invalid(path, "undefined is only permitted for object properties");
      case "object":
        break;
      default:
        invalid(path, "must be JSON-representable");
    }

    if (ancestors.has(entry)) {
      invalid(path, "must not contain cycles");
    }
    ancestors.add(entry);
    try {
      if (Array.isArray(entry)) {
        if (Object.getPrototypeOf(entry) !== Array.prototype) {
          invalid(path, "must be an ordinary data array");
        }
        if (Object.getOwnPropertySymbols(entry).length > 0) {
          invalid(path, "must not contain symbol properties");
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(entry, "length");
        if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
          invalid(path, "array length must be a data property");
        }
        const length = lengthDescriptor.value;
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
          invalid(path, "array length must be a safe integer");
        }
        if (length > CALIBRATION_HARNESS_LIMITS.maxUnknownArrayLength) {
          invalid(path, "array length exceeds the configured limit");
        }
        for (const name of Object.getOwnPropertyNames(entry)) {
          if (name === "length") {
            continue;
          }
          const index = Number(name);
          const descriptor = Object.getOwnPropertyDescriptor(entry, name);
          if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            !descriptor.enumerable ||
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= length ||
            String(index) !== name
          ) {
            invalid(`${path}[${name}]`, "must be an enumerable data array index");
          }
        }
        reserve(2 + Math.max(0, length - 1), path);
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
          if (descriptor === undefined) {
            invalid(`${path}[${index}]`, "sparse arrays are not accepted");
          }
          if (!("value" in descriptor) || !descriptor.enumerable) {
            invalid(`${path}[${index}]`, "must be an enumerable data property");
          }
          visit(descriptor.value, `${path}[${index}]`, depth + 1);
        }
        return;
      }

      if (!isPlainJsonObject(entry)) {
        invalid(path, "must be a plain JSON object");
      }
      if (Object.getOwnPropertySymbols(entry).length > 0) {
        invalid(path, "must not contain symbol properties");
      }
      const propertyNames = Object.getOwnPropertyNames(entry);
      if (propertyNames.length > CALIBRATION_HARNESS_LIMITS.maxObjectProperties) {
        invalid(path, "object property count exceeds the configured limit");
      }
      reserve(2, path);
      let included = 0;
      for (const key of propertyNames) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          invalid(`${path}.${key}`, "must be a data property, not an accessor");
        }
        if (!descriptor.enumerable) {
          invalid(`${path}.${key}`, "must be an enumerable data property");
        }
        const property = descriptor.value;
        if (property === undefined) {
          continue;
        }
        if (included > 0) {
          reserve(1, path);
        }
        reserve(
          serializedStringBytes(
            key,
            `${path}.${key}`,
            CALIBRATION_HARNESS_LIMITS.maxMetadataBytes - bytes - 1
          ) + 1,
          `${path}.${key}`
        );
        visit(property, `${path}.${key}`, depth + 1);
        included += 1;
      }
    } finally {
      ancestors.delete(entry);
    }
  };

  visit(value, "$", 0);
}

function requireRecord(value: unknown, path: string): JsonRecord {
  if (!isPlainJsonObject(value)) {
    invalid(path, "must be an object");
  }
  return value;
}

function requireArray(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) {
    invalid(path, "must be an array");
  }
  if (value.length > maximum) {
    invalid(path, "array length exceeds the configured limit");
  }
  return value;
}

function requireString(record: JsonRecord, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    invalid(`${path}.${key}`, "must be a string");
  }
  return value;
}

function requireIdentifier(record: JsonRecord, key: string, path: string): string {
  const value = requireString(record, key, path);
  if (value.length === 0) {
    invalid(`${path}.${key}`, "must not be empty");
  }
  return value;
}

function optionalString(record: JsonRecord, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    invalid(`${path}.${key}`, "must be a string when present");
  }
  return value;
}

function requireSafeInteger(
  record: JsonRecord,
  key: string,
  path: string,
  minimum = Number.MIN_SAFE_INTEGER
): number {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    invalid(`${path}.${key}`, `must be a safe integer${minimum === 0 ? " at least zero" : ""}`);
  }
  return value;
}

function requireFiniteNumber(record: JsonRecord, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${path}.${key}`, "must be a finite number");
  }
  return value;
}

function validateOptionalStrings(record: JsonRecord, keys: string[], path: string): void {
  for (const key of keys) {
    optionalString(record, key, path);
  }
}

function validateScoreMap(value: unknown, path: string): void {
  const map = requireRecord(value, path);
  for (const [identifier, score] of Object.entries(map)) {
    if (identifier.length === 0) {
      invalid(`${path}.${identifier}`, "identifier keys must not be empty");
    }
    if (score !== null && (typeof score !== "number" || !Number.isFinite(score))) {
      invalid(`${path}.${identifier}`, "scores must be finite numbers or null");
    }
  }
}

function validateDataset(value: unknown, path: string): string {
  const record = requireRecord(value, path);
  const id = requireIdentifier(record, "id", path);
  requireString(record, "name", path);
  optionalString(record, "description", path);
  requireSafeInteger(record, "targetCaseCount", path, 0);
  requireSafeInteger(record, "createdAt", path);
  requireSafeInteger(record, "updatedAt", path);
  requireSafeInteger(record, "version", path, 0);
  return id;
}

function validateCandidate(value: unknown, path: string): string {
  const candidate = requireRecord(value, path);
  const identifier = requireIdentifier(candidate, "identifier", path);
  for (const key of [
    "name",
    "rawName",
    "smallThumbnailUrl",
    "mediumThumbnailUrl",
    "imageUrl",
    "sourceName",
    "source",
    "extension",
  ]) {
    requireString(candidate, key, path);
  }
  requireSafeInteger(candidate, "dpi", path, 0);
  requireSafeInteger(candidate, "size", path, 0);
  const tags = requireArray(candidate.tags, `${path}.tags`, CALIBRATION_HARNESS_LIMITS.maxUnknownArrayLength);
  for (let index = 0; index < tags.length; index += 1) {
    if (typeof tags[index] !== "string") {
      invalid(`${path}.tags[${index}]`, "must be a string");
    }
  }
  return identifier;
}

function validateCase(value: unknown, path: string): { id: string; datasetId: string; candidates: Set<string> } {
  const calibrationCase = requireRecord(value, path);
  const id = requireIdentifier(calibrationCase, "id", path);
  const datasetId = requireIdentifier(calibrationCase, "datasetId", path);
  requireSafeInteger(calibrationCase, "createdAt", path);
  requireSafeInteger(calibrationCase, "updatedAt", path);
  const source = requireRecord(calibrationCase.source, `${path}.source`);
  requireString(source, "name", `${path}.source`);
  validateOptionalStrings(
    source,
    ["cardUuid", "projectId", "imageId", "set", "collectorNumber", "sourceImageUrl", "sourceArtImageUrl"],
    `${path}.source`
  );
  const candidates = requireArray(
    calibrationCase.candidates,
    `${path}.candidates`,
    CALIBRATION_HARNESS_LIMITS.maxCandidatesPerCase
  );
  const candidateIdentifiers = new Set<string>();
  for (let index = 0; index < candidates.length; index += 1) {
    const identifier = validateCandidate(candidates[index], `${path}.candidates[${index}]`);
    if (candidateIdentifiers.has(identifier)) {
      invalid(`${path}.candidates[${index}].identifier`, "duplicate candidate identifier");
    }
    candidateIdentifiers.add(identifier);
  }
  const expectedIdentifier = optionalString(calibrationCase, "expectedIdentifier", path);
  if (expectedIdentifier !== undefined && !candidateIdentifiers.has(expectedIdentifier)) {
    invalid(`${path}.expectedIdentifier`, "must identify a candidate in the same case");
  }
  optionalString(calibrationCase, "notes", path);
  if (calibrationCase.comparisonHints !== undefined) {
    const hints = requireRecord(calibrationCase.comparisonHints, `${path}.comparisonHints`);
    if (hints.fullCard !== undefined) {
      validateScoreMap(hints.fullCard, `${path}.comparisonHints.fullCard`);
    }
    if (hints.artMatch !== undefined) {
      validateScoreMap(hints.artMatch, `${path}.comparisonHints.artMatch`);
    }
  }
  return { id, datasetId, candidates: candidateIdentifiers };
}

function validateAsset(value: unknown, path: string): {
  id: string;
  datasetId: string;
  caseId: string;
  role: CalibrationHarnessAssetRole;
  candidateIdentifier?: string;
} {
  const asset = requireRecord(value, path);
  for (const forbidden of ["blob", "data", "base64"]) {
    if (asset[forbidden] !== undefined) {
      invalid(`${path}.${forbidden}`, "embedded asset payloads are not allowed");
    }
  }
  const id = requireIdentifier(asset, "id", path);
  const datasetId = requireIdentifier(asset, "datasetId", path);
  const caseId = requireIdentifier(asset, "caseId", path);
  const role = requireString(asset, "role", path);
  if (role !== "source" && role !== "source-art" && role !== "candidate-small") {
    invalid(`${path}.role`, "must be source, source-art, or candidate-small");
  }
  const candidateIdentifier = optionalString(asset, "candidateIdentifier", path);
  if (role === "candidate-small" && candidateIdentifier === undefined) {
    invalid(`${path}.candidateIdentifier`, "is required for candidate-small assets");
  }
  optionalString(asset, "sourceUrl", path);
  requireString(asset, "mimeType", path);
  requireSafeInteger(asset, "createdAt", path);
  optionalString(asset, "hash", path);
  const sha256 = requireString(asset, "sha256", path);
  if (!SHA256_PATTERN.test(sha256)) {
    invalid(`${path}.sha256`, "must be a lowercase 64-character hexadecimal sha256");
  }
  requireSafeInteger(asset, "byteLength", path, 0);
  if ((asset.byteLength as number) > CALIBRATION_HARNESS_LIMITS.maxAssetBytes) {
    invalid(`${path}.byteLength`, "exceeds the configured asset byte limit");
  }
  return { id, datasetId, caseId, role, candidateIdentifier };
}

function validateRunResult(value: unknown, path: string): string {
  const result = requireRecord(value, path);
  const caseId = requireIdentifier(result, "caseId", path);
  optionalString(result, "expectedIdentifier", path);
  optionalString(result, "predictedIdentifier", path);
  if (typeof result.matched !== "boolean") {
    invalid(`${path}.matched`, "must be a boolean");
  }
  validateOptionalStrings(
    result,
    ["selectedReason", "fullProcessIdentifier", "artMatchIdentifier", "exactPrintingIdentifier", "fullCardIdentifier"],
    path
  );
  return caseId;
}

function validateRun(value: unknown, path: string): { id: string; datasetId: string; resultCaseIds: string[] } {
  const run = requireRecord(value, path);
  const id = requireIdentifier(run, "id", path);
  const datasetId = requireIdentifier(run, "datasetId", path);
  requireIdentifier(run, "algorithmId", path);
  optionalString(run, "algorithmLabel", path);
  requireSafeInteger(run, "createdAt", path);
  const summary = requireRecord(run.summary, `${path}.summary`);
  requireSafeInteger(summary, "totalCases", `${path}.summary`, 0);
  requireSafeInteger(summary, "matchedCases", `${path}.summary`, 0);
  requireSafeInteger(summary, "mismatchedCases", `${path}.summary`, 0);
  requireFiniteNumber(summary, "accuracy", `${path}.summary`);
  const results = requireArray(
    run.results,
    `${path}.results`,
    CALIBRATION_HARNESS_LIMITS.maxResultsPerRun
  );
  const resultCaseIds: string[] = [];
  for (let index = 0; index < results.length; index += 1) {
    resultCaseIds.push(validateRunResult(results[index], `${path}.results[${index}]`));
  }
  return { id, datasetId, resultCaseIds };
}

/**
 * Validates a complete metadata envelope without cloning, sorting, truncating,
 * or otherwise normalizing it. The returned reference is the input metadata.
 */
export function validateCalibrationHarnessSnapshot(
  value: unknown
): CalibrationHarnessSnapshot {
  validateJsonEnvelope(value);
  const snapshot = requireRecord(value, "$");
  if (snapshot.version !== CALIBRATION_HARNESS_FORMAT_VERSION) {
    invalid("$.version", `must equal ${CALIBRATION_HARNESS_FORMAT_VERSION}`);
  }

  const datasets = requireArray(snapshot.datasets, "$.datasets", CALIBRATION_HARNESS_LIMITS.maxDatasets);
  const datasetIds = new Set<string>();
  for (let index = 0; index < datasets.length; index += 1) {
    const id = validateDataset(datasets[index], `$.datasets[${index}]`);
    if (datasetIds.has(id)) {
      invalid(`$.datasets[${index}].id`, "duplicate dataset id");
    }
    datasetIds.add(id);
  }

  const cases = requireArray(snapshot.cases, "$.cases", CALIBRATION_HARNESS_LIMITS.maxCases);
  const casesById = new Map<string, { datasetId: string; candidates: Set<string> }>();
  for (let index = 0; index < cases.length; index += 1) {
    const calibrationCase = validateCase(cases[index], `$.cases[${index}]`);
    if (casesById.has(calibrationCase.id)) {
      invalid(`$.cases[${index}].id`, "duplicate case id");
    }
    if (!datasetIds.has(calibrationCase.datasetId)) {
      invalid(`$.cases[${index}].datasetId`, "must reference an existing dataset");
    }
    casesById.set(calibrationCase.id, calibrationCase);
  }

  const assets = requireArray(snapshot.assets, "$.assets", CALIBRATION_HARNESS_LIMITS.maxAssets);
  const assetIds = new Set<string>();
  const assetSlots = new Set<string>();
  for (let index = 0; index < assets.length; index += 1) {
    const asset = validateAsset(assets[index], `$.assets[${index}]`);
    if (assetIds.has(asset.id)) {
      invalid(`$.assets[${index}].id`, "duplicate asset id");
    }
    assetIds.add(asset.id);
    const calibrationCase = casesById.get(asset.caseId);
    if (calibrationCase === undefined) {
      invalid(`$.assets[${index}].caseId`, "must reference an existing case");
    }
    if (asset.datasetId !== calibrationCase.datasetId) {
      invalid(`$.assets[${index}].datasetId`, "must match the asset case dataset");
    }
    if (asset.role === "candidate-small" && !calibrationCase.candidates.has(asset.candidateIdentifier as string)) {
      invalid(`$.assets[${index}].candidateIdentifier`, "must identify a candidate in the asset case");
    }
    const slot = JSON.stringify([asset.caseId, asset.role, asset.candidateIdentifier]);
    if (assetSlots.has(slot)) {
      invalid(`$.assets[${index}]`, "duplicate asset slot");
    }
    assetSlots.add(slot);
  }

  const runs = requireArray(snapshot.runs, "$.runs", CALIBRATION_HARNESS_LIMITS.maxRuns);
  const runIds = new Set<string>();
  for (let index = 0; index < runs.length; index += 1) {
    const run = validateRun(runs[index], `$.runs[${index}]`);
    if (runIds.has(run.id)) {
      invalid(`$.runs[${index}].id`, "duplicate run id");
    }
    runIds.add(run.id);
    if (!datasetIds.has(run.datasetId)) {
      invalid(`$.runs[${index}].datasetId`, "must reference an existing dataset");
    }
    for (let resultIndex = 0; resultIndex < run.resultCaseIds.length; resultIndex += 1) {
      const currentCase = casesById.get(run.resultCaseIds[resultIndex]);
      if (currentCase !== undefined && currentCase.datasetId !== run.datasetId) {
        invalid(
          `$.runs[${index}].results[${resultIndex}].caseId`,
          "must match the run dataset when the case is current"
        );
      }
    }
  }

  return value as CalibrationHarnessSnapshot;
}
