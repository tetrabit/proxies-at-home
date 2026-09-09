import type { MpcCalibrationCaseRecord } from "@/db";
import type { MpcPreferenceModel } from "./mpcPreferenceModel";
import type { MpcSourceVisualProfile } from "./mpcVisualPreference";

/**
 * Every value that can change the prepared preference context must be supplied
 * as full content plus an explicit version. Do not use object identity, a
 * timestamp alone, or a sampled digest: callers own the complete fingerprints.
 */
export type MpcPreferenceContextVersion = string | number;

export interface MpcPreferenceContextKeyInput {
  datasetContent: string;
  datasetVersion: MpcPreferenceContextVersion;
  sourceContent: string;
  sourceVersion: MpcPreferenceContextVersion;
  providerContent: string;
  providerVersion: MpcPreferenceContextVersion;
  algorithmContent: string;
  algorithmVersion: MpcPreferenceContextVersion;
}

/**
 * The reusable result produced by MPC preference preparation.
 *
 * This shape describes the shared model/profile context used by the MPC
 * pipelines.
 */
export interface MpcPreferenceContext {
  readonly calibrationCases: readonly MpcCalibrationCaseRecord[];
  readonly model: Readonly<MpcPreferenceModel> | null;
  readonly profiles: Readonly<Record<string, Readonly<MpcSourceVisualProfile>>>;
}

export type BuildMpcPreferenceContext<T extends object = MpcPreferenceContext> =
  () => Promise<T> | T;

const CONTEXT_KEY_FIELDS = [
  "datasetContent",
  "datasetVersion",
  "sourceContent",
  "sourceVersion",
  "providerContent",
  "providerVersion",
  "algorithmContent",
  "algorithmVersion",
] as const;

/** Retain only a small LRU of settled contexts; in-flight work is never evicted. */
export const MAX_RETAINED_MPC_PREFERENCE_CONTEXTS = 4;

type ContextEntry<T extends object> = {
  promise: Promise<T>;
  context?: T;
};

const contextsByKey = new Map<string, ContextEntry<object>>();

/**
 * Serializes all key fields with lengths so distinct content cannot collide
 * through delimiters. This deliberately does not inspect object identity or
 * sample large values; callers provide the full content fingerprints.
 */
export function createMpcPreferenceContextKey(
  input: MpcPreferenceContextKeyInput
): string {
  return CONTEXT_KEY_FIELDS.map((field) => {
    const value = input[field];
    if (
      (typeof value !== "string" && typeof value !== "number") ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      throw new TypeError(
        `MPC preference context key field ${field} must be a finite string or number`
      );
    }
    const serialized = String(value);
    return `${field}:${typeof value}:${serialized.length}:${serialized}`;
  }).join("|");
}

function freezeContext<T extends object>(context: T): T {
  const seen = new WeakSet<object>();

  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);

    for (const key of Reflect.ownKeys(value)) {
      freeze(Reflect.get(value, key));
    }
    Object.freeze(value);
  };

  freeze(context);
  return context;
}

function removeContextEntry(key: string, entry: ContextEntry<object>): void {
  // A late failure from a stale build must not delete a retry entry.
  if (contextsByKey.get(key) === entry) {
    contextsByKey.delete(key);
  }
}

function touchContextEntry(key: string, entry: ContextEntry<object>): void {
  if (contextsByKey.get(key) !== entry) return;
  contextsByKey.delete(key);
  contextsByKey.set(key, entry);
}

function evictLeastRecentlyUsedSettledContexts(): void {
  let retainedCount = 0;
  for (const entry of contextsByKey.values()) {
    if (entry.context) retainedCount += 1;
  }

  for (const [key, entry] of contextsByKey) {
    if (retainedCount <= MAX_RETAINED_MPC_PREFERENCE_CONTEXTS) return;
    if (!entry.context) continue;
    contextsByKey.delete(key);
    retainedCount -= 1;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function subscribeToContext<T extends object>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      settle(() =>
        reject(signal ? abortReason(signal) : new DOMException("The operation was aborted", "AbortError"))
      );

    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (context) => settle(() => resolve(context)),
      (error) => settle(() => reject(error))
    );
  });
}

/**
 * Returns an immutable prepared context for a complete version/content key.
 * Subscriber cancellation only rejects that subscriber; it never cancels the
 * shared build, which may still serve other subscribers or the bounded cache.
 */
export function getMpcPreferenceContext<T extends object = MpcPreferenceContext>(
  input: MpcPreferenceContextKeyInput,
  build: BuildMpcPreferenceContext<T>,
  signal?: AbortSignal
): Promise<T> {
  // Do not create an unobservable cache entry for a request that cannot use it.
  // This must precede both key construction and cache lookup/build admission.
  if (signal?.aborted) {
    return Promise.reject(abortReason(signal));
  }

  const key = createMpcPreferenceContextKey(input);
  let entry = contextsByKey.get(key) as ContextEntry<T> | undefined;

  if (!entry) {
    let buildResult: Promise<T> | T;
    try {
      buildResult = build();
    } catch (error) {
      buildResult = Promise.reject(error);
    }
    const created: ContextEntry<T> = {
      promise: Promise.resolve(buildResult).then(freezeContext),
    };
    entry = created;
    contextsByKey.set(key, created as ContextEntry<object>);

    void created.promise.then(
      (context) => {
        if (contextsByKey.get(key) !== created) return;
        created.context = context;
        touchContextEntry(key, created as ContextEntry<object>);
        evictLeastRecentlyUsedSettledContexts();
      },
      () => removeContextEntry(key, created as ContextEntry<object>)
    );
  } else {
    touchContextEntry(key, entry as ContextEntry<object>);
  }

  return subscribeToContext(entry.promise, signal);
}

/** Test-only reset so isolated Vitest files do not retain frozen contexts. */
export function resetMpcPreferenceContextCacheForTests(): void {
  contextsByKey.clear();
}
