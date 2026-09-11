import { parentPort, workerData } from 'node:worker_threads';

import { createServer } from 'vite';

import { openNativeDatabase } from './openNativeDatabase.ts';

const barrier = new Int32Array(workerData.barrier);
const vite = await createServer({
  configFile: workerData.viteConfig,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
});
const { createCalibrationHarnessStore } = await vite.ssrLoadModule(workerData.storePath);
const database = openNativeDatabase(workerData.filename);
const progress = (stage) => {
  parentPort.postMessage({ type: 'progress', role: workerData.role, stage });
  if (stage === 'after-current-read' && workerData.holdAfterCurrentRead) {
    const result = Atomics.wait(barrier, 0, 0, workerData.timeoutMs);
    if (result === 'timed-out') {
      throw new Error('concurrency fixture barrier timed out while holding the current snapshot');
    }
  }
};
const store = createCalibrationHarnessStore(database, { onPublishProgress: progress });

parentPort.postMessage({ type: 'ready', role: workerData.role });
parentPort.once('message', async (message) => {
  if (message !== 'publish') {
    throw new Error('concurrency fixture received an unsupported command');
  }

  try {
    const result = store.publish(
      workerData.ownerId,
      workerData.harnessId,
      workerData.expectedRevision,
      {
        version: 1,
        datasets: [],
        cases: [],
        assets: [],
        runs: [],
        futureMetadata: { label: workerData.label },
      },
    );
    parentPort.postMessage({ type: 'result', role: workerData.role, result });
  } catch (error) {
    parentPort.postMessage({
      type: 'result',
      role: workerData.role,
      error: {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        code: typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
        expectedRevision: typeof error === 'object' && error !== null && 'expectedRevision' in error
          ? error.expectedRevision
          : undefined,
        currentRevision: typeof error === 'object' && error !== null && 'currentRevision' in error
          ? error.currentRevision
          : undefined,
      },
    });
  } finally {
    database.close();
    await vite.close();
    parentPort.close();
  }
});
