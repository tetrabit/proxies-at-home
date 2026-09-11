import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  CALIBRATION_HARNESS_LIMITS,
  type CalibrationHarnessSnapshot,
} from '../../../shared/calibrationHarness.js';
import * as storeModule from './calibrationHarnessStore.js';
import { initializeCalibrationHarnessSchema } from './calibrationHarnessSchema.js';
import { openNativeDatabase } from './openNativeDatabase.js';
import { createCalibrationHarnessFixtureProvider } from '../testUtils/calibrationHarnessFixtures.js';

const fixtures = createCalibrationHarnessFixtureProvider();

interface CalibrationHarnessStore {
  publish(
    ownerId: string,
    harnessId: string,
    expectedRevision: number | null,
    snapshot: CalibrationHarnessSnapshot,
  ): { revision: number; snapshot: CalibrationHarnessSnapshot };
  getCurrent(ownerId: string, harnessId: string): { revision: number; snapshot: CalibrationHarnessSnapshot } | null;
  getRevision(
    ownerId: string,
    harnessId: string,
    revision: number,
  ): { revision: number; snapshot: CalibrationHarnessSnapshot } | null;
}

function createStore(database: Database.Database): CalibrationHarnessStore {
  expect(storeModule).toHaveProperty('createCalibrationHarnessStore');
  return (storeModule as { createCalibrationHarnessStore: (connection: Database.Database) => CalibrationHarnessStore })
    .createCalibrationHarnessStore(database);
}

function createExclusiveDatabase(): Database.Database {
  const directory = fixtures.createInvocationRoot();
  const database = openNativeDatabase(path.join(directory, 'calibration-harness.db'));
  initializeCalibrationHarnessSchema(database);
  return database;
}

function snapshot(label: string): CalibrationHarnessSnapshot {
  return {
    version: 1,
    datasets: [],
    cases: [],
    assets: [],
    runs: [],
    futureMetadata: {
      label,
      deliberatelyUnordered: { z: 3, a: [label, { later: true }] },
    },
  };
}

function workerSnapshot(label: string): CalibrationHarnessSnapshot {
  return {
    version: 1,
    datasets: [],
    cases: [],
    assets: [],
    runs: [],
    futureMetadata: { label },
  };
}

function currentRow(database: Database.Database, ownerId: string, harnessId: string): { revision: number; snapshot_json: string } | undefined {
  return database.prepare(`
    SELECT revision, snapshot_json
    FROM mpc_harnesses
    WHERE owner_id = ? AND harness_id = ?
  `).get(ownerId, harnessId) as { revision: number; snapshot_json: string } | undefined;
}

type WorkerProgress = {
  type: 'progress';
  role: 'first' | 'second';
  stage: 'before-write-authority' | 'after-write-authority' | 'after-current-read';
};

type WorkerResult = {
  type: 'result';
  role: 'first' | 'second';
  result?: { revision: number; snapshot: CalibrationHarnessSnapshot };
  error?: {
    name: string;
    message: string;
    code?: unknown;
    expectedRevision?: unknown;
    currentRevision?: unknown;
  };
};

type FixtureMessage = { type: 'ready'; role: 'first' | 'second' } | WorkerProgress | WorkerResult;

const concurrentFixture = fileURLToPath(new URL('./calibrationHarnessStore.concurrent.fixture.mjs', import.meta.url));
const concurrentStoreSource = fileURLToPath(new URL('./calibrationHarnessStore.ts', import.meta.url));
const serverVitestConfig = fileURLToPath(new URL('../../vitest.config.ts', import.meta.url));

function waitFor<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function startConcurrentWorker(
  filename: string,
  role: 'first' | 'second',
  expectedRevision: number | null,
  label: string,
  barrier: SharedArrayBuffer,
  holdAfterCurrentRead: boolean,
  timeline: string[],
): {
  worker: Worker;
  messages: FixtureMessage[];
  waitForMessage: (predicate: (message: FixtureMessage) => boolean) => Promise<FixtureMessage>;
  result: Promise<WorkerResult>;
} {
  const worker = new Worker(concurrentFixture, {
    execArgv: ['--import', 'tsx'],
    workerData: {
      filename,
      storePath: concurrentStoreSource,
      viteConfig: serverVitestConfig,
      role,
      ownerId: 'owner-a',
      harnessId: 'harness-a',
      expectedRevision,
      label,
      barrier,
      holdAfterCurrentRead,
      timeoutMs: 5_000,
    },
  });
  const messages: FixtureMessage[] = [];
  const waiters: Array<{
    predicate: (message: FixtureMessage) => boolean;
    resolve: (message: FixtureMessage) => void;
  }> = [];
  let rejectResult: (reason: unknown) => void = () => undefined;
  const result = new Promise<WorkerResult>((resolve, reject) => {
    rejectResult = reject;
    worker.on('message', (message: FixtureMessage) => {
      messages.push(message);
      if (message.type === 'progress') {
        timeline.push(`${message.role}:${message.stage}`);
      }
      for (const waiter of waiters.splice(0)) {
        if (waiter.predicate(message)) {
          waiter.resolve(message);
        } else {
          waiters.push(waiter);
        }
      }
      if (message.type === 'result') {
        resolve(message);
      }
    });
  });
  worker.once('error', rejectResult);
  worker.once('exit', (code) => {
    if (code !== 0 && !messages.some((message) => message.type === 'result')) {
      rejectResult(new Error(`concurrency fixture ${role} exited with code ${code}`));
    }
  });
  return {
    worker,
    messages,
    waitForMessage(predicate) {
      const existing = messages.find(predicate);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      return new Promise<FixtureMessage>((resolve) => waiters.push({ predicate, resolve }));
    },
    result,
  };
}

async function contendForPublish(
  filename: string,
  expectedRevision: number | null,
  firstLabel: string,
  secondLabel: string,
): Promise<{ first: WorkerResult; second: WorkerResult; timeline: string[] }> {
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const timeline: string[] = [];
  const first = startConcurrentWorker(filename, 'first', expectedRevision, firstLabel, barrier, true, timeline);
  let second: ReturnType<typeof startConcurrentWorker> | undefined;
  try {
    await waitFor(first.waitForMessage((message) => message.type === 'ready'), 'first worker readiness');
    first.worker.postMessage('publish');
    await waitFor(
      first.waitForMessage((message) => message.type === 'progress' && message.stage === 'after-current-read'),
      'first current read',
    );

    second = startConcurrentWorker(filename, 'second', expectedRevision, secondLabel, barrier, false, timeline);
    await waitFor(second.waitForMessage((message) => message.type === 'ready'), 'second worker readiness');
    second.worker.postMessage('publish');
    await waitFor(
      second.waitForMessage((message) => message.type === 'progress' && message.stage === 'before-write-authority'),
      'second write attempt',
    );

    Atomics.store(new Int32Array(barrier), 0, 1);
    Atomics.notify(new Int32Array(barrier), 0, 1);
    const [firstResult, secondResult] = await waitFor(Promise.all([first.result, second.result]), 'concurrent publish results');
    return { first: firstResult, second: secondResult, timeline };
  } finally {
    Atomics.store(new Int32Array(barrier), 0, 1);
    Atomics.notify(new Int32Array(barrier), 0);
    await Promise.all([first.worker.terminate(), second?.worker.terminate()]);
  }
}

describe('createCalibrationHarnessStore', () => {
  it('requires an explicit create-only precondition before writing a canonical snapshot', () => {
    const database = createExclusiveDatabase();
    try {
      const store = createStore(database);
      const original = snapshot('original');

      expect(store.publish('owner-a', 'harness-a', null, original)).toEqual({ revision: 1, snapshot: original });
      expect(currentRow(database, 'owner-a', 'harness-a')).toEqual({
        revision: 1,
        snapshot_json: JSON.stringify({
          assets: [],
          cases: [],
          datasets: [],
          futureMetadata: {
            deliberatelyUnordered: { a: ['original', { later: true }], z: 3 },
            label: 'original',
          },
          runs: [],
          version: 1,
        }),
      });
      expect(store.getCurrent('owner-a', 'harness-a')).toEqual({ revision: 1, snapshot: original });
      expect(store.getRevision('owner-a', 'harness-a', 1)).toEqual({ revision: 1, snapshot: original });
      expect(store.getRevision('owner-a', 'harness-a', 2)).toBeNull();
    } finally {
      database.close();
    }
  });

  it('allows exactly one independent same-base writer to publish', () => {
    const database = createExclusiveDatabase();
    const filename = database.name;
    const competingConnection = openNativeDatabase(filename);
    try {
      initializeCalibrationHarnessSchema(competingConnection);
      const first = createStore(database);
      const second = createStore(competingConnection);
      first.publish('owner-a', 'harness-a', null, snapshot('base'));
      expect(() => second.publish('owner-a', 'harness-a', null, snapshot('create-race-loser')))
        .toThrow(storeModule.CalibrationHarnessRevisionPreconditionError);

      expect(first.publish('owner-a', 'harness-a', 1, snapshot('winner'))).toEqual({
        revision: 2,
        snapshot: snapshot('winner'),
      });
      expect(() => second.publish('owner-a', 'harness-a', 1, snapshot('loser')))
        .toThrow(storeModule.CalibrationHarnessRevisionPreconditionError);
      expect(second.getCurrent('owner-a', 'harness-a')).toEqual({ revision: 2, snapshot: snapshot('winner') });
      expect(second.getRevision('owner-a', 'harness-a', 1)).toEqual({ revision: 1, snapshot: snapshot('base') });
    } finally {
      competingConnection.close();
      database.close();
    }
  });

  it('reports the expected and persisted revisions for every explicit precondition mismatch', () => {
    const database = createExclusiveDatabase();
    try {
      const store = createStore(database);
      const capture = (operation: () => unknown): unknown => {
        try {
          operation();
        } catch (error) {
          return error;
        }
        throw new Error('expected publish to fail');
      };

      const missing = capture(() => store.publish('owner-a', 'harness-a', 1, snapshot('missing')));
      expect(missing).toBeInstanceOf(storeModule.CalibrationHarnessRevisionPreconditionError);
      expect(missing).toMatchObject({
        code: storeModule.CALIBRATION_HARNESS_REVISION_PRECONDITION_CODE,
        expectedRevision: 1,
        currentRevision: null,
      });

      store.publish('owner-a', 'harness-a', null, snapshot('base'));
      const createOnly = capture(() => store.publish('owner-a', 'harness-a', null, snapshot('duplicate-create')));
      const stale = capture(() => store.publish('owner-a', 'harness-a', 2, snapshot('stale')));
      for (const failure of [createOnly, stale]) {
        expect(failure).toBeInstanceOf(storeModule.CalibrationHarnessRevisionPreconditionError);
      }
      expect(createOnly).toMatchObject({ expectedRevision: null, currentRevision: 1 });
      expect(stale).toMatchObject({ expectedRevision: 2, currentRevision: 1 });
    } finally {
      database.close();
    }
  });

  it('fails closed instead of using a nested savepoint for publish', () => {
    const database = createExclusiveDatabase();
    try {
      const store = createStore(database);
      database.transaction(() => {
        let failure: unknown;
        try {
          store.publish('owner-a', 'harness-a', null, snapshot('nested'));
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(storeModule.CalibrationHarnessRevisionPreconditionError);
        expect((failure as Error).message).toMatch(/top-level SQLite connection/i);
      })();
      expect(store.getCurrent('owner-a', 'harness-a')).toBeNull();
    } finally {
      database.close();
    }
  });

  it('serializes concurrent create-only contenders and returns a typed precondition conflict to the loser', async () => {
    const setup = createExclusiveDatabase();
    const filename = setup.name;
    setup.close();

    const outcome = await contendForPublish(filename, null, 'create-winner', 'create-loser');
    expect(outcome.timeline).toEqual([
      'first:before-write-authority',
      'first:after-write-authority',
      'first:after-current-read',
      'second:before-write-authority',
      'second:after-write-authority',
      'second:after-current-read',
    ]);
    expect(outcome.first.result).toEqual({ revision: 1, snapshot: workerSnapshot('create-winner') });
    expect(outcome.second.error).toMatchObject({
      code: 'CALIBRATION_HARNESS_REVISION_PRECONDITION',
      expectedRevision: null,
      currentRevision: 1,
    });

    const database = openNativeDatabase(filename);
    try {
      const store = createStore(database);
      expect(store.getCurrent('owner-a', 'harness-a')).toEqual({ revision: 1, snapshot: workerSnapshot('create-winner') });
      expect(store.getRevision('owner-a', 'harness-a', 1)).toEqual({ revision: 1, snapshot: workerSnapshot('create-winner') });
      expect(store.getRevision('owner-a', 'harness-a', 2)).toBeNull();
    } finally {
      database.close();
    }
  });

  it('serializes concurrent exact-revision contenders without overwriting history', async () => {
    const setup = createExclusiveDatabase();
    const filename = setup.name;
    try {
      createStore(setup).publish('owner-a', 'harness-a', null, snapshot('base'));
    } finally {
      setup.close();
    }

    const outcome = await contendForPublish(filename, 1, 'update-winner', 'update-loser');
    expect(outcome.timeline).toEqual([
      'first:before-write-authority',
      'first:after-write-authority',
      'first:after-current-read',
      'second:before-write-authority',
      'second:after-write-authority',
      'second:after-current-read',
    ]);
    expect(outcome.first.result).toEqual({ revision: 2, snapshot: workerSnapshot('update-winner') });
    expect(outcome.second.error).toMatchObject({
      code: 'CALIBRATION_HARNESS_REVISION_PRECONDITION',
      expectedRevision: 1,
      currentRevision: 2,
    });

    const database = openNativeDatabase(filename);
    try {
      const store = createStore(database);
      expect(store.getCurrent('owner-a', 'harness-a')).toEqual({ revision: 2, snapshot: workerSnapshot('update-winner') });
      expect(store.getRevision('owner-a', 'harness-a', 1)).toEqual({ revision: 1, snapshot: snapshot('base') });
      expect(store.getRevision('owner-a', 'harness-a', 2)).toEqual({ revision: 2, snapshot: workerSnapshot('update-winner') });
      expect(store.getRevision('owner-a', 'harness-a', 3)).toBeNull();
    } finally {
      database.close();
    }
  });

  it('rejects stale, unbased, empty, malformed, and malformed-precondition writes without overwrite', () => {
    const database = createExclusiveDatabase();
    try {
      const store = createStore(database);
      const original = snapshot('original');
      store.publish('owner-a', 'harness-a', null, original);

      const rejectedWrites: Array<() => unknown> = [
        () => store.publish('owner-a', 'harness-a', null, snapshot('unbased')),
        () => store.publish('owner-a', 'harness-a', 2, snapshot('stale')),
        () => store.publish('owner-a', 'harness-a', 1, {} as CalibrationHarnessSnapshot),
        () => store.publish('owner-a', 'harness-a', undefined as never, snapshot('missing-precondition')),
        () => store.publish('owner-a', 'harness-a', 0, snapshot('zero')),
        () => store.publish('owner-a', 'harness-a', 1.5, snapshot('fraction')),
        () => store.publish('owner-a', 'harness-a', Number.MAX_SAFE_INTEGER + 1, snapshot('unsafe')),
        () => store.publish('', 'harness-a', 1, snapshot('bad-owner')),
        () => store.publish('owner-a', '', 1, snapshot('bad-harness')),
      ];

      for (const rejectedWrite of rejectedWrites) {
        expect(rejectedWrite).toThrow();
        expect(store.getCurrent('owner-a', 'harness-a')).toEqual({ revision: 1, snapshot: original });
        expect(store.getRevision('owner-a', 'harness-a', 1)).toEqual({ revision: 1, snapshot: original });
      }
    } finally {
      database.close();
    }
  });

  it('filters every current and historical read by owner and preserves each immutable revision across reopen', () => {
    const database = createExclusiveDatabase();
    const filename = database.name;
    try {
      const store = createStore(database);
      const first = snapshot('first');
      const second = snapshot('second');
      const other = snapshot('other-owner');
      store.publish('owner-a', 'harness-a', null, first);
      store.publish('owner-a', 'harness-a', 1, second);
      store.publish('owner-b', 'harness-a', null, other);

      expect(store.getCurrent('owner-a', 'harness-a')).toEqual({ revision: 2, snapshot: second });
      expect(store.getRevision('owner-a', 'harness-a', 1)).toEqual({ revision: 1, snapshot: first });
      expect(store.getCurrent('owner-b', 'harness-a')).toEqual({ revision: 1, snapshot: other });
      expect(store.getRevision('owner-b', 'harness-a', 2)).toBeNull();
    } finally {
      database.close();
    }

    const reopened = openNativeDatabase(filename);
    try {
      initializeCalibrationHarnessSchema(reopened);
      const store = createStore(reopened);
      expect(store.getCurrent('owner-a', 'harness-a')).toEqual({ revision: 2, snapshot: snapshot('second') });
      expect(store.getRevision('owner-a', 'harness-a', 1)).toEqual({ revision: 1, snapshot: snapshot('first') });
      expect(store.getRevision('owner-b', 'harness-a', 1)).toEqual({ revision: 1, snapshot: snapshot('other-owner') });
    } finally {
      reopened.close();
    }
  });

  it('keeps an unrelated SQLite write lock distinct from a revision precondition conflict', () => {
    const database = createExclusiveDatabase();
    const lockingConnection = openNativeDatabase(database.name);
    try {
      const store = createStore(database);
      database.pragma('busy_timeout = 1');
      lockingConnection.exec('BEGIN IMMEDIATE');

      let failure: unknown;
      try {
        store.publish('owner-a', 'harness-a', null, snapshot('blocked-by-lock'));
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(storeModule.CalibrationHarnessRevisionPreconditionError);
      expect(failure).toMatchObject({ code: 'SQLITE_BUSY' });
      expect(store.getCurrent('owner-a', 'harness-a')).toBeNull();
    } finally {
      if (lockingConnection.inTransaction) {
        lockingConnection.exec('ROLLBACK');
      }
      lockingConnection.close();
      database.close();
    }
  });

  it('rolls back the current replacement when immutable history insertion fails', () => {
    const database = createExclusiveDatabase();
    try {
      const store = createStore(database);
      const first = snapshot('first');
      store.publish('owner-a', 'harness-a', null, first);
      database.exec(`
        CREATE TRIGGER reject_second_harness_revision
        BEFORE INSERT ON mpc_harness_revisions
        WHEN NEW.owner_id = 'owner-a' AND NEW.harness_id = 'harness-a' AND NEW.revision = 2
        BEGIN
          SELECT RAISE(ABORT, 'forced revision history failure');
        END;
      `);

      let failure: unknown;
      try {
        store.publish('owner-a', 'harness-a', 1, snapshot('must-rollback'));
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(storeModule.CalibrationHarnessRevisionPreconditionError);
      expect((failure as Error).message).toMatch(/forced revision history failure/i);
      expect(store.getCurrent('owner-a', 'harness-a')).toEqual({ revision: 1, snapshot: first });
      expect(store.getRevision('owner-a', 'harness-a', 2)).toBeNull();
    } finally {
      database.close();
    }
  });

  it('fails closed before deserializing corrupt persisted metadata', () => {
    const database = createExclusiveDatabase();
    try {
      const store = createStore(database);
      store.publish('owner-a', 'harness-a', null, snapshot('safe'));
      database.prepare(`
        UPDATE mpc_harnesses
        SET snapshot_json = CAST(zeroblob(?) AS TEXT)
        WHERE owner_id = ? AND harness_id = ?
      `).run(CALIBRATION_HARNESS_LIMITS.maxMetadataBytes + 1, 'owner-a', 'harness-a');

      expect(() => store.getCurrent('owner-a', 'harness-a')).toThrow(/metadata.*limit/i);
    } finally {
      database.close();
    }
  });
});
