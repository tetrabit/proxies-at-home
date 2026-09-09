#!/usr/bin/env node
/**
 * Real-browser probe for td-73737f / G02.
 *
 * This deliberately bundles the production cardCanvasWorker module in memory
 * and invokes renderCardWithOverridesWorker concurrently in one browser realm.
 * It does not mock OffscreenCanvas, WebGL, or convertToBlob; the temporary
 * convertToBlob wrapper only records native promise overlap and immediately
 * forwards to the original browser implementation.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRelativePath = 'client/src/helpers/cardCanvasWorker.ts';
const sourcePath = path.join(repoRoot, sourceRelativePath);
const evidenceRoot = path.join(repoRoot, '.review-artifacts', 'shared-context-overlap-01');
const attemptName = process.argv.find((value) => value.startsWith('--attempt='))?.slice('--attempt='.length) ?? 'attempt-01';
if (!/^[a-z0-9-]+$/i.test(attemptName)) throw new Error('attempt name must contain only letters, digits, and hyphens');
const attemptRoot = path.join(evidenceRoot, attemptName);
const chromePath = '/usr/bin/google-chrome-stable';
const probeRoute = '/__td_73737f_shared_context_probe.html';

function command(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function markdownReport(report) {
  const lines = [
    '# Shared-context export overlap real-browser probe',
    '',
    `- **Disposition:** ${report.disposition.toUpperCase()}`,
    `- **Executed at:** ${report.executedAt}`,
    `- **Source commit/tree:** \`${report.provenance.commit}\` / \`${report.provenance.tree}\``,
    `- **Production source:** \`${report.provenance.source.relativePath}\` (working SHA-256 \`${report.provenance.source.workingSha256}\`, committed blob \`${report.provenance.source.committedBlob}\`)`,
    `- **Runtime:** Playwright ${report.provenance.runtime.playwright}; ${report.provenance.runtime.chrome}; WebGL ${report.runtime?.webglVersion ?? 'unavailable'}; renderer ${report.runtime?.webglRenderer ?? 'unavailable'}`,
    '',
    '## Method',
    '',
    'The browser loaded an in-memory esbuild bundle rooted at the production `cardCanvasWorker.ts` module from a loopback-only server. It made serial baselines, then invoked the same exported `renderCardWithOverridesWorker` twice without awaiting the first call. Dimensions and solid colors alternate per pair. `OffscreenCanvas.prototype.convertToBlob` was wrapped only to record native invocation/settlement chronology; it immediately called the original browser method and added no delay or altered return value.',
    '',
    '## Result',
    '',
  ];
  if (report.disposition === 'safe') {
    lines.push(
      `All ${report.runtime.pairCount} overlapping pairs started their second native conversion while the first native conversion was unresolved. Every overlapping output matched its serial baseline at every decoded RGBA8 pixel, retained its requested dimensions, and remained the requested solid-color attribution.`,
      '',
      'This is a bounded runtime result, not a cross-browser proof: the tested Chrome/WebGL implementation snapshots output safely for this production function and these raster sizes. It does not justify a global mutex without evidence from a different runtime or workload.'
    );
  } else if (report.disposition === 'unsafe') {
    lines.push('At least one overlap assertion failed. Inspect `result.json` for the pair and pixel evidence; an exclusive lease should be considered before concurrent same-realm calls are allowed.');
  } else {
    lines.push(`The real-browser probe was blocked: ${report.blocker}`);
  }
  lines.push('', '## Pair summaries', '');
  for (const pair of report.runtime?.pairs ?? []) {
    lines.push(`- ${pair.name}: overlap=${pair.nativeOverlapObserved}; A ${pair.actual.A.width}x${pair.actual.A.height}, max Δ serial=${pair.actual.A.maxDeltaFromSerial}, max Δ expected=${pair.actual.A.maxDeltaFromExpected}; B ${pair.actual.B.width}x${pair.actual.B.height}, max Δ serial=${pair.actual.B.maxDeltaFromSerial}, max Δ expected=${pair.actual.B.maxDeltaFromExpected}.`);
  }
  lines.push('', '## Exact command', '', '```sh', `node scripts/probe-shared-context-overlap.mjs --attempt=${attemptName}`, '```', '');
  return `${lines.join('\n')}\n`;
}

const sourceBytes = await readFile(sourcePath);
const report = {
  schemaVersion: 1,
  task: 'td-73737f',
  finding: 'G02',
  disposition: 'blocked',
  executedAt: new Date().toISOString(),
  blocker: null,
  provenance: {
    commit: command('git', ['rev-parse', 'HEAD']),
    tree: command('git', ['rev-parse', 'HEAD^{tree}']),
    source: {
      relativePath: sourceRelativePath,
      workingSha256: sha256(sourceBytes),
      committedBlob: command('git', ['rev-parse', `HEAD:${sourceRelativePath}`]),
    },
    runtime: {
      node: process.version,
      playwright: command('node', ['-p', "require('./node_modules/playwright/package.json').version"]),
      chrome: command(chromePath, ['--version']),
      browserExecutable: chromePath,
      esbuild: command('node', ['-p', "require('./node_modules/esbuild/package.json').version"]),
    },
  },
  runtime: null,
};

try {
  await mkdir(evidenceRoot, { recursive: true });
  await mkdir(attemptRoot, { recursive: false });
  await mkdir(path.join(attemptRoot, 'browser-profile'), { recursive: false });
} catch (error) {
  // Never modify an existing attempt directory: it may belong to another lane.
  report.blocker = `Refusing to overwrite evidence/profile path: ${error instanceof Error ? error.message : String(error)}`;
  console.error(report.blocker);
  process.exitCode = 2;
  process.exit();
}

let server;
let browser;
try {
  const bundled = await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: [sourceRelativePath],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    define: { 'import.meta.env.DEV': 'false' },
    loader: { '.frag': 'text' },
    write: false,
  });
  const moduleOutput = bundled.outputFiles[0];
  if (!moduleOutput) throw new Error('esbuild emitted no JavaScript module');
  server = createHttpServer((request, response) => {
    if (request.url === probeRoute) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><meta charset="utf-8"><title>td-73737f probe</title><main>local probe</main>');
      return;
    }
    if (request.url === '/production-module.mjs') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(moduleOutput.contents);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Probe server did not bind a TCP loopback address');
  const origin = `http://127.0.0.1:${address.port}`;

  browser = await chromium.launchPersistentContext(path.join(attemptRoot, 'browser-profile'), {
    executablePath: chromePath,
    headless: true,
    ignoreHTTPSErrors: false,
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${origin}${probeRoute}`, { waitUntil: 'load' });

  const probe = await page.evaluate(async () => {
    const production = await import('/production-module.mjs');
    const params = production.overridesToRenderParams({});
    const telemetry = [];
    const originalConvertToBlob = OffscreenCanvas.prototype.convertToBlob;
    let activeNativeConversions = 0;
    let maxActiveNativeConversions = 0;
    let phase = 'setup';
    OffscreenCanvas.prototype.convertToBlob = function(options) {
      const startedWithActive = activeNativeConversions;
      activeNativeConversions += 1;
      maxActiveNativeConversions = Math.max(maxActiveNativeConversions, activeNativeConversions);
      const event = { phase, kind: 'start', startedWithActive, activeAfter: activeNativeConversions };
      telemetry.push(event);
      const nativePromise = originalConvertToBlob.call(this, options);
      nativePromise.then(
        () => telemetry.push({ phase, kind: 'settle', activeBefore: activeNativeConversions }),
        () => telemetry.push({ phase, kind: 'reject', activeBefore: activeNativeConversions }),
      ).finally(() => { activeNativeConversions -= 1; });
      return nativePromise;
    };

    const colors = [
      [229, 41, 41, 255],
      [25, 203, 155, 255],
      [84, 73, 239, 255],
      [245, 146, 31, 255],
    ];
    const pairs = [
      { name: 'pair-1', A: { width: 41, height: 29, color: colors[0] }, B: { width: 67, height: 37, color: colors[1] } },
      { name: 'pair-2', A: { width: 53, height: 31, color: colors[2] }, B: { width: 73, height: 43, color: colors[3] } },
    ];

    async function sourceBitmap(spec) {
      const canvas = new OffscreenCanvas(spec.width, spec.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('2d canvas unavailable for deterministic source');
      ctx.fillStyle = `rgba(${spec.color.join(',')})`;
      ctx.fillRect(0, 0, spec.width, spec.height);
      return createImageBitmap(canvas);
    }
    async function render(spec) {
      const bitmap = await sourceBitmap(spec);
      try { return await production.renderCardWithOverridesWorker(bitmap, params); }
      finally { bitmap.close(); }
    }
    async function pixels(blob) {
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('2d canvas unavailable for output readback');
        ctx.drawImage(bitmap, 0, 0);
        return { width: bitmap.width, height: bitmap.height, data: Array.from(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data) };
      } finally { bitmap.close(); }
    }
    function inspect(actual, baseline, spec) {
      if (actual.width !== spec.width || actual.height !== spec.height) {
        throw new Error(`dimension mismatch: expected ${spec.width}x${spec.height}, got ${actual.width}x${actual.height}`);
      }
      if (actual.data.length !== baseline.data.length) throw new Error('serial/overlap pixel length mismatch');
      let maxDeltaFromSerial = 0;
      let maxDeltaFromExpected = 0;
      for (let index = 0; index < actual.data.length; index += 4) {
        for (let channel = 0; channel < 4; channel += 1) {
          maxDeltaFromSerial = Math.max(maxDeltaFromSerial, Math.abs(actual.data[index + channel] - baseline.data[index + channel]));
          maxDeltaFromExpected = Math.max(maxDeltaFromExpected, Math.abs(actual.data[index + channel] - spec.color[channel]));
        }
      }
      const center = ((Math.floor(actual.height / 2) * actual.width) + Math.floor(actual.width / 2)) * 4;
      return {
        width: actual.width,
        height: actual.height,
        expectedColor: spec.color,
        centerPixel: actual.data.slice(center, center + 4),
        maxDeltaFromSerial,
        maxDeltaFromExpected,
      };
    }
    try {
      const webglProbe = new OffscreenCanvas(2, 2).getContext('webgl2');
      if (!webglProbe) throw new Error('real browser lacks OffscreenCanvas WebGL2');
      const debugInfo = webglProbe.getExtension('WEBGL_debug_renderer_info');
      const webglVersion = webglProbe.getParameter(webglProbe.VERSION);
      const webglRenderer = debugInfo
        ? webglProbe.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
        : webglProbe.getParameter(webglProbe.RENDERER);

      const results = [];
      for (const pair of pairs) {
        phase = `${pair.name}-serial`;
        const serialA = await pixels(await render(pair.A));
        const serialB = await pixels(await render(pair.B));

        phase = `${pair.name}-overlap`;
        const telemetryStart = telemetry.length;
        const overlapA = render(pair.A);
        const overlapB = render(pair.B);
        const [blobA, blobB] = await Promise.all([overlapA, overlapB]);
        const events = telemetry.slice(telemetryStart);
        const starts = events.filter((event) => event.kind === 'start');
        const nativeOverlapObserved = starts.length === 2 && starts[1].startedWithActive >= 1;
        if (!nativeOverlapObserved) throw new Error(`${pair.name}: native convertToBlob calls did not overlap`);
        const actualA = inspect(await pixels(blobA), serialA, pair.A);
        const actualB = inspect(await pixels(blobB), serialB, pair.B);
        if (actualA.maxDeltaFromSerial !== 0 || actualB.maxDeltaFromSerial !== 0) {
          throw new Error(`${pair.name}: overlap output differs from serial baseline`);
        }
        // A solid source must retain recognizable requested-color attribution; a tolerance
        // accommodates browser color conversion while serial equality catches cross-call swaps.
        if (actualA.maxDeltaFromExpected > 8 || actualB.maxDeltaFromExpected > 8) {
          throw new Error(`${pair.name}: output no longer matches its requested solid color`);
        }
        results.push({ name: pair.name, nativeOverlapObserved, events, actual: { A: actualA, B: actualB } });
      }
      return { webglVersion, webglRenderer, pairCount: results.length, maxActiveNativeConversions, pairs: results };
    } finally {
      OffscreenCanvas.prototype.convertToBlob = originalConvertToBlob;
    }
  });
  if (pageErrors.length) throw new Error(`browser page errors: ${pageErrors.join(' | ')}`);
  report.runtime = probe;
  report.disposition = 'safe';
} catch (error) {
  report.blocker = error instanceof Error ? error.stack || error.message : String(error);
  report.disposition = report.runtime ? 'unsafe' : 'blocked';
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

await writeFile(path.join(attemptRoot, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(attemptRoot, 'REPORT.md'), markdownReport(report));
console.log(JSON.stringify({ disposition: report.disposition, evidenceRoot: attemptRoot, blocker: report.blocker }, null, 2));
if (report.disposition !== 'safe') process.exitCode = report.disposition === 'blocked' ? 2 : 1;
