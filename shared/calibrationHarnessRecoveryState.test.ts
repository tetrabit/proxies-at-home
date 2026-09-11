import { describe, expect, it } from "vitest";
import {
  CALIBRATION_HARNESS_RECOVERY_STATE_VERSION,
  convertCalibrationHarnessLocalStateToRecoveryState,
  validateCalibrationHarnessRecoveryState,
  type CalibrationHarnessRecoveryState,
} from "./calibrationHarnessRecoveryState";
import { mergeCalibrationHarnessSnapshots } from "./calibrationHarnessMerge";

const snapshot = { version: 1 as const, datasets: [], cases: [], assets: [], runs: [], retained: { exact: true } };
const legacy = {
  formatVersion: 1 as const,
  ownerId: "owner",
  harnessId: "harness",
  connectionId: "connection",
  base: { revision: 1, snapshot },
  queued: { generation: 2, snapshot: { ...snapshot, retained: { exact: "queued" } } },
  inFlight: { generation: 1, snapshot: { ...snapshot, retained: { exact: "sent" } }, expectedBaseRevision: 1 },
  lastAcknowledgement: null,
  dirtyGeneration: 2,
  sentGeneration: 1,
  acknowledgedGeneration: 0,
  updatedAt: 10,
};

describe("calibrationHarnessRecoveryState", () => {
  function observedSettlement(): CalibrationHarnessRecoveryState {
    const priorBase = { revision: 1, snapshot: { ...snapshot, retained: { exact: "base" } } };
    const priorQueued = { generation: 1, snapshot: { ...snapshot, retained: { exact: "sent" } } };
    const observed = { revision: 2, snapshot: structuredClone(priorQueued.snapshot) };
    return {
      formatVersion: CALIBRATION_HARNESS_RECOVERY_STATE_VERSION,
      ownerId: "owner",
      harnessId: "harness",
      connectionId: "connection",
      base: observed,
      queued: null,
      inFlight: null,
      lastAcknowledgement: null,
      settledGeneration: 1,
      lastRecovery: {
        kind: "observed-current-inflight" as const,
        priorBase,
        priorQueued,
        retiredInFlight: { ...priorQueued, expectedBaseRevision: 1 },
        observed,
        resultingQueued: null,
        settledGeneration: 1,
      },
      dirtyGeneration: 1,
      sentGeneration: 1,
      acknowledgedGeneration: 0,
      updatedAt: 10,
    };
  }

  it("converts a strict V1 row without mutating it and preserves unsettled provenance", () => {
    const before = structuredClone(legacy);
    const converted = convertCalibrationHarnessLocalStateToRecoveryState(legacy);

    expect(legacy).toEqual(before);
    expect(converted).toMatchObject({
      formatVersion: CALIBRATION_HARNESS_RECOVERY_STATE_VERSION,
      settledGeneration: 0,
      lastRecovery: null,
      base: legacy.base,
      queued: legacy.queued,
      inFlight: legacy.inFlight,
      dirtyGeneration: 2,
      sentGeneration: 1,
      acknowledgedGeneration: 0,
    });
    expect(converted).not.toBe(legacy);
    expect(validateCalibrationHarnessRecoveryState(converted)).toBe(converted);
  });

  it("rejects forged settlement or recovery proof wrappers without invoking accessors", () => {
    const converted = convertCalibrationHarnessLocalStateToRecoveryState(legacy) as unknown as Record<string, unknown>;
    converted.settledGeneration = 2;
    expect(() => validateCalibrationHarnessRecoveryState(converted)).toThrow(/settled/i);

    const accessor = convertCalibrationHarnessLocalStateToRecoveryState(legacy) as unknown as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(accessor, "lastRecovery", { enumerable: true, get() { reads += 1; return null; } });
    expect(() => validateCalibrationHarnessRecoveryState(accessor)).toThrow();
    expect(reads).toBe(0);
  });

  it("rejects an observed-inflight proof whose observed snapshot is not the retired sent snapshot", () => {
    const state = observedSettlement();
    state.lastRecovery!.observed = { revision: 2, snapshot: { ...snapshot, retained: { exact: "forged" } } };
    state.base = state.lastRecovery!.observed;

    expect(() => validateCalibrationHarnessRecoveryState(state)).toThrow(/observed-current-inflight/i);
  });

  it("rejects a retained proof observation beyond the installed base", () => {
    const state = observedSettlement();
    state.lastRecovery!.observed = { ...state.lastRecovery!.observed, revision: 3 };

    expect(() => validateCalibrationHarnessRecoveryState(state)).toThrow(/installed base/i);
  });

  it("rejects an observed-current-base proof whose prior base body differs at the same revision", () => {
    const state = observedSettlement();
    const resultingQueued = { generation: 2, snapshot: structuredClone(state.lastRecovery!.priorQueued.snapshot) };
    state.base = { revision: 1, snapshot: { ...snapshot, retained: { exact: "different" } } };
    state.queued = resultingQueued;
    state.dirtyGeneration = 2;
    state.lastRecovery = {
      ...state.lastRecovery!,
      kind: "observed-current-base",
      observed: structuredClone(state.base),
      resultingQueued,
    };

    expect(() => validateCalibrationHarnessRecoveryState(state)).toThrow(/observed-current-base/i);
  });

  it("rejects a proof that claims a resulting generation beyond the durable dirty counter", () => {
    const state = observedSettlement();
    const prior = state.lastRecovery!;
    state.base = prior.priorBase;
    state.queued = { generation: 2, snapshot: structuredClone(prior.priorQueued.snapshot) };
    state.dirtyGeneration = 2;
    state.lastRecovery = {
      ...prior,
      kind: "observed-current-base",
      observed: structuredClone(prior.priorBase),
      resultingQueued: { generation: 3, snapshot: structuredClone(prior.priorQueued.snapshot) },
    };

    expect(() => validateCalibrationHarnessRecoveryState(state)).toThrow(/future generation/i);
  });

  it("requires a merged recovery queue to equal the accepted three-way merge", () => {
    const priorBase = { revision: 1, snapshot: structuredClone(snapshot) };
    const priorQueued = { generation: 1, snapshot: { ...snapshot, localChange: { value: 1 } } };
    const observed = { revision: 2, snapshot: { ...snapshot, remoteChange: { value: 2 } } };
    const merged = mergeCalibrationHarnessSnapshots(priorBase.snapshot, priorQueued.snapshot, observed.snapshot);
    expect(merged.ok).toBe(true);
    if (!merged.ok) throw new Error("fixture must merge");
    const state: CalibrationHarnessRecoveryState = {
      formatVersion: CALIBRATION_HARNESS_RECOVERY_STATE_VERSION,
      ownerId: "owner",
      harnessId: "harness",
      connectionId: "connection",
      base: observed,
      queued: { generation: 2, snapshot: merged.snapshot },
      inFlight: null,
      lastAcknowledgement: null,
      settledGeneration: 1,
      lastRecovery: {
        kind: "merged",
        priorBase,
        priorQueued,
        retiredInFlight: { ...priorQueued, expectedBaseRevision: 1 },
        observed,
        resultingQueued: { generation: 2, snapshot: merged.snapshot },
        settledGeneration: 1,
      },
      dirtyGeneration: 2,
      sentGeneration: 1,
      acknowledgedGeneration: 0,
      updatedAt: 10,
    };
    expect(validateCalibrationHarnessRecoveryState(state)).toBe(state);

    state.lastRecovery!.resultingQueued = { generation: 2, snapshot: { ...merged.snapshot, forged: true } };
    expect(() => validateCalibrationHarnessRecoveryState(state)).toThrow(/merged recovery/i);
  });

  function observedInFlightWithPreservedG2(): CalibrationHarnessRecoveryState {
    const priorBase = { revision: 1, snapshot: { ...snapshot, retained: { exact: "base" } } };
    const sent = { generation: 1, snapshot: { ...snapshot, retained: { exact: "sent G1" } }, expectedBaseRevision: 1 };
    const preserved = { generation: 2, snapshot: { ...snapshot, retained: { exact: "desired G2" } } };
    const observed = { revision: 2, snapshot: structuredClone(sent.snapshot) };
    return {
      formatVersion: CALIBRATION_HARNESS_RECOVERY_STATE_VERSION,
      ownerId: "owner",
      harnessId: "harness",
      connectionId: "connection",
      base: observed,
      queued: structuredClone(preserved),
      inFlight: null,
      lastAcknowledgement: null,
      settledGeneration: 1,
      lastRecovery: {
        kind: "observed-current-inflight",
        priorBase,
        priorQueued: structuredClone(preserved),
        retiredInFlight: sent,
        observed,
        resultingQueued: structuredClone(preserved),
        settledGeneration: 1,
      },
      dirtyGeneration: 2,
      sentGeneration: 1,
      acknowledgedGeneration: 0,
      updatedAt: 10,
    };
  }

  it("rejects a current G2 queue whose body contradicts its retained observed-inflight result", () => {
    const state = observedInFlightWithPreservedG2();
    state.queued = { generation: 2, snapshot: { ...snapshot, retained: { exact: "forged G2" } } };

    expect(() => validateCalibrationHarnessRecoveryState(state)).toThrow(/resulting queue/i);
  });

  it("rejects a same-generation G1 queue whose body contradicts its inFlight publication", () => {
    const state = convertCalibrationHarnessLocalStateToRecoveryState(legacy);
    state.queued = { generation: 1, snapshot: { ...snapshot, retained: { exact: "forged G1" } } };
    state.dirtyGeneration = 1;

    expect(() => validateCalibrationHarnessRecoveryState(state)).toThrow(/inFlight snapshot/i);
  });

  it("requires observed-current-base recovery to create exactly the next generation", () => {
    const state = observedInFlightWithPreservedG2();
    const recovery = state.lastRecovery!;
    const skipped = { generation: 4, snapshot: structuredClone(recovery.priorQueued.snapshot) };
    state.base = structuredClone(recovery.priorBase);
    state.queued = skipped;
    state.dirtyGeneration = skipped.generation;
    state.lastRecovery = {
      ...recovery,
      kind: "observed-current-base",
      observed: structuredClone(recovery.priorBase),
      resultingQueued: structuredClone(skipped),
    };

    expect(() => validateCalibrationHarnessRecoveryState(state)).toThrow(/exactly the next generation/i);
  });

  it("requires merged recovery to create exactly the next generation", () => {
    const priorBase = { revision: 1, snapshot: structuredClone(snapshot) };
    const priorQueued = { generation: 1, snapshot: { ...snapshot, localChange: { value: 1 } } };
    const observed = { revision: 2, snapshot: { ...snapshot, remoteChange: { value: 2 } } };
    const merged = mergeCalibrationHarnessSnapshots(priorBase.snapshot, priorQueued.snapshot, observed.snapshot);
    expect(merged.ok).toBe(true);
    if (!merged.ok) throw new Error("fixture must merge");
    const skipped = { generation: 3, snapshot: merged.snapshot };
    const state: CalibrationHarnessRecoveryState = {
      formatVersion: CALIBRATION_HARNESS_RECOVERY_STATE_VERSION,
      ownerId: "owner", harnessId: "harness", connectionId: "connection",
      base: observed, queued: skipped, inFlight: null, lastAcknowledgement: null,
      settledGeneration: 1,
      lastRecovery: {
        kind: "merged", priorBase, priorQueued,
        retiredInFlight: { ...priorQueued, expectedBaseRevision: 1 }, observed,
        resultingQueued: skipped, settledGeneration: 1,
      },
      dirtyGeneration: 3, sentGeneration: 1, acknowledgedGeneration: 0, updatedAt: 10,
    };

    expect(() => validateCalibrationHarnessRecoveryState(state)).toThrow(/exactly the next generation/i);
  });

  it("accepts all recovery kinds and preserves historical proof after later queue or acknowledgement advancement", () => {
    const preserved = observedInFlightWithPreservedG2();
    expect(validateCalibrationHarnessRecoveryState(preserved)).toBe(preserved);

    const laterQueue = structuredClone(preserved);
    laterQueue.queued = { generation: 3, snapshot: { ...snapshot, retained: { exact: "later G3" } } };
    laterQueue.dirtyGeneration = 3;
    expect(validateCalibrationHarnessRecoveryState(laterQueue)).toBe(laterQueue);

    const acknowledged = structuredClone(preserved);
    acknowledged.base = { revision: 3, snapshot: structuredClone(acknowledged.queued!.snapshot) };
    acknowledged.queued = null;
    acknowledged.inFlight = null;
    acknowledged.sentGeneration = 2;
    acknowledged.settledGeneration = 2;
    acknowledged.acknowledgedGeneration = 2;
    acknowledged.lastAcknowledgement = {
      generation: 2,
      snapshot: structuredClone(acknowledged.base.snapshot),
      expectedBaseRevision: 2,
      base: structuredClone(acknowledged.base),
    };
    expect(validateCalibrationHarnessRecoveryState(acknowledged)).toBe(acknowledged);

    const observedBase = structuredClone(preserved);
    const recovery = observedBase.lastRecovery!;
    const replacement = { generation: 3, snapshot: structuredClone(recovery.priorQueued.snapshot) };
    observedBase.base = structuredClone(recovery.priorBase);
    observedBase.queued = replacement;
    observedBase.dirtyGeneration = replacement.generation;
    observedBase.lastRecovery = {
      ...recovery,
      kind: "observed-current-base",
      observed: structuredClone(recovery.priorBase),
      resultingQueued: structuredClone(replacement),
    };
    expect(validateCalibrationHarnessRecoveryState(observedBase)).toBe(observedBase);
  });

  it("binds every retired publication tuple to its proof", () => {
    const expectedBase = observedInFlightWithPreservedG2();
    expectedBase.lastRecovery!.retiredInFlight!.expectedBaseRevision = 2;
    expect(() => validateCalibrationHarnessRecoveryState(expectedBase)).toThrow(/expected base/i);

    const generation = observedInFlightWithPreservedG2();
    generation.lastRecovery!.retiredInFlight!.generation = 2;
    expect(() => validateCalibrationHarnessRecoveryState(generation)).toThrow(/settled generation/i);

    const payload = observedInFlightWithPreservedG2();
    payload.lastRecovery!.retiredInFlight!.snapshot = { ...snapshot, retained: { exact: "forged sent" } };
    expect(() => validateCalibrationHarnessRecoveryState(payload)).toThrow(/observed-current-inflight/i);
  });

  it("rejects unknown V2 versions and inert wrapper violations without calling getters", () => {
    const version = observedInFlightWithPreservedG2() as unknown as Record<string, unknown>;
    version.formatVersion = 3;
    expect(() => validateCalibrationHarnessRecoveryState(version)).toThrow(/formatVersion/i);

    for (const target of ["state", "proof", "queue", "inFlight"] as const) {
      const state = target === "inFlight"
        ? convertCalibrationHarnessLocalStateToRecoveryState(legacy)
        : observedInFlightWithPreservedG2();
      const wrapper = target === "state"
        ? state as unknown as Record<string, unknown>
        : target === "proof"
          ? state.lastRecovery! as unknown as Record<string, unknown>
          : target === "queue"
            ? state.queued! as unknown as Record<string, unknown>
            : state.inFlight! as unknown as Record<string, unknown>;
      const field = target === "state" ? "lastRecovery" : target === "proof" ? "kind" : "generation";
      let reads = 0;
      Object.defineProperty(wrapper, field, { enumerable: true, get() { reads += 1; return null; } });
      expect(() => validateCalibrationHarnessRecoveryState(state)).toThrow();
      expect(reads).toBe(0);
    }

    const hidden = observedInFlightWithPreservedG2();
    Object.defineProperty(hidden.lastRecovery!, "hidden", { enumerable: false, value: true });
    expect(() => validateCalibrationHarnessRecoveryState(hidden)).toThrow(/unknown or missing/i);
    const symbol = observedInFlightWithPreservedG2();
    Object.defineProperty(symbol.queued!, Symbol("hidden"), { enumerable: true, value: true });
    expect(() => validateCalibrationHarnessRecoveryState(symbol)).toThrow(/symbol/i);
  });

  it("uses strict V1 identity grammar unchanged for V2 conversion", () => {
    const whitespaceIdentity = { ...legacy, ownerId: " owner " };
    const converted = convertCalibrationHarnessLocalStateToRecoveryState(whitespaceIdentity);
    expect(validateCalibrationHarnessRecoveryState(converted)).toBe(converted);

    const malformed = { ...legacy, ownerId: "\u0000" };
    const before = structuredClone(malformed);
    expect(() => convertCalibrationHarnessLocalStateToRecoveryState(malformed)).toThrow(/ownerId/i);
    expect(malformed).toEqual(before);
  });
});
