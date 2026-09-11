import { describe, expect, it } from "vitest";
import {
  CALIBRATION_HARNESS_LOCAL_STATE_VERSION,
  validateCalibrationHarnessLocalState,
  validateCalibrationHarnessPersistenceIdentity,
} from "./calibrationHarnessLocalState";
import type { CalibrationHarnessLocalState } from "./calibrationHarnessLocalState";

const emptySnapshot = {
  version: 1 as const,
  datasets: [],
  cases: [],
  assets: [],
  runs: [],
};

function cleanState(overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: CALIBRATION_HARNESS_LOCAL_STATE_VERSION,
    ownerId: "owner-a",
    harnessId: "harness-a",
    connectionId: "connection-a",
    base: {
      revision: 1,
      snapshot: {
        ...emptySnapshot,
        retainedUnknownMetadata: { alpha: ["preserved", 1] },
      },
    },
    queued: null,
    inFlight: null,
    dirtyGeneration: 0,
    sentGeneration: 0,
    acknowledgedGeneration: 0,
    updatedAt: 1,
    ...overrides,
  };
}

function settledState(): CalibrationHarnessLocalState {
  const acknowledgedSnapshot = {
    ...emptySnapshot,
    retainedUnknownMetadata: { alpha: ["acknowledged", 2] },
  };
  return cleanState({
    base: { revision: 2, snapshot: acknowledgedSnapshot },
    dirtyGeneration: 1,
    sentGeneration: 1,
    acknowledgedGeneration: 1,
    lastAcknowledgement: {
      generation: 1,
      snapshot: acknowledgedSnapshot,
      expectedBaseRevision: 1,
      base: { revision: 2, snapshot: acknowledgedSnapshot },
    },
  });
}

describe("validateCalibrationHarnessLocalState", () => {
  it("returns a valid clean state without normalizing its full snapshot metadata", () => {
    const state = cleanState();

    expect(validateCalibrationHarnessLocalState(state)).toBe(state);
  });

  it("rejects accessor fields in state and identity wrappers without executing them", () => {
    const state = cleanState();
    let stateGetterCalls = 0;
    Object.defineProperty(state, "dirtyGeneration", {
      enumerable: true,
      get() {
        stateGetterCalls += 1;
        return 0;
      },
    });
    expect(() => validateCalibrationHarnessLocalState(state)).toThrow();
    expect(stateGetterCalls).toBe(0);

    const identity = { ownerId: "owner-a", harnessId: "harness-a", connectionId: "connection-a" };
    let identityGetterCalls = 0;
    Object.defineProperty(identity, "ownerId", {
      enumerable: true,
      get() {
        identityGetterCalls += 1;
        return "owner-a";
      },
    });
    expect(() => validateCalibrationHarnessPersistenceIdentity(identity)).toThrow();
    expect(identityGetterCalls).toBe(0);
  });

  it("rejects accessor, hidden, symbol, and unknown fields in durable wrappers without touching snapshots", () => {
    const base = { revision: 1, snapshot: emptySnapshot } as Record<string, unknown>;
    let baseGetterCalls = 0;
    Object.defineProperty(base, "revision", {
      enumerable: true,
      get() {
        baseGetterCalls += 1;
        return 1;
      },
    });
    expect(() => validateCalibrationHarnessLocalState(cleanState({ base }))).toThrow();
    expect(baseGetterCalls).toBe(0);

    const queued = { generation: 1, snapshot: emptySnapshot, unexpected: true };
    expect(() => validateCalibrationHarnessLocalState(cleanState({
      queued,
      dirtyGeneration: 1,
      sentGeneration: 0,
      acknowledgedGeneration: 0,
    }))).toThrow();

    const inFlight = { generation: 1, snapshot: emptySnapshot, expectedBaseRevision: 1 } as Record<string, unknown>;
    let inFlightGetterCalls = 0;
    Object.defineProperty(inFlight, "generation", {
      enumerable: true,
      get() {
        inFlightGetterCalls += 1;
        return 1;
      },
    });
    expect(() => validateCalibrationHarnessLocalState(cleanState({
      queued: { generation: 1, snapshot: emptySnapshot },
      inFlight,
      dirtyGeneration: 1,
      sentGeneration: 1,
      acknowledgedGeneration: 0,
    }))).toThrow();
    expect(inFlightGetterCalls).toBe(0);

    const hidden = cleanState();
    Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
    expect(() => validateCalibrationHarnessLocalState(hidden)).toThrow();
    expect(() => validateCalibrationHarnessLocalState({ ...cleanState(), [Symbol("unexpected")]: true })).toThrow();
  });

  it("rejects queued generations that are already acknowledged", () => {
    expect(() => validateCalibrationHarnessLocalState(cleanState({
      queued: { generation: 1, snapshot: emptySnapshot },
      dirtyGeneration: 1,
      sentGeneration: 1,
      acknowledgedGeneration: 1,
    }))).toThrow();
  });

  it("rejects queued and retained receipt accessor or extension wrappers without executing them", () => {
    const queued = { generation: 1, snapshot: emptySnapshot } as Record<string, unknown>;
    let queuedGetterCalls = 0;
    Object.defineProperty(queued, "generation", {
      enumerable: true,
      get() {
        queuedGetterCalls += 1;
        return 1;
      },
    });
    expect(() => validateCalibrationHarnessLocalState(cleanState({
      queued,
      dirtyGeneration: 1,
      sentGeneration: 0,
      acknowledgedGeneration: 0,
    }))).toThrow();
    expect(queuedGetterCalls).toBe(0);

    const lastAcknowledgement = {
      generation: 1,
      snapshot: emptySnapshot,
      expectedBaseRevision: 1,
      base: { revision: 2, snapshot: emptySnapshot },
      unexpected: true,
    };
    expect(() => validateCalibrationHarnessLocalState(cleanState({
      queued: null,
      dirtyGeneration: 1,
      sentGeneration: 1,
      acknowledgedGeneration: 1,
      lastAcknowledgement,
    }))).toThrow();
  });

  it("rejects a retained receipt whose payload differs from its returned base", () => {
    const state = settledState();
    state.lastAcknowledgement!.snapshot = { ...emptySnapshot, retainedUnknownMetadata: "different" };

    expect(() => validateCalibrationHarnessLocalState(state)).toThrow();
  });

  it("rejects a retained receipt whose returned revision did not advance its expected base", () => {
    const state = settledState();
    state.lastAcknowledgement!.expectedBaseRevision = 2;

    expect(() => validateCalibrationHarnessLocalState(state)).toThrow();
  });

  it("rejects a retained receipt newer than the installed base", () => {
    const state = settledState();
    state.base!.revision = 1;

    expect(() => validateCalibrationHarnessLocalState(state)).toThrow();
  });

  it("rejects a retained receipt without an installed base", () => {
    const state = settledState();
    state.base = null;

    expect(() => validateCalibrationHarnessLocalState(state)).toThrow();
  });

  it("rejects equal retained and installed revisions with different snapshots", () => {
    const state = settledState();
    state.base!.snapshot = { ...emptySnapshot, retainedUnknownMetadata: "different" };

    expect(() => validateCalibrationHarnessLocalState(state)).toThrow();
  });

  it("accepts a genuine retained receipt after a clean base advance", () => {
    const state = settledState();
    state.base = {
      revision: 3,
      snapshot: { ...emptySnapshot, retainedUnknownMetadata: "later valid state" },
    };

    expect(validateCalibrationHarnessLocalState(state)).toBe(state);
  });
});
