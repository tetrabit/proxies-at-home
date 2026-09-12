import "fake-indexeddb/auto";
import { Blob as NativeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { ProxxiedDexie } from "@/db";
import { createMpcCalibrationOperationScope } from "@/helpers/mpcCalibrationOperationScope";
import { createMpcCalibrationQueueRecoveryController } from "@/helpers/mpcCalibrationQueueRecoveryController";
import { createMpcCalibrationRefreshScheduler } from "@/helpers/mpcCalibrationRefreshScheduler";
import { runMpcCalibrationInitialAdmissionWithIdentity } from "@/helpers/mpcCalibrationInitialAdmission";
import { createMpcCalibrationSyncStateStore } from "@/helpers/mpcCalibrationSyncState";
import type { MpcCalibrationTransport } from "@/helpers/mpcCalibrationTransport";
import { MpcCalibrationSyncLifecycle } from "./MpcCalibrationSyncLifecycle";
import { useMpcCalibrationSyncStore } from "@/store/mpcCalibrationSync";
import { useCalibrationModalStore } from "@/store/calibrationModal";

const identity = {
  ownerId: "owner-a",
  harnessId: "harness-a",
  connectionId: "connection-a",
};

const handles: ProxxiedDexie[] = [];

globalThis.Blob = NativeBlob as unknown as typeof Blob;

function dependencies() {
  const database = new ProxxiedDexie(`app-sync-${crypto.randomUUID()}`);
  handles.push(database);
  const queueDispose = vi.fn();
  const schedulerDispose = vi.fn();
  const queue = { dispose: queueDispose, isRunning: () => false };
  const scheduler = { start: vi.fn(async () => undefined), dispose: schedulerDispose };
  return {
    database,
    createScope: createMpcCalibrationOperationScope,
    admit: vi.fn(async ({ onAuthenticated }) => {
      onAuthenticated?.(identity);
      return { kind: "no-remote" as const, target: "linked-web" as const, identity };
    }),
    selectTransport: vi.fn(() => ({} as never)),
    createQueueController: vi.fn(() => queue),
    createRefreshScheduler: vi.fn(() => scheduler),
    queueDispose,
    schedulerDispose,
  };
}

describe("MpcCalibrationSyncLifecycle", () => {
  beforeEach(() => {
    useMpcCalibrationSyncStore.getState().clearSelection();
  });

  afterEach(() => {
    for (const database of handles.splice(0)) database.close();
  });

  it("is dormant while unselected and creates one app owner after an explicit linked selection", async () => {
    const deps = dependencies();
    const view = render(<MpcCalibrationSyncLifecycle dependencies={deps} />);

    expect(screen.getByTestId("mpc-calibration-sync-lifecycle")).toBeDefined();
    expect(deps.admit).not.toHaveBeenCalled();
    expect(deps.selectTransport).not.toHaveBeenCalled();

    act(() => useMpcCalibrationSyncStore.getState().selectLinked("linked-web"));

    await waitFor(() => expect(deps.createQueueController).toHaveBeenCalledOnce());
    expect(deps.createRefreshScheduler).toHaveBeenCalledOnce();
    expect(useMpcCalibrationSyncStore.getState().status).toBe("clean");

    view.unmount();
    expect(deps.queueDispose).toHaveBeenCalledOnce();
    expect(deps.schedulerDispose).toHaveBeenCalledOnce();
  });

  it("projects identity-scoped durable C1 pending work ahead of clean status", async () => {
    const deps = dependencies();
    render(<MpcCalibrationSyncLifecycle dependencies={deps} />);
    act(() => useMpcCalibrationSyncStore.getState().selectLinked("linked-web"));
    await waitFor(() => expect(deps.createQueueController).toHaveBeenCalledOnce());

    const state = createMpcCalibrationSyncStateStore(deps.database, { now: () => 1 });
    const snapshot = { version: 1 as const, datasets: [], cases: [], assets: [], runs: [], retained: { exact: true } };
    await state.storeBaseWhenClean(identity, { revision: 1, snapshot });
    await waitFor(() => expect(useMpcCalibrationSyncStore.getState().status).toBe("clean"));

    await state.queueSnapshot(identity, snapshot);
    await waitFor(() => expect(useMpcCalibrationSyncStore.getState().status).toBe("queued"));

    await state.markSnapshotSent(identity, 1);
    await waitFor(() => expect(useMpcCalibrationSyncStore.getState().status).toBe("in-flight"));
  });

  it("keeps app-owned queue and retry resources alive when only the modal store closes", async () => {
    const deps = dependencies();
    render(<MpcCalibrationSyncLifecycle dependencies={deps} />);
    act(() => useMpcCalibrationSyncStore.getState().selectLinked("linked-web"));
    await waitFor(() => expect(deps.createQueueController).toHaveBeenCalledOnce());

    // The actual modal close action owns only card-modal state. No lifecycle
    // callback is wired to it, so this app-owned connection remains active.
    act(() => useCalibrationModalStore.getState().closeModal());
    act(() => useMpcCalibrationSyncStore.getState().publishStatus("queued"));
    expect(deps.queueDispose).not.toHaveBeenCalled();
    expect(deps.schedulerDispose).not.toHaveBeenCalled();
    expect(useMpcCalibrationSyncStore.getState().status).toBe("queued");
  });

  it("refuses a blocked admission whose queued C1 row is not physically bound to the authenticated identity", async () => {
    const deps = dependencies();
    const state = createMpcCalibrationSyncStateStore(deps.database, { now: () => 1 });
    const snapshot = { version: 1 as const, datasets: [], cases: [], assets: [], runs: [], retained: { exact: true } };
    await state.storeBaseWhenClean(identity, { revision: 1, snapshot });
    await state.queueSnapshot(identity, snapshot);
    const foreignBinding = {
      id: "mpc-calibration-cache-binding" as const,
      ownerId: "foreign-owner", harnessId: "foreign-harness", connectionId: "foreign-connection",
      revision: 1, updatedAt: 1,
    };
    await deps.database.mpcCalibrationCacheBindings.put(foreignBinding);
    deps.admit = vi.fn(async ({ onAuthenticated }: Parameters<typeof runMpcCalibrationInitialAdmissionWithIdentity>[0]) => {
      onAuthenticated?.(identity);
      return { kind: "blocked" as const, target: "linked-web" as const, identity };
    }) as never;
    render(<MpcCalibrationSyncLifecycle dependencies={deps} />);

    act(() => useMpcCalibrationSyncStore.getState().selectLinked("linked-web"));

    await waitFor(() => expect(useMpcCalibrationSyncStore.getState().status).toBe("blocked"));
    expect(deps.createQueueController).not.toHaveBeenCalled();
    expect(await deps.database.mpcCalibrationCacheBindings.get("mpc-calibration-cache-binding")).toEqual(foreignBinding);
    expect(await state.load(identity)).toMatchObject({ queued: { generation: 1, snapshot } });
  });

  it("projects bounded C5 terminal results above durable queue work while retaining that queue", async () => {
    const deps = dependencies();
    let queueOptions: Parameters<typeof createMpcCalibrationQueueRecoveryController>[0] | undefined;
    let schedulerOptions: { onStatus?: (status: { kind: "retrying"; attempt: number; delayMs: number }) => void } | undefined;
    deps.createQueueController = vi.fn((options: Parameters<typeof createMpcCalibrationQueueRecoveryController>[0]) => {
      queueOptions = options;
      return { dispose: deps.queueDispose, isRunning: () => false };
    }) as never;
    deps.createRefreshScheduler = vi.fn((options: Parameters<typeof createMpcCalibrationRefreshScheduler>[0]) => {
      schedulerOptions = options;
      return { start: vi.fn(async () => undefined), dispose: deps.schedulerDispose };
    }) as never;
    render(<MpcCalibrationSyncLifecycle dependencies={deps} />);
    act(() => useMpcCalibrationSyncStore.getState().selectLinked("linked-web"));
    await waitFor(() => expect(queueOptions).toBeDefined());

    const state = createMpcCalibrationSyncStateStore(deps.database, { now: () => 1 });
    const snapshot = { version: 1 as const, datasets: [], cases: [], assets: [], runs: [], retained: { exact: true } };
    await state.storeBaseWhenClean(identity, { revision: 1, snapshot });
    await state.queueSnapshot(identity, snapshot);
    await waitFor(() => expect(useMpcCalibrationSyncStore.getState().status).toBe("queued"));

    expect(queueOptions!.onResult).toEqual(expect.any(Function));
    act(() => queueOptions!.onResult!({ kind: "recovery", target: "linked-web", status: "conflict" }));
    expect(useMpcCalibrationSyncStore.getState().status).toBe("conflict");
    act(() => queueOptions!.onResult!({ kind: "recovery", target: "linked-web", status: "blocked" }));
    expect(useMpcCalibrationSyncStore.getState().status).toBe("blocked");
    act(() => queueOptions!.onResult!({ kind: "recovery", target: "linked-web", status: "failed" }));
    expect(useMpcCalibrationSyncStore.getState().status).toBe("failed");
    act(() => schedulerOptions!.onStatus?.({ kind: "retrying", attempt: 1, delayMs: 1_000 }));
    expect(useMpcCalibrationSyncStore.getState().status).toBe("offline");
    expect(await state.load(identity)).toMatchObject({ queued: { generation: 1, snapshot } });
  });

  it("does not let a synchronous selection replacement publish a stale lifecycle status", async () => {
    const deps = dependencies();
    deps.createRefreshScheduler = vi.fn((options: Parameters<typeof createMpcCalibrationRefreshScheduler>[0]) => ({
      start: vi.fn(async () => {
        useMpcCalibrationSyncStore.getState().clearSelection();
        options.onStatus?.({ kind: "needs-reconciliation" });
      }),
      dispose: deps.schedulerDispose,
    })) as never;
    const statuses: string[] = [];
    const unsubscribe = useMpcCalibrationSyncStore.subscribe(state => statuses.push(state.status));
    render(<MpcCalibrationSyncLifecycle dependencies={deps} />);

    act(() => useMpcCalibrationSyncStore.getState().selectLinked("linked-web"));
    await waitFor(() => expect(deps.createRefreshScheduler).toHaveBeenCalledOnce());
    await waitFor(() => expect(useMpcCalibrationSyncStore.getState().status).toBe("unpaired"));

    expect(statuses).not.toContain("conflict");
    unsubscribe();
  });

  it("reopens a real bound C1 queue through actual C3 admission and drains it through C5", async () => {
    const database = new ProxxiedDexie(`app-sync-real-${crypto.randomUUID()}`);
    handles.push(database);
    const base = {
      version: 1 as const,
      datasets: [{ id: "dataset", name: "Base", targetCaseCount: 1, createdAt: 1, updatedAt: 1, version: 1 }],
      cases: [{ id: "case", datasetId: "dataset", createdAt: 1, updatedAt: 1, source: { name: "Base" }, candidates: [] }],
      assets: [], runs: [], retained: { base: true },
    };
    const desired = structuredClone(base);
    desired.datasets[0]!.name = "Desired";
    desired.datasets[0]!.updatedAt = 2;
    desired.cases[0]!.source = { name: "Desired" };
    const state = createMpcCalibrationSyncStateStore(database, { now: () => 1 });
    await state.storeBaseWhenClean(identity, { revision: 1, snapshot: base });
    await state.queueSnapshot(identity, desired);
    await database.mpcCalibrationDatasets.bulkPut(desired.datasets);
    await database.mpcCalibrationCases.bulkPut(desired.cases);
    await database.mpcCalibrationLinkStates.put({ formatVersion: 1, ...identity, updatedAt: 1 });
    await database.mpcCalibrationCacheBindings.put({ id: "mpc-calibration-cache-binding", ...identity, revision: 1, updatedAt: 1 });
    let remote = { revision: 1, snapshot: base };
    const transport: MpcCalibrationTransport = {
      pair: async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId }),
      unpair: async () => undefined,
      getSession: vi.fn(async () => ({ ownerId: identity.ownerId, harnessId: identity.harnessId })),
      getSnapshot: vi.fn(async () => structuredClone(remote)),
      getBlob: async () => new Uint8Array(),
      missingBlobs: async () => ({ missing: [] }),
      putBlob: async () => ({ sha256: "unused", byteLength: 0, inserted: false }),
      publishSnapshot: vi.fn(async (snapshot, expectedRevision) => {
        expect(expectedRevision).toBe(1);
        remote = { revision: 2, snapshot: structuredClone(snapshot) };
        return structuredClone(remote);
      }),
    };
    let admitted: Awaited<ReturnType<typeof runMpcCalibrationInitialAdmissionWithIdentity>> | undefined;
    let recoveryResult: unknown;
    const createQueueController = vi.fn((options: Parameters<typeof createMpcCalibrationQueueRecoveryController>[0]) =>
      createMpcCalibrationQueueRecoveryController({
        ...options,
        onResult(result) {
          recoveryResult = result;
          options.onResult?.(result);
        },
      })
    );
    const deps = {
      database,
      createScope: createMpcCalibrationOperationScope,
      admit: vi.fn(async (input: Parameters<typeof runMpcCalibrationInitialAdmissionWithIdentity>[0]) => {
        admitted = await runMpcCalibrationInitialAdmissionWithIdentity({
          ...input,
          createWebTransport: () => transport,
        });
        return admitted;
      }),
      selectTransport: vi.fn(() => transport),
      createQueueController,
      createRefreshScheduler: vi.fn(() => ({ start: vi.fn(async () => undefined), dispose: vi.fn() })),
    };
    render(<MpcCalibrationSyncLifecycle dependencies={deps} />);

    act(() => useMpcCalibrationSyncStore.getState().selectLinked("linked-web"));

    await waitFor(() => expect(admitted).toMatchObject({ kind: "needs-reconciliation", identity }));
    await waitFor(() => expect(createQueueController).toHaveBeenCalledOnce());
    await waitFor(() => expect(recoveryResult).toEqual({ kind: "recovery", target: "linked-web", status: "published", generation: 1, revision: 2 }));
    await waitFor(() => expect(transport.publishSnapshot).toHaveBeenCalledOnce());
    expect(transport.getSession).toHaveBeenCalled();
    expect(await state.load(identity)).toMatchObject({
      base: { revision: 2, snapshot: desired },
      queued: null,
      inFlight: null,
      acknowledgedGeneration: 1,
    });
    expect(useMpcCalibrationSyncStore.getState().status).toBe("clean");
  });
});
