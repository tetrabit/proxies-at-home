import type { MpcPreferenceCandidate } from "./types";

export const MPC_PREFERENCE_FIXTURE_VERSION = 1;

type JsonRecord = Record<string, unknown>;

export interface PromotedMpcPreferenceCase {
  name: string;
  expectedIdentifier?: string;
  candidates: MpcPreferenceCandidate[];
}

export interface PromotedMpcPreferenceFixture {
  cases: PromotedMpcPreferenceCase[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function validateCandidate(candidate: unknown): MpcPreferenceCandidate {
  if (!isRecord(candidate)) {
    throw new Error("Invalid preference fixture: candidate must be an object");
  }

  if (
    typeof candidate.identifier !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.rawName !== "string" ||
    typeof candidate.smallThumbnailUrl !== "string" ||
    typeof candidate.mediumThumbnailUrl !== "string" ||
    !isOptionalString(candidate.imageUrl) ||
    typeof candidate.dpi !== "number" ||
    !Array.isArray(candidate.tags) ||
    !candidate.tags.every((tag) => typeof tag === "string") ||
    typeof candidate.sourceName !== "string" ||
    typeof candidate.source !== "string" ||
    typeof candidate.extension !== "string" ||
    typeof candidate.size !== "number"
  ) {
    throw new Error("Invalid preference fixture: malformed candidate");
  }

  return {
    identifier: candidate.identifier,
    name: candidate.name,
    rawName: candidate.rawName,
    smallThumbnailUrl: candidate.smallThumbnailUrl,
    mediumThumbnailUrl: candidate.mediumThumbnailUrl,
    ...(candidate.imageUrl !== undefined ? { imageUrl: candidate.imageUrl } : {}),
    dpi: candidate.dpi,
    tags: [...candidate.tags],
    sourceName: candidate.sourceName,
    source: candidate.source,
    extension: candidate.extension,
    size: candidate.size,
  };
}

function validateVersionedCase(testCase: unknown): PromotedMpcPreferenceCase {
  if (!isRecord(testCase) || !isRecord(testCase.source)) {
    throw new Error("Invalid preference fixture: malformed source card");
  }

  const { source, candidates, expectedIdentifier } = testCase;
  if (
    typeof source.name !== "string" ||
    !isOptionalString(source.set) ||
    !isOptionalString(source.collectorNumber) ||
    !isOptionalString(source.sourceImageUrl) ||
    !isOptionalString(source.sourceArtImageUrl)
  ) {
    throw new Error("Invalid preference fixture: malformed source card");
  }

  return validatePromotedCase(source.name, candidates, expectedIdentifier);
}

function validateLegacyCase(testCase: unknown): PromotedMpcPreferenceCase {
  if (!isRecord(testCase) || typeof testCase.name !== "string") {
    throw new Error("Invalid preference fixture: malformed case");
  }

  return validatePromotedCase(
    testCase.name,
    testCase.candidates,
    testCase.expectedIdentifier
  );
}

function validatePromotedCase(
  name: string,
  candidates: unknown,
  expectedIdentifier: unknown
): PromotedMpcPreferenceCase {
  if (!Array.isArray(candidates)) {
    throw new Error("Invalid preference fixture: candidates must be an array");
  }

  if (!isOptionalString(expectedIdentifier)) {
    throw new Error("Invalid preference fixture: malformed case metadata");
  }

  return {
    name,
    ...(expectedIdentifier !== undefined ? { expectedIdentifier } : {}),
    candidates: candidates.map(validateCandidate),
  };
}

/**
 * Validates both the historical promotion fixture and the current versioned
 * preference fixture, returning the stable fixture shape consumed by bootstrap.
 * This module deliberately has no browser or Node runtime dependencies.
 */
export function parseMpcPreferenceFixtureForPromotion(
  data: unknown
): PromotedMpcPreferenceFixture {
  if (!isRecord(data)) {
    throw new Error("Invalid preference fixture: not a JSON object");
  }

  if (!Array.isArray(data.cases)) {
    throw new Error("Invalid preference fixture: missing cases array");
  }

  const isVersioned = data.version !== undefined || data.exportedAt !== undefined;
  if (!isVersioned) {
    return { cases: data.cases.map(validateLegacyCase) };
  }

  if (typeof data.version !== "number") {
    throw new Error("Invalid preference fixture: missing version");
  }

  if (data.version !== MPC_PREFERENCE_FIXTURE_VERSION) {
    throw new Error(`Unsupported preference fixture version: ${data.version}`);
  }

  if (typeof data.exportedAt !== "string") {
    throw new Error("Invalid preference fixture: missing exportedAt");
  }

  return { cases: data.cases.map(validateVersionedCase) };
}
