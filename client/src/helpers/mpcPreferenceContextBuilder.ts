import type { MpcCalibrationCaseRecord } from "@/db";
import {
  getMpcPreferenceContext,
  type MpcPreferenceContext,
  type MpcPreferenceContextKeyInput,
  type MpcPreferenceContextVersion,
} from "./mpcPreferenceContext";
export type { MpcPreferenceContext };
import {
  trainMpcPreferenceModel,
  type MpcPreferenceTrainingOptions,
} from "./mpcPreferenceModel";
import type { MpcHarvestedSourceExample } from "./mpcPreferenceBootstrap";
import { buildMpcSourceVisualProfiles } from "./mpcVisualPreference";

export interface MpcPreferenceContextDescriptor {
  /** Full stable content of this dependency's actual caller-supplied inputs. */
  readonly content: unknown;
  /** Explicit persisted or protocol version; callers must not invent a default. */
  readonly version: MpcPreferenceContextVersion;
}

export interface MpcPreferenceContextDatasetDescriptor
  extends MpcPreferenceContextDescriptor {
  readonly calibrationCases: readonly MpcCalibrationCaseRecord[];
}

export interface MpcPreferenceContextSourceDescriptor
  extends MpcPreferenceContextDescriptor {
  /**
   * Loads examples for the shared build. This deliberately has no subscriber
   * AbortSignal: closing one modal must not cancel a context other callers use.
   */
  readonly loadExamples: () =>
    | readonly MpcHarvestedSourceExample[]
    | Promise<readonly MpcHarvestedSourceExample[]>;
}

export interface MpcPreferenceContextAlgorithmDescriptor
  extends MpcPreferenceContextDescriptor {
  readonly trainingOptions: Readonly<MpcPreferenceTrainingOptions>;
}

/**
 * All cache-key material is explicit. Provider, source, and algorithm
 * descriptors are required so callers cannot silently reuse a context after a
 * transport, seed, or scoring change.
 */
export interface MpcPreferenceContextBuilderInput {
  readonly dataset: MpcPreferenceContextDatasetDescriptor;
  readonly source: MpcPreferenceContextSourceDescriptor;
  readonly provider: MpcPreferenceContextDescriptor;
  readonly algorithm: MpcPreferenceContextAlgorithmDescriptor;
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "undefined") return { $undefined: true };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])])
    );
  }
  throw new TypeError("MPC preference context descriptors must be JSON data");
}

function serializeCompleteInput(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Storage ids and timestamps are not preference inputs. Keep them out of the
 * key so import timing and generated record ids never fragment the cache.
 */
function projectCalibrationCases(
  calibrationCases: readonly MpcCalibrationCaseRecord[]
) {
  return calibrationCases.map(
    ({
      source,
      candidates,
      expectedIdentifier,
      notes,
      comparisonHints,
    }) => ({
      source,
      candidates,
      expectedIdentifier,
      notes,
      comparisonHints,
    })
  );
}

/** Exposed so every consumer constructs the same complete cache key. */
export function createMpcPreferenceContextBuilderKeyInput(
  input: MpcPreferenceContextBuilderInput
): MpcPreferenceContextKeyInput {
  return {
    datasetContent: serializeCompleteInput({
      descriptor: input.dataset.content,
      calibrationCases: projectCalibrationCases(input.dataset.calibrationCases),
    }),
    datasetVersion: input.dataset.version,
    sourceContent: serializeCompleteInput(input.source.content),
    sourceVersion: input.source.version,
    providerContent: serializeCompleteInput(input.provider.content),
    providerVersion: input.provider.version,
    algorithmContent: serializeCompleteInput({
      descriptor: input.algorithm.content,
      trainingOptions: input.algorithm.trainingOptions,
    }),
    algorithmVersion: input.algorithm.version,
  };
}

/**
 * Builds and caches the model/profile context from one complete descriptor.
 * The optional signal is a subscription lifetime only; the shared build keeps
 * running after any individual modal closes.
 */
export function getSharedMpcPreferenceContext(
  input: MpcPreferenceContextBuilderInput,
  signal?: AbortSignal
): Promise<MpcPreferenceContext> {
  return getMpcPreferenceContext(
    createMpcPreferenceContextBuilderKeyInput(input),
    async () => {
      const calibrationCases = Array.from(input.dataset.calibrationCases);
      const model = trainMpcPreferenceModel(
        calibrationCases,
        input.algorithm.trainingOptions
      );
      if (!model) {
        return { calibrationCases, model: null, profiles: {} };
      }

      const examples = Array.from(await input.source.loadExamples());
      const profiles = await buildMpcSourceVisualProfiles(examples);
      return { calibrationCases, model, profiles };
    },
    signal
  );
}
