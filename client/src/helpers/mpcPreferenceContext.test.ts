import { describe, expect, it, vi } from "vitest";
import {
  createMpcPreferenceContextKey,
  getMpcPreferenceContext,
  resetMpcPreferenceContextCacheForTests,
} from "./mpcPreferenceContext";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const preferenceInput = {
  datasetContent: "dataset-content-v1",
  datasetVersion: "1",
  sourceContent: "source-content-v1",
  sourceVersion: "1",
  providerContent: "provider-content-v1",
  providerVersion: "1",
  algorithmContent: "algorithm-content-v1",
  algorithmVersion: "1",
};

const preferenceKey = createMpcPreferenceContextKey(preferenceInput);

describe("mpcPreferenceContext", () => {
  it("coalesces concurrent equivalent context builds into one immutable context", async () => {
    resetMpcPreferenceContextCacheForTests();
    const pending = deferred<{ nested: { value: number } }>();
    const build = vi.fn(() => pending.promise);

    const first = getMpcPreferenceContext(preferenceInput, build);
    const second = getMpcPreferenceContext(preferenceInput, build);

    expect(build).toHaveBeenCalledTimes(1);
    pending.resolve({ nested: { value: 1 } });

    const [firstContext, secondContext] = await Promise.all([first, second]);
    expect(firstContext).toBe(secondContext);
    expect(Object.isFrozen(firstContext)).toBe(true);
    expect(Object.isFrozen(firstContext.nested)).toBe(true);
  });

  it.each([
    ["dataset content", { ...preferenceInput, datasetContent: "dataset-content-v2" }],
    ["dataset version", { ...preferenceInput, datasetVersion: "2" }],
    ["source content", { ...preferenceInput, sourceContent: "source-content-v2" }],
    ["source version", { ...preferenceInput, sourceVersion: "2" }],
    ["provider content", { ...preferenceInput, providerContent: "provider-content-v2" }],
    ["provider version", { ...preferenceInput, providerVersion: "2" }],
    ["algorithm content", { ...preferenceInput, algorithmContent: "algorithm-content-v2" }],
    ["algorithm version", { ...preferenceInput, algorithmVersion: "2" }],
  ])("does not reuse a context when %s changes", async (_field, changedInput) => {
    resetMpcPreferenceContextCacheForTests();
    const firstBuild = vi.fn(async () => ({ build: "first" }));
    const secondBuild = vi.fn(async () => ({ build: "second" }));

    const first = await getMpcPreferenceContext(preferenceInput, firstBuild);
    const same = await getMpcPreferenceContext({ ...preferenceInput }, secondBuild);
    const changed = await getMpcPreferenceContext(changedInput, secondBuild);

    expect(same).toBe(first);
    expect(changed).not.toBe(first);
    expect(firstBuild).toHaveBeenCalledTimes(1);
    expect(secondBuild).toHaveBeenCalledTimes(1);
  });

  it("accepts persisted numeric versions without converting them through object identity", () => {
    const numericVersionKey = createMpcPreferenceContextKey({
      datasetContent: "dataset-content-v1",
      datasetVersion: 1,
      sourceContent: "source-content-v1",
      sourceVersion: 1,
      providerContent: "provider-content-v1",
      providerVersion: 1,
      algorithmContent: "algorithm-content-v1",
      algorithmVersion: 1,
    });

    expect(numericVersionKey).not.toBe(preferenceKey);
  });

  it("rejects only an aborted subscriber while the shared context completes", async () => {
    resetMpcPreferenceContextCacheForTests();
    const pending = deferred<{ built: true }>();
    const build = vi.fn(() => pending.promise);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const reason = new DOMException("first subscriber stopped", "AbortError");

    const first = getMpcPreferenceContext(preferenceInput, build, firstController.signal);
    const second = getMpcPreferenceContext(preferenceInput, build, secondController.signal);
    firstController.abort(reason);
    pending.resolve({ built: true });

    await expect(first).rejects.toBe(reason);
    await expect(second).resolves.toEqual({ built: true });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("removes a failed build so a later request can retry", async () => {
    resetMpcPreferenceContextCacheForTests();
    const failure = new Error("profile build failed");
    const build = vi
      .fn<() => Promise<{ attempt: number }>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ attempt: 2 });

    await expect(getMpcPreferenceContext(preferenceInput, build)).rejects.toBe(
      failure
    );
    await expect(getMpcPreferenceContext(preferenceInput, build)).resolves.toEqual({
      attempt: 2,
    });
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("does not admit pre-aborted requests and allows a later request to build", async () => {
    resetMpcPreferenceContextCacheForTests();
    const controller = new AbortController();
    const reason = new DOMException("request already stopped", "AbortError");
    const skippedBuild = vi.fn(async () => ({ attempt: "skipped" }));
    const retryBuild = vi.fn(async () => ({ attempt: "retry" }));
    controller.abort(reason);

    await expect(
      getMpcPreferenceContext(preferenceInput, skippedBuild, controller.signal)
    ).rejects.toBe(reason);
    expect(skippedBuild).not.toHaveBeenCalled();

    await expect(getMpcPreferenceContext(preferenceInput, retryBuild)).resolves.toEqual({
      attempt: "retry",
    });
    expect(retryBuild).toHaveBeenCalledTimes(1);
  });

  it("retains a hot key and evicts the true least recently used settled key", async () => {
    resetMpcPreferenceContextCacheForTests();
    const builds = Array.from({ length: 5 }, () =>
      vi.fn(async () => ({ context: crypto.randomUUID() }))
    );
    const keys = builds.map((_, index) =>
      ({
        datasetContent: `dataset-${index}`,
        datasetVersion: "1",
        sourceContent: "source-content-v1",
        sourceVersion: "1",
        providerContent: "provider-content-v1",
        providerVersion: "1",
        algorithmContent: "algorithm-content-v1",
        algorithmVersion: "1",
      })
    );

    for (let index = 0; index < keys.length - 1; index += 1) {
      await getMpcPreferenceContext(keys[index]!, builds[index]!);
    }
    await getMpcPreferenceContext(keys[0]!, builds[0]!);
    await getMpcPreferenceContext(keys[4]!, builds[4]!);
    await getMpcPreferenceContext(keys[0]!, builds[0]!);
    await getMpcPreferenceContext(keys[1]!, builds[1]!);

    expect(builds[0]).toHaveBeenCalledTimes(1);
    expect(builds[1]).toHaveBeenCalledTimes(2);
    expect(builds.slice(2).every((build) => build.mock.calls.length === 1)).toBe(true);
  });
});
