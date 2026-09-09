#!/usr/bin/env node
/**
 * Real-browser ownership probe for td-a48d83.
 *
 * Bundles the current production worker module in memory, serves it only on
 * loopback, and instruments native WebGL calls for telemetry. It never mocks
 * rendering, resource creation, conversion, or context loss.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRelativePath = 'client/src/helpers/cardCanvasWorker.ts';
const sourcePath = path.join(repoRoot, sourceRelativePath);
const attemptName = process.argv.find((value) => value.startsWith('--attempt='))?.slice('--attempt='.length);
const route = '/__td_a48d83_pipeline_reuse_probe.html';

class BlockedError extends Error {}
class AssertionFailure extends Error {}

if (!attemptName || !/^[a-z0-9-]+$/i.test(attemptName)) {
  throw new Error('pass a unique --attempt=<letters-digits-hyphens>');
}

function command(executable, args) {
  const result = spawnSync(executable, args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${executable} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function browserExecutable() {
  for (const candidate of ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next explicitly local browser path.
    }
  }
  throw new BlockedError('No supported local Chromium executable was found.');
}

function markdownReport(report) {
  const lines = [
    '# Immutable WebGL pipeline reuse real-browser probe',
    '',
    `- **Disposition:** ${report.disposition.toUpperCase()}`,
    `- **Executed at:** ${report.executedAt}`,
    `- **Source commit/tree:** \`${report.provenance.commit}\` / \`${report.provenance.tree}\``,
    `- **Production source:** \`${report.provenance.source.relativePath}\` (working SHA-256 \`${report.provenance.source.workingSha256}\`, committed blob \`${report.provenance.source.committedBlob}\`)`,
    `- **Runtime:** Node ${report.provenance.runtime.node}; Playwright ${report.provenance.runtime.playwright}; ${report.provenance.runtime.chrome}; esbuild ${report.provenance.runtime.esbuild}`,
    '',
    '## Method',
    '',
    'A loopback-only page imported an in-memory esbuild bundle rooted at the production `cardCanvasWorker.ts` module. It rendered deterministic solid-color `ImageBitmap`s sequentially. The probe wrapped methods on the actual manager-created WebGL contexts only to count and identify native resource API calls; all wrappers immediately forwarded to the original browser APIs. It verified decoded output dimensions and every RGBA8 output pixel, invoked `WEBGL_lose_context` only when the real extension was available, then rendered again through the production export.',
    '',
    '## Result',
    '',
  ];
  if (report.disposition === 'passed') {
    const runtime = report.runtime;
    lines.push(
      `WebGL ${runtime.webgl.version}; renderer ${runtime.webgl.renderer}. Before loss, two renders used one manager context and made exactly one immutable pipeline setup: shaders=${runtime.beforeLoss.create.shader}, programs=${runtime.beforeLoss.create.program}, VAOs=${runtime.beforeLoss.create.vertexArray}, buffers=${runtime.beforeLoss.create.buffer}.`,
      `The loss event explicitly deleted the owned first program/VAO/buffer exactly once. A third render created a second context and raised aggregate setup counts to shaders=${runtime.afterRecreate.create.shader}, programs=${runtime.afterRecreate.create.program}, VAOs=${runtime.afterRecreate.create.vertexArray}, buffers=${runtime.afterRecreate.create.buffer}.`,
      `Decoded PNG output retained requested dimensions and solid-color attribution: first ${runtime.outputs.first.width}×${runtime.outputs.first.height} max delta ${runtime.outputs.first.maxDelta}; second ${runtime.outputs.second.width}×${runtime.outputs.second.height} max delta ${runtime.outputs.second.maxDelta}; recreated ${runtime.outputs.recreated.width}×${runtime.outputs.recreated.height} max delta ${runtime.outputs.recreated.maxDelta}.`,
    );
  } else {
    lines.push(`Runtime evidence is ${report.disposition}: ${report.blocker}`);
  }
  lines.push('', '## Exact command', '', '```sh', `node scripts/probe-immutable-pipeline-reuse.mjs --attempt=${attemptName}`, '```', '');
  return `${lines.join('\n')}\n`;
}

const sourceBytes = await readFile(sourcePath);
const evidenceRoot = path.join(repoRoot, '.review-artifacts', `pipeline-reuse-${attemptName}`);
const profileRoot = path.join(evidenceRoot, 'browser-profile');
const report = {
  schemaVersion: 1,
  task: 'td-a48d83',
  disposition: 'blocked',
  executedAt: new Date().toISOString(),
  blocker: null,
  provenance: {
    command: `node scripts/probe-immutable-pipeline-reuse.mjs --attempt=${attemptName}`,
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
      esbuild: command('node', ['-p', "require('./node_modules/esbuild/package.json').version"]),
      chrome: null,
      browserExecutable: null,
    },
  },
  runtime: null,
};

try {
  await mkdir(evidenceRoot, { recursive: false });
  await mkdir(profileRoot, { recursive: false });
} catch (error) {
  throw new Error(`Refusing to overwrite evidence/profile path: ${error instanceof Error ? error.message : String(error)}`);
}

let server;
let browser;
try {
  const executablePath = await browserExecutable();
  report.provenance.runtime.browserExecutable = executablePath;
  report.provenance.runtime.chrome = command(executablePath, ['--version']);
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
  const bundle = bundled.outputFiles[0];
  if (!bundle) throw new BlockedError('esbuild emitted no production module.');

  server = createServer((request, response) => {
    if (request.url === route) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><meta charset="utf-8"><title>td-a48d83 probe</title><main>local probe</main>');
      return;
    }
    if (request.url === '/production-module.mjs') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(bundle.contents);
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
  if (!address || typeof address === 'string') throw new BlockedError('Loopback probe server did not bind a TCP address.');
  const origin = `http://127.0.0.1:${address.port}`;

  browser = await chromium.launchPersistentContext(profileRoot, {
    executablePath,
    headless: true,
    ignoreHTTPSErrors: false,
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${origin}${route}`, { waitUntil: 'load' });

  const runtime = await page.evaluate(async () => {
    class ProbeBlocked extends Error {}
    class ProbeAssertionFailure extends Error {}
    const production = await import('/production-module.mjs');
    const params = production.overridesToRenderParams({});
    const originalGetContext = OffscreenCanvas.prototype.getContext;
    const contexts = [];
    const resources = new WeakMap();
    let nextResourceId = 1;

    function identity(resource) {
      if (!resource || (typeof resource !== 'object' && typeof resource !== 'function')) return null;
      let id = resources.get(resource);
      if (!id) {
        id = nextResourceId++;
        resources.set(resource, id);
      }
      return id;
    }
    function counters() {
      return {
        create: { shader: 0, program: 0, vertexArray: 0, buffer: 0, texture: 0 },
        delete: { shader: [], program: [], vertexArray: [], buffer: [], texture: [] },
      };
    }
    function instrument(gl) {
      const telemetry = counters();
      const wrapCreate = (method, key) => {
        const original = gl[method].bind(gl);
        gl[method] = (...args) => {
          const resource = original(...args);
          telemetry.create[key] += 1;
          identity(resource);
          return resource;
        };
      };
      const wrapDelete = (method, key) => {
        const original = gl[method].bind(gl);
        gl[method] = (resource) => {
          telemetry.delete[key].push(identity(resource));
          return original(resource);
        };
      };
      wrapCreate('createShader', 'shader');
      wrapCreate('createProgram', 'program');
      wrapCreate('createVertexArray', 'vertexArray');
      wrapCreate('createBuffer', 'buffer');
      wrapCreate('createTexture', 'texture');
      wrapDelete('deleteShader', 'shader');
      wrapDelete('deleteProgram', 'program');
      wrapDelete('deleteVertexArray', 'vertexArray');
      wrapDelete('deleteBuffer', 'buffer');
      wrapDelete('deleteTexture', 'texture');
      return telemetry;
    }

    OffscreenCanvas.prototype.getContext = function(type, options) {
      const context = originalGetContext.call(this, type, options);
      if (type === 'webgl2' && context) contexts.push({ canvas: this, gl: context, telemetry: instrument(context) });
      return context;
    };

    async function bitmap(spec) {
      const canvas = new OffscreenCanvas(spec.width, spec.height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new ProbeBlocked('Real browser lacks OffscreenCanvas 2D support for source fixtures.');
      context.fillStyle = `rgba(${spec.color.join(',')})`;
      context.fillRect(0, 0, spec.width, spec.height);
      return createImageBitmap(canvas);
    }
    async function render(spec) {
      const source = await bitmap(spec);
      try {
        return await production.renderCardWithOverridesWorker(source, params);
      } finally {
        source.close();
      }
    }
    async function inspect(blob, spec) {
      const output = await createImageBitmap(blob);
      try {
        if (output.width !== spec.width || output.height !== spec.height) {
          throw new ProbeAssertionFailure(`Expected ${spec.width}x${spec.height}, got ${output.width}x${output.height}.`);
        }
        const canvas = new OffscreenCanvas(output.width, output.height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new ProbeBlocked('Real browser lacks OffscreenCanvas 2D support for output inspection.');
        context.drawImage(output, 0, 0);
        const pixels = context.getImageData(0, 0, output.width, output.height).data;
        let maxDelta = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          for (let channel = 0; channel < 4; channel += 1) {
            maxDelta = Math.max(maxDelta, Math.abs(pixels[index + channel] - spec.color[channel]));
          }
        }
        if (maxDelta > 8) throw new ProbeAssertionFailure(`Output color attribution drifted by ${maxDelta}.`);
        return { width: output.width, height: output.height, expectedColor: spec.color, maxDelta };
      } finally {
        output.close();
      }
    }
    function snapshot(context) {
      return structuredClone(context.telemetry);
    }
    function assert(condition, message) {
      if (!condition) throw new ProbeAssertionFailure(message);
    }

    const first = { width: 43, height: 31, color: [229, 41, 41, 255] };
    const second = { width: 67, height: 37, color: [25, 203, 155, 255] };
    const recreated = { width: 53, height: 29, color: [84, 73, 239, 255] };
    try {
      const firstOutput = await inspect(await render(first), first);
      const secondOutput = await inspect(await render(second), second);
      if (contexts.length !== 1) throw new ProbeAssertionFailure(`Expected one manager WebGL context before loss, got ${contexts.length}.`);
      const initial = contexts[0];
      const beforeLoss = snapshot(initial);
      assert(beforeLoss.create.shader === 2, `Expected 2 shader creations before loss, got ${beforeLoss.create.shader}.`);
      assert(beforeLoss.create.program === 1, `Expected 1 program creation before loss, got ${beforeLoss.create.program}.`);
      assert(beforeLoss.create.vertexArray === 1, `Expected 1 VAO creation before loss, got ${beforeLoss.create.vertexArray}.`);
      assert(beforeLoss.create.buffer === 1, `Expected 1 buffer creation before loss, got ${beforeLoss.create.buffer}.`);
      assert(beforeLoss.create.texture === 2 && beforeLoss.delete.texture.length === 2, 'Expected one created and deleted per-render texture for each initial render.');
      assert(beforeLoss.delete.shader.length === 2, `Expected setup shaders deleted after link, got ${beforeLoss.delete.shader.length}.`);
      assert(beforeLoss.delete.program.length === 0 && beforeLoss.delete.vertexArray.length === 0 && beforeLoss.delete.buffer.length === 0, 'Immutable pipeline was deleted before context loss.');

      const debugInfo = initial.gl.getExtension('WEBGL_debug_renderer_info');
      const webgl = {
        version: initial.gl.getParameter(initial.gl.VERSION),
        renderer: debugInfo ? initial.gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : initial.gl.getParameter(initial.gl.RENDERER),
      };
      const extension = initial.gl.getExtension('WEBGL_lose_context');
      if (!extension) throw new ProbeBlocked('WEBGL_lose_context is unavailable on the manager-created WebGL2 context.');
      const contextLost = new Promise((resolve) => initial.canvas.addEventListener('webglcontextlost', resolve, { once: true }));
      extension.loseContext();
      await Promise.race([
        contextLost,
        new Promise((_, reject) => setTimeout(() => reject(new ProbeBlocked('Timed out waiting for webglcontextlost.')), 5000)),
      ]);
      const afterLoss = snapshot(initial);
      assert(afterLoss.delete.program.length === 1, `Expected one explicit program deletion on loss, got ${afterLoss.delete.program.length}.`);
      assert(afterLoss.delete.vertexArray.length === 1, `Expected one explicit VAO deletion on loss, got ${afterLoss.delete.vertexArray.length}.`);
      assert(afterLoss.delete.buffer.length === 1, `Expected one explicit buffer deletion on loss, got ${afterLoss.delete.buffer.length}.`);
      assert(afterLoss.delete.shader.length === 2, 'Loss re-deleted setup shaders.');
      assert(afterLoss.delete.texture.length === 2, 'Loss re-deleted per-render textures.');

      const recreatedOutput = await inspect(await render(recreated), recreated);
      assert(contexts.length === 2, `Expected a second WebGL context after loss, got ${contexts.length}.`);
      const allContexts = contexts.map(snapshot);
      const aggregate = allContexts.reduce((total, item) => ({
        create: {
          shader: total.create.shader + item.create.shader,
          program: total.create.program + item.create.program,
          vertexArray: total.create.vertexArray + item.create.vertexArray,
          buffer: total.create.buffer + item.create.buffer,
          texture: total.create.texture + item.create.texture,
        },
      }), { create: { shader: 0, program: 0, vertexArray: 0, buffer: 0, texture: 0 } });
      assert(aggregate.create.shader === 4, `Expected 4 aggregate shader creations, got ${aggregate.create.shader}.`);
      assert(aggregate.create.program === 2, `Expected 2 aggregate program creations, got ${aggregate.create.program}.`);
      assert(aggregate.create.vertexArray === 2, `Expected 2 aggregate VAO creations, got ${aggregate.create.vertexArray}.`);
      assert(aggregate.create.buffer === 2, `Expected 2 aggregate buffer creations, got ${aggregate.create.buffer}.`);

      return {
        webgl,
        contextCount: contexts.length,
        outputs: { first: firstOutput, second: secondOutput, recreated: recreatedOutput },
        beforeLoss,
        afterLoss,
        afterRecreate: aggregate,
        contexts: allContexts,
      };
    } finally {
      OffscreenCanvas.prototype.getContext = originalGetContext;
    }
  });
  if (pageErrors.length) throw new AssertionFailure(`Browser page errors: ${pageErrors.join(' | ')}`);
  report.runtime = runtime;
  report.disposition = 'passed';
} catch (error) {
  report.blocker = error instanceof Error ? error.stack || error.message : String(error);
  report.disposition = error instanceof BlockedError || report.blocker.includes('ProbeBlocked') ? 'blocked' : 'failed';
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

await writeFile(path.join(evidenceRoot, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(evidenceRoot, 'REPORT.md'), markdownReport(report));
console.log(JSON.stringify({ disposition: report.disposition, evidenceRoot, blocker: report.blocker }, null, 2));
if (report.disposition !== 'passed') process.exitCode = report.disposition === 'blocked' ? 2 : 1;
