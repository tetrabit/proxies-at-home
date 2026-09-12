import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const nativeBlob = vi.hoisted(async () => {
  const { Blob: NodeBlob } = await import("node:buffer");
  Object.defineProperty(globalThis, "Blob", { value: NodeBlob, configurable: true, writable: true });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "Blob", { value: NodeBlob, configurable: true, writable: true });
  }
  return NodeBlob;
});
const privateTestDatabaseName = vi.hoisted(
  () => `c6-import-${crypto.randomUUID()}`
);
const mockMarkMpcPreferenceSyncDirty = vi.hoisted(() => vi.fn());

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual, db: new actual.ProxxiedDexie(privateTestDatabaseName) };
});

vi.mock("./mpcPreferenceSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mpcPreferenceSync")>()),
  markMpcPreferenceSyncDirty: mockMarkMpcPreferenceSyncDirty,
}));

if (!globalThis.crypto) globalThis.crypto = webcrypto as Crypto;
void nativeBlob;

import { db } from "@/db";
import {
  buildMpcCalibrationFixture,
  downloadMpcCalibrationFixture,
  getMpcCalibrationFixtureFilename,
  importMpcCalibrationFixture,
  migrateMpcCalibrationFixture,
  requestMpcCalibrationSaveHandle,
  saveMpcCalibrationFixture,
  validateMpcCalibrationFixture,
  writeMpcCalibrationFixtureToHandle,
  type MpcCalibrationFixture,
} from "./mpcCalibrationImport";
import {
  createMpcCalibrationDataset,
  listMpcCalibrationAssets,
  listMpcCalibrationCases,
  listMpcCalibrationRuns,
  saveMpcCalibrationAssets,
  saveMpcCalibrationCase,
  saveMpcCalibrationRun,
} from "./mpcCalibrationStorage";
import defaultsFixture from "../../tests/fixtures/mpc-preference-defaults.v1.json";
import { buildBootstrapPreferenceDefaults } from "./mpcPreferenceBootstrap";
import { MPC_CALIBRATION_CACHE_BINDING_ID } from "./mpcCalibrationMutations";
import { flushMpcCalibrationOutbox } from "./mpcCalibrationOutbox";
import { createMpcCalibrationSyncStateStore } from "./mpcCalibrationSyncState";

const boundIdentity = {
  ownerId: "c6-owner",
  harnessId: "c6-harness",
  connectionId: "c6-connection",
};

function linkedFixture(id = "linked-import-dataset"): MpcCalibrationFixture {
  return {
    version: 1,
    exportedAt: new Date(1).toISOString(),
    dataset: {
      id,
      name: "Linked import dataset",
      targetCaseCount: 1,
      createdAt: 1,
      updatedAt: 1,
      version: 1,
      retainedDataset: { nested: ["dataset", "order"] },
    } as MpcCalibrationFixture["dataset"],
    cases: [{
      id: `${id}-case`,
      datasetId: id,
      createdAt: 1,
      updatedAt: 1,
      source: { name: "Linked card", retainedSource: { nested: ["case", "order"] } },
      candidates: [],
      retainedCase: { nested: ["case", "order"] },
    } as MpcCalibrationFixture["cases"][number]],
    assets: [{
      id: `${id}-asset`,
      datasetId: id,
      caseId: `${id}-case`,
      role: "source",
      mimeType: "text/plain",
      data: "bGlua2VkLWJsb2I=",
      createdAt: 1,
      retainedAsset: { nested: ["asset", "order"] },
    }],
    runs: [{
      id: `${id}-run`,
      datasetId: id,
      algorithmId: "linked",
      createdAt: 1,
      summary: { totalCases: 1, matchedCases: 1, mismatchedCases: 0, accuracy: 1 },
      results: [],
      retainedRun: { nested: ["run", "order"] },
    } as MpcCalibrationFixture["runs"][number]],
  };
}

async function bindForCallerImport() {
  const state = createMpcCalibrationSyncStateStore(db, { now: () => 10 });
  await state.storeBaseWhenClean(boundIdentity, {
    revision: 1,
    snapshot: {
      version: 1,
      retainedRoot: { nested: ["root", "order"] },
      datasets: [],
      cases: [],
      assets: [],
      runs: [],
    },
  });
  await db.mpcCalibrationCacheBindings.put({
    id: MPC_CALIBRATION_CACHE_BINDING_ID,
    ...boundIdentity,
    revision: 1,
    updatedAt: 10,
  });
  return state;
}

describe("mpcCalibrationImport", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    mockMarkMpcPreferenceSyncDirty.mockClear();
    delete (window as Window & { showSaveFilePicker?: unknown })
      .showSaveFilePicker;
    await db.mpcCalibrationRuns.clear();
    await db.mpcCalibrationAssets.clear();
    await db.mpcCalibrationCases.clear();
    await db.mpcCalibrationDatasets.clear();
    await db.mpcCalibrationSyncStates.clear();
    await db.mpcCalibrationCacheBindings.clear();
  });

  afterAll(() => {
    db.close();
  });

  it("builds a safe fixture filename from the dataset name", () => {
    expect(
      getMpcCalibrationFixtureFilename({
        dataset: {
          id: "dataset-1",
          name: "Fixture Dataset: v1/alpha",
          targetCaseCount: 1,
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        },
      })
    ).toBe("mpc-calibration_Fixture_Dataset__v1_alpha.json");
  });

  it("builds and validates a versioned fixture", async () => {
    const dataset = await createMpcCalibrationDataset({
      name: "Fixture Dataset",
    });
    await saveMpcCalibrationCase({
      id: "case-1",
      datasetId: dataset.id,
      source: { name: "Sol Ring" },
      candidates: [],
    });
    await saveMpcCalibrationAssets([
      {
        id: "asset-1",
        datasetId: dataset.id,
        caseId: "case-1",
        role: "source",
        mimeType: "image/png",
        blob: new Blob(["source"], { type: "image/png" }),
        createdAt: 1,
      },
    ]);
    await saveMpcCalibrationRun({
      id: "run-1",
      datasetId: dataset.id,
      algorithmId: "baseline",
      summary: {
        totalCases: 1,
        matchedCases: 1,
        mismatchedCases: 0,
        accuracy: 1,
      },
      results: [],
    });

    const fixture = await buildMpcCalibrationFixture(dataset.id);

    expect(validateMpcCalibrationFixture(fixture)).toEqual(fixture);
    expect(fixture.assets[0]?.data).toBeTruthy();
  });

  it("throws when building a fixture for a missing dataset", async () => {
    await expect(buildMpcCalibrationFixture("missing")).rejects.toThrow(
      "Calibration dataset missing not found"
    );
  });

  it("builds fixture assets using browser-safe base64 encoding", async () => {
    const dataset = await createMpcCalibrationDataset({
      name: "Browser Fixture",
    });
    await saveMpcCalibrationCase({
      id: "case-1",
      datasetId: dataset.id,
      source: { name: "Sol Ring" },
      candidates: [],
    });
    await saveMpcCalibrationAssets([
      {
        id: "asset-1",
        datasetId: dataset.id,
        caseId: "case-1",
        role: "source",
        mimeType: "image/png",
        blob: new Blob([Uint8Array.from([1, 2, 3, 4])], { type: "image/png" }),
        createdAt: 1,
      },
    ]);

    const btoaSpy = vi.spyOn(globalThis, "btoa");

    const fixture = await buildMpcCalibrationFixture(dataset.id);

    expect(fixture.assets[0]?.data).toBeTruthy();
    expect(btoaSpy).toHaveBeenCalled();
  });

  it("encodes large asset blobs without failing fixture construction", async () => {
    const dataset = await createMpcCalibrationDataset({
      name: "Large Browser Fixture",
    });
    const payload = "A".repeat(0x8000 + 3);

    await saveMpcCalibrationAssets([
      {
        id: "asset-1",
        datasetId: dataset.id,
        caseId: "case-1",
        role: "source",
        mimeType: "application/octet-stream",
        blob: new Blob([payload], { type: "application/octet-stream" }),
        createdAt: 1,
      },
    ]);

    const fixture = await buildMpcCalibrationFixture(dataset.id);

    expect(fixture.assets[0]?.data).toBeTruthy();
  });

  it("round-trips fixture import into storage", async () => {
    const fixture = validateMpcCalibrationFixture({
      version: 1,
      exportedAt: new Date().toISOString(),
      dataset: {
        id: "dataset-1",
        name: "Imported Dataset",
        targetCaseCount: 9,
        createdAt: 1,
        updatedAt: 1,
        version: 1,
      },
      cases: [
        {
          id: "case-1",
          datasetId: "dataset-1",
          createdAt: 1,
          updatedAt: 1,
          source: { name: "Sol Ring" },
          candidates: [],
        },
      ],
      assets: [
        {
          id: "asset-1",
          datasetId: "dataset-1",
          caseId: "case-1",
          role: "source",
          mimeType: "image/png",
          data: "c291cmNl",
          createdAt: 1,
        },
      ],
      runs: [
        {
          id: "run-1",
          datasetId: "dataset-1",
          algorithmId: "baseline",
          createdAt: 1,
          summary: {
            totalCases: 1,
            matchedCases: 0,
            mismatchedCases: 1,
            accuracy: 0,
          },
          results: [],
        },
      ],
    });

    await importMpcCalibrationFixture(fixture);

    expect(await listMpcCalibrationCases("dataset-1")).toHaveLength(1);
    expect(await listMpcCalibrationAssets("dataset-1")).toHaveLength(1);
    expect(await listMpcCalibrationRuns("dataset-1")).toHaveLength(1);
  });

  it("imports a linked fixture through one C1 generation, C4 acknowledgement, and database reopen", async () => {
    const state = await bindForCallerImport();
    const fixture = linkedFixture();
    const scope = await (await import("./mpcCalibrationStorage")).captureMpcCalibrationMutationScope();

    await expect(importMpcCalibrationFixture(fixture, scope)).resolves.toBe(fixture.dataset.id);
    const queued = await state.load(boundIdentity);
    expect(queued).toMatchObject({
      dirtyGeneration: 1,
      queued: {
        generation: 1,
        snapshot: {
          retainedRoot: { nested: ["root", "order"] },
          datasets: [expect.objectContaining({ retainedDataset: { nested: ["dataset", "order"] } })],
          cases: [expect.objectContaining({ retainedCase: { nested: ["case", "order"] } })],
          assets: [expect.objectContaining({ retainedAsset: { nested: ["asset", "order"] } })],
          runs: [expect.objectContaining({ retainedRun: { nested: ["run", "order"] } })],
        },
      },
    });
    expect(queued!.queued!.snapshot.assets[0]).not.toHaveProperty("data");

    const uploaded: Uint8Array[] = [];
    const persistedBeforeC4 = await db.mpcCalibrationAssets.get(`${fixture.dataset.id}-asset`);
    expect(persistedBeforeC4).toMatchObject({
      id: queued!.queued!.snapshot.assets[0]!.id,
      mimeType: queued!.queued!.snapshot.assets[0]!.mimeType,
      sha256: queued!.queued!.snapshot.assets[0]!.sha256,
      byteLength: queued!.queued!.snapshot.assets[0]!.byteLength,
    });
    expect(persistedBeforeC4!.blob).toMatchObject({
      size: queued!.queued!.snapshot.assets[0]!.byteLength,
      type: queued!.queued!.snapshot.assets[0]!.mimeType,
    });
    expect(typeof persistedBeforeC4!.blob.arrayBuffer).toBe("function");
    expect(Number.isSafeInteger(persistedBeforeC4!.blob.size)).toBe(true);
    const result = await flushMpcCalibrationOutbox({
      database: db,
      identity: boundIdentity,
      transport: {
        getSession: async () => ({ ownerId: boundIdentity.ownerId, harnessId: boundIdentity.harnessId }),
        missingBlobs: async () => ({ missing: [queued!.queued!.snapshot.assets[0]!.sha256] }),
        putBlob: async (sha256, bytes) => {
          const binary = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
          uploaded.push(binary);
          return { sha256, byteLength: binary.byteLength, inserted: true };
        },
        publishSnapshot: async (snapshot, expectedRevision) => ({ revision: (expectedRevision ?? 0) + 1, snapshot }),
      },
    });

    expect(result).toEqual({ status: "published", generation: 1, revision: 2 });
    expect(Array.from(uploaded[0]!)).toEqual(Array.from(new TextEncoder().encode("linked-blob")));
    expect(await state.load(boundIdentity)).toMatchObject({
      acknowledgedGeneration: 1,
      queued: null,
      inFlight: null,
      base: { revision: 2 },
    });

    db.close();
    await db.open();
    const reopenedAsset = await db.mpcCalibrationAssets.get(`${fixture.dataset.id}-asset`);
    expect(reopenedAsset).toMatchObject({ retainedAsset: { nested: ["asset", "order"] } });
    expect(Array.from(new Uint8Array(await reopenedAsset!.blob.arrayBuffer()))).toEqual(
      Array.from(new TextEncoder().encode("linked-blob"))
    );
  });

  it("retains stale children during import upserts without echoing transport data", async () => {
    const state = await bindForCallerImport();
    const fixture = linkedFixture("upsert-import-dataset");
    await importMpcCalibrationFixture(fixture);
    await flushMpcCalibrationOutbox({
      database: db,
      identity: boundIdentity,
      transport: {
        getSession: async () => ({ ownerId: boundIdentity.ownerId, harnessId: boundIdentity.harnessId }),
        missingBlobs: async () => ({ missing: [] }),
        putBlob: async () => { throw new Error("no blob upload expected"); },
        publishSnapshot: async (snapshot, expectedRevision) => ({ revision: (expectedRevision ?? 0) + 1, snapshot }),
      },
    });
    await db.mpcCalibrationCases.put({
      id: "stale-import-child",
      datasetId: fixture.dataset.id,
      createdAt: 1,
      updatedAt: 1,
      source: { name: "stale retained child" },
      candidates: [],
    });

    await importMpcCalibrationFixture(fixture);

    const children = await listMpcCalibrationCases(fixture.dataset.id);
    expect(children.map((child) => child.id).sort()).toEqual([
      "stale-import-child",
      `${fixture.dataset.id}-case`,
    ].sort());
    const persisted = await db.mpcCalibrationAssets.get(`${fixture.dataset.id}-asset`);
    expect(persisted).not.toHaveProperty("data");
    expect(mockMarkMpcPreferenceSyncDirty).toHaveBeenCalledTimes(2);
    expect(await state.load(boundIdentity)).toMatchObject({ dirtyGeneration: 2, queued: { generation: 2 } });
  });

  it("rejects an import captured locally when a bound cache appears before commit", async () => {
    const scope = await (await import("./mpcCalibrationStorage")).captureMpcCalibrationMutationScope();
    const state = await bindForCallerImport();

    await expect(importMpcCalibrationFixture(linkedFixture("local-to-bound"), scope))
      .rejects.toThrow("captured local-only cache was bound before commit");

    expect(await db.mpcCalibrationDatasets.count()).toBe(0);
    expect(await state.load(boundIdentity)).toMatchObject({ dirtyGeneration: 0, queued: null });
    expect(mockMarkMpcPreferenceSyncDirty).not.toHaveBeenCalled();
  });

  it("rejects an import after a changed bound identity without writing or queuing", async () => {
    const state = await bindForCallerImport();
    const scope = await (await import("./mpcCalibrationStorage")).captureMpcCalibrationMutationScope();
    await db.mpcCalibrationCacheBindings.put({
      id: MPC_CALIBRATION_CACHE_BINDING_ID,
      ...boundIdentity,
      ownerId: "different-c6-owner",
      revision: 2,
      updatedAt: 11,
    });

    await expect(importMpcCalibrationFixture(linkedFixture("identity-swap"), scope))
      .rejects.toThrow("captured cache binding was replaced");

    expect(await db.mpcCalibrationDatasets.count()).toBe(0);
    expect(await state.load(boundIdentity)).toMatchObject({ dirtyGeneration: 0, queued: null });
    expect(mockMarkMpcPreferenceSyncDirty).not.toHaveBeenCalled();
  });

  it("rejects an import after a same-identity physical binding refresh", async () => {
    const state = await bindForCallerImport();
    const scope = await (await import("./mpcCalibrationStorage")).captureMpcCalibrationMutationScope();
    await db.mpcCalibrationCacheBindings.put({
      id: MPC_CALIBRATION_CACHE_BINDING_ID,
      ...boundIdentity,
      revision: 2,
      updatedAt: 11,
    });

    await expect(importMpcCalibrationFixture(linkedFixture("physical-refresh"), scope))
      .rejects.toThrow("captured cache binding was replaced");

    expect(await db.mpcCalibrationDatasets.count()).toBe(0);
    expect(await state.load(boundIdentity)).toMatchObject({ dirtyGeneration: 0, queued: null });
    expect(mockMarkMpcPreferenceSyncDirty).not.toHaveBeenCalled();
  });

  it("rolls back populated rows, Blob bytes, and queue state when C1 rejects after import writes", async () => {
    const state = await bindForCallerImport();
    const fixture = linkedFixture("rollback-import-dataset");
    await db.mpcCalibrationDatasets.put({
      ...fixture.dataset,
      name: "prior dataset",
    });
    await db.mpcCalibrationCases.put({
      ...fixture.cases[0]!,
      source: { name: "prior case" },
    });
    await db.mpcCalibrationAssets.put({
      id: `${fixture.dataset.id}-asset`,
      datasetId: fixture.dataset.id,
      caseId: `${fixture.dataset.id}-case`,
      role: "source",
      mimeType: "text/plain",
      blob: new Blob(["prior-blob"], { type: "text/plain" }),
      createdAt: 1,
      retainedAsset: { nested: ["prior", "order"] },
    } as never);
    const beforeState = await state.load(boundIdentity);
    const originalPut = db.mpcCalibrationSyncStates.put.bind(db.mpcCalibrationSyncStates);
    const put = vi.spyOn(db.mpcCalibrationSyncStates, "put").mockImplementation((async (...args: unknown[]) => {
      await Reflect.apply(originalPut, db.mpcCalibrationSyncStates, args);
      throw new Error("injected C1 rejection after import writes");
    }) as never);

    try {
      await expect(importMpcCalibrationFixture(fixture)).rejects.toThrow(
        "injected C1 rejection after import writes"
      );
    } finally {
      put.mockRestore();
    }

    expect(await db.mpcCalibrationDatasets.get(fixture.dataset.id)).toMatchObject({ name: "prior dataset" });
    expect(await db.mpcCalibrationCases.get(`${fixture.dataset.id}-case`)).toMatchObject({ source: { name: "prior case" } });
    const restoredAsset = await db.mpcCalibrationAssets.get(`${fixture.dataset.id}-asset`);
    expect(restoredAsset).toMatchObject({ retainedAsset: { nested: ["prior", "order"] } });
    expect(Array.from(new Uint8Array(await restoredAsset!.blob.arrayBuffer()))).toEqual(
      Array.from(new TextEncoder().encode("prior-blob"))
    );
    expect(await state.load(boundIdentity)).toEqual(beforeState);
    expect(mockMarkMpcPreferenceSyncDirty).not.toHaveBeenCalled();
  });

  it("does not write rows, dirty state, or a queue generation when validation or Blob decoding fails", async () => {
    const state = await bindForCallerImport();
    const malformed = { version: 1 } as MpcCalibrationFixture;
    const undecodable = linkedFixture("decode-failure");
    undecodable.assets[0]!.data = "%%%";

    await expect(importMpcCalibrationFixture(malformed)).rejects.toThrow(
      "Invalid calibration fixture: missing dataset sections"
    );
    await expect(importMpcCalibrationFixture(undecodable)).rejects.toThrow();

    expect(await db.mpcCalibrationDatasets.count()).toBe(0);
    expect(await db.mpcCalibrationCases.count()).toBe(0);
    expect(await db.mpcCalibrationAssets.count()).toBe(0);
    expect(await db.mpcCalibrationRuns.count()).toBe(0);
    expect(await state.load(boundIdentity)).toMatchObject({ dirtyGeneration: 0, queued: null });
    expect(mockMarkMpcPreferenceSyncDirty).not.toHaveBeenCalled();
  });

  it("preserves unknown asset JSON while decoding the transport base64 into an owned Blob", async () => {
    const fixture = validateMpcCalibrationFixture({
      version: 1,
      exportedAt: new Date().toISOString(),
      dataset: {
        id: "dataset-unknown-asset-json",
        name: "Unknown Asset JSON",
        targetCaseCount: 1,
        createdAt: 1,
        updatedAt: 1,
        version: 1,
      },
      cases: [],
      assets: [
        {
          id: "asset-unknown-json",
          datasetId: "dataset-unknown-asset-json",
          caseId: "case-unknown-json",
          role: "source",
          mimeType: "text/plain",
          data: "c291cmNl",
          createdAt: 1,
          extensionMetadata: {
            producer: "fixture-v2",
            nested: ["retain", 2],
          },
        } as never,
      ],
      runs: [],
    });

    await importMpcCalibrationFixture(fixture, { kind: "local" });

    const persisted = await db.mpcCalibrationAssets.get("asset-unknown-json");
    expect(persisted).toEqual(
      expect.objectContaining({
        extensionMetadata: {
          producer: "fixture-v2",
          nested: ["retain", 2],
        },
      })
    );
    expect("data" in (persisted ?? {})).toBe(false);
    expect(Array.from(new Uint8Array(await persisted!.blob.arrayBuffer()))).toEqual([
      115, 111, 117, 114, 99, 101,
    ]);
  });

  it("rejects malformed calibration fixtures with clear validation errors", () => {
    expect(() => validateMpcCalibrationFixture(null)).toThrow(
      "Invalid calibration fixture: not a JSON object"
    );
    expect(() => validateMpcCalibrationFixture({})).toThrow(
      "Invalid calibration fixture: missing version"
    );
    expect(() => validateMpcCalibrationFixture({ version: 99 })).toThrow(
      "Unsupported calibration fixture version"
    );
    expect(() => validateMpcCalibrationFixture({ version: 1 })).toThrow(
      "Invalid calibration fixture: missing dataset sections"
    );
  });

  it("keeps current v1 fixtures compatible through the migration path", () => {
    const fixture = {
      version: 1,
      exportedAt: new Date().toISOString(),
      dataset: {
        id: "dataset-1",
        name: "Imported Dataset",
        targetCaseCount: 1,
        createdAt: 1,
        updatedAt: 1,
        version: 1,
      },
      cases: [
        {
          id: "case-1",
          datasetId: "dataset-1",
          createdAt: 1,
          updatedAt: 1,
          source: { name: "Sol Ring" },
          candidates: [],
        },
      ],
      assets: [],
      runs: [],
    };

    expect(
      migrateMpcCalibrationFixture(validateMpcCalibrationFixture(fixture))
    ).toEqual(fixture);
  });

  it("rejects unsupported migration paths below the current fixture version", () => {
    expect(() =>
      migrateMpcCalibrationFixture({
        version: 0,
        exportedAt: new Date().toISOString(),
        dataset: {
          id: "dataset-1",
          name: "Imported Dataset",
          targetCaseCount: 1,
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        },
        cases: [],
        assets: [],
        runs: [],
      })
    ).toThrow("Unsupported calibration fixture migration: v0 → v1");
  });

  it("downloads fixtures through a temporary anchor and revokes the object URL", () => {
    vi.useFakeTimers();
    const createObjectUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob://fixture");
    const revokeObjectUrlSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    downloadMpcCalibrationFixture({
      version: 1,
      exportedAt: new Date().toISOString(),
      dataset: {
        id: "dataset-1",
        name: "Download Fixture",
        targetCaseCount: 1,
        createdAt: 1,
        updatedAt: 1,
        version: 1,
      },
      cases: [],
      assets: [],
      runs: [],
    });

    expect(createObjectUrlSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(document.body.querySelector("a")).toBeNull();

    vi.advanceTimersByTime(1000);
    expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob://fixture");
  });

  it("returns null when the save file picker API is unavailable", async () => {
    await expect(
      requestMpcCalibrationSaveHandle({
        dataset: {
          id: "dataset-1",
          name: "No Picker",
          targetCaseCount: 1,
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        },
      })
    ).resolves.toBeNull();
  });

  it("requests a save file handle with JSON picker options when available", async () => {
    const handle = { createWritable: vi.fn() };
    const showSaveFilePicker = vi.fn(async () => handle);
    (window as unknown as Window & {
      showSaveFilePicker: typeof showSaveFilePicker;
    }).showSaveFilePicker = showSaveFilePicker;

    await expect(
      requestMpcCalibrationSaveHandle({
        dataset: {
          id: "dataset-1",
          name: "Picker Dataset",
          targetCaseCount: 1,
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        },
      })
    ).resolves.toBe(handle);
    expect(showSaveFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: "mpc-calibration_Picker_Dataset.json",
        types: [
          {
            description: "JSON",
            accept: { "application/json": [".json"] },
          },
        ],
      })
    );
  });

  it("writes a non-empty JSON payload to the save handle", async () => {
    const write = vi.fn();
    const close = vi.fn();

    await writeMpcCalibrationFixtureToHandle(
      JSON.stringify({ version: 1, dataset: { name: "Fixture" } }),
      {
        createWritable: async () => ({
          write,
          close,
        }),
      }
    );

    expect(write).toHaveBeenCalledWith(expect.stringContaining('"version":1'));
    expect(close).toHaveBeenCalled();
  });

  it("writes fixtures through the picker when a save handle is available", async () => {
    const write = vi.fn();
    const close = vi.fn();
    (window as unknown as Window & {
      showSaveFilePicker: NonNullable<
        (Window & { showSaveFilePicker?: unknown })["showSaveFilePicker"]
      >;
    }).showSaveFilePicker = vi.fn(async () => ({
      createWritable: async () => ({
        write,
        close,
      }),
    }));

    await expect(
      saveMpcCalibrationFixture({
        version: 1,
        exportedAt: new Date().toISOString(),
        dataset: {
          id: "dataset-1",
          name: "Picker Dataset",
          targetCaseCount: 1,
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        },
        cases: [],
        assets: [],
        runs: [],
      })
    ).resolves.toBe("picker");
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"version": 1'));
    expect(close).toHaveBeenCalled();
  });

  it("falls back to browser download when a picker handle is unavailable", async () => {
    vi.useFakeTimers();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob://download");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined
    );

    await expect(
      saveMpcCalibrationFixture({
        version: 1,
        exportedAt: new Date().toISOString(),
        dataset: {
          id: "dataset-1",
          name: "Download Dataset",
          targetCaseCount: 1,
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        },
        cases: [],
        assets: [],
        runs: [],
      })
    ).resolves.toBe("download");
  });

  it("keeps the promoted MPC preference defaults fixture valid", () => {
    expect(defaultsFixture).toEqual(
      expect.objectContaining({
        cases: expect.any(Array),
      })
    );
    expect(defaultsFixture.cases[0]).toEqual(
      expect.objectContaining({
        name: expect.any(String),
        expectedIdentifier: expect.any(String),
        candidates: expect.any(Array),
      })
    );
    expect(buildBootstrapPreferenceDefaults().cases.length).toBeGreaterThan(0);
  });

  it("aborts the writable when writing the payload fails", async () => {
    const abort = vi.fn(async () => undefined);

    await expect(
      writeMpcCalibrationFixtureToHandle('{"version":1}', {
        createWritable: async () => ({
          write: async () => {
            throw new Error("disk full");
          },
          close: async () => {},
          abort,
        }),
      })
    ).rejects.toThrow("disk full");

    expect(abort).toHaveBeenCalled();
  });

  it("rethrows write failures when abort is unavailable or also fails", async () => {
    await expect(
      writeMpcCalibrationFixtureToHandle('{"version":1}', {
        createWritable: async () => ({
          write: async () => {
            throw new Error("write failed");
          },
          close: async () => {},
        }),
      })
    ).rejects.toThrow("write failed");

    const abort = vi.fn(async () => {
      throw new Error("abort failed");
    });
    await expect(
      writeMpcCalibrationFixtureToHandle('{"version":1}', {
        createWritable: async () => ({
          write: async () => {
            throw new Error("write failed again");
          },
          close: async () => {},
          abort,
        }),
      })
    ).rejects.toThrow("write failed again");
    expect(abort).toHaveBeenCalled();
  });
});
