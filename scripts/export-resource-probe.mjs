#!/usr/bin/env node
/**
 * Bounded, real-browser resource probe for the application's high-DPI PDF export.
 *
 * It retains every fixture, profile, result, and downloaded PDF in a new evidence
 * directory. It never deletes filesystem content. The one-card workload uses the
 * real Vite application, its PDF export entrypoint, and one 1200-DPI Letter page:
 * a physically representative but bounded export (one serialized PDF worker).
 *
 * Usage:
 *   node scripts/export-resource-probe.mjs --out-dir .review-artifacts/td-7ac55e-01
 */

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createCanvas } from "canvas";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const clientRequire = createRequire(resolve(process.cwd(), "client/package.json"));
const { PDFDocument } = clientRequire("pdf-lib");

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const PORT = 4175;
const HIGH_DPI = 1200;
const VITE_URL = `http://127.0.0.1:${PORT}/`;
const SCRIPT_RELATIVE_PATH = "scripts/export-resource-probe.mjs";

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write("Usage: node scripts/export-resource-probe.mjs --out-dir <directory>\n");
  process.exitCode = 2;
}

function parseArgs(argv) {
  let outDir;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--out-dir") throw new Error(`Unknown option: ${argv[index]}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--out-dir requires a value");
    outDir = value;
    index += 1;
  }
  if (!outDir) throw new Error("--out-dir is required");
  return { outDir };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runCommand(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, { cwd: process.cwd(), encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

async function readGitProvenance() {
  const [head, tree, parentResult, indexEntries, stagedRaw, unstagedRaw, status] = await Promise.all([
    runCommand("git", ["rev-parse", "HEAD"]),
    runCommand("git", ["rev-parse", "HEAD^{tree}"]),
    runCommand("git", ["rev-parse", "HEAD^"]).then((value) => ({ status: "present", value })).catch((error) => ({ status: "unavailable", error: error.message })),
    runCommand("git", ["ls-files", "-s"]),
    runCommand("git", ["diff", "--cached", "--raw"]),
    runCommand("git", ["diff", "--raw"]),
    runCommand("git", ["status", "--porcelain=v1"]),
  ]);
  const statusLines = status.split("\n").filter(Boolean);
  return {
    source: {
      head_commit: head.trim(),
      head_tree: tree.trim(),
      parent_commit: parentResult.status === "present" ? parentResult.value.trim() : null,
      parent_status: parentResult.status,
      parent_error: parentResult.status === "present" ? null : parentResult.error,
    },
    index: {
      index_fingerprint_sha256: sha256(indexEntries),
      entry_count: indexEntries.split("\n").filter(Boolean).length,
      staged_raw: stagedRaw.split("\n").filter(Boolean),
    },
    dirty_worktree: {
      is_dirty: statusLines.length > 0,
      status_porcelain_v1: statusLines,
      unstaged_raw: unstagedRaw.split("\n").filter(Boolean),
    },
  };
}

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && path !== "..");
}

async function createNewEvidenceDirectory(outDir) {
  const repositoryRoot = resolve(process.cwd());
  const protectedRoots = [".git", ".todos", ".recovery"].map((path) => resolve(repositoryRoot, path));
  if (!isWithin(repositoryRoot, outDir)) throw new Error(`--out-dir must stay inside the repository: ${outDir}`);
  if (protectedRoots.some((protectedRoot) => isWithin(protectedRoot, outDir))) {
    throw new Error(`--out-dir is protected and cannot receive new evidence: ${outDir}`);
  }
  try {
    await stat(outDir);
    throw new Error(`--out-dir already exists; choose a new collision-free evidence directory: ${outDir}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(outDir, { recursive: false });
}

async function readFacts() {
  const paths = [
    "package.json",
    "client/package.json",
    "client/src/helpers/exportProxyPageToPdf.tsx",
    "client/src/helpers/pdf.worker.ts",
    "client/src/helpers/pdfExportResourceBudget.ts",
    SCRIPT_RELATIVE_PATH,
  ];
  const contents = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const [rootManifest, clientManifest, exportEntrypoint, worker, admission] = contents;
  const root = JSON.parse(rootManifest);
  const client = JSON.parse(clientManifest);
  if (client.dependencies?.["pdf-lib"] !== "^1.17.1") throw new Error("Unexpected client pdf-lib declaration");
  if (root.devDependencies?.playwright !== "^1.57.0") throw new Error("Unexpected root Playwright declaration");
  if (root.dependencies?.canvas !== "^3.2.0") throw new Error("Unexpected root canvas declaration");
  const workerLimit = /const PDF_WORKERS_MAX = (\d+);/.exec(exportEntrypoint)?.[1];
  const cacheBudget = /PDF_CANVAS_CACHE_BYTE_BUDGET = (\d+) \* 1024 \* 1024/.exec(worker)?.[1];
  const admissionBudgetGiB = /PDF_EXPORT_CPU_ADMISSION_BYTE_BUDGET = Math\.floor\(\s*([\d.]+) \* 1024 \* 1024 \* 1024\s*\)/s.exec(admission)?.[1];
  if (workerLimit !== "1" || cacheBudget !== "128" || admissionBudgetGiB !== "2.25") {
    throw new Error("Current export resource configuration no longer matches this probe's bounded assumptions");
  }
  return {
    package: { name: root.name, version: root.version },
    dependencies: {
      canvas_manifest: root.dependencies.canvas,
      playwright_manifest: root.devDependencies.playwright,
      pdf_lib_manifest: client.dependencies["pdf-lib"],
    },
    configured_budgets: {
      pdf_workers_max: Number(workerLimit),
      pdf_canvas_cache_bytes: Number(cacheBudget) * MIB,
      pdf_export_cpu_admission_bytes: Number(admissionBudgetGiB) * GIB,
      basis: "Current source constants, not a browser RSS ceiling.",
    },
    source_sha256: Object.fromEntries(paths.map((path, index) => [path, sha256(contents[index])])),
  };
}

async function writeFixture(path) {
  // 63 x 88 mm at 300 DPI. The application creates the real 1200-DPI export page.
  const width = 744;
  const height = 1039;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#0f172a");
  gradient.addColorStop(0.5, "#0e7490");
  gradient.addColorStop(1, "#164e63");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#facc15";
  ctx.lineWidth = 14;
  ctx.strokeRect(24, 24, width - 48, height - 48);
  ctx.fillStyle = "#f8fafc";
  ctx.font = "bold 52px sans-serif";
  ctx.fillText("BOUND", 56, 120);
  ctx.fillText("1200 DPI", 56, 190);
  ctx.fillStyle = "rgba(255,255,255,0.24)";
  for (let y = 250; y < height - 40; y += 48) ctx.fillRect(56, y, width - 112, 16);
  await writeFile(path, canvas.toBuffer("image/png"));
  return { width_px: width, height_px: height, dpi: 300, sha256: sha256(await readFile(path)) };
}

function waitForProcess(child, timeoutMs = 15_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`Vite did not become ready within ${timeoutMs}ms`)), timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    const onData = (chunk) => {
      if (String(chunk).includes("Local:")) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolvePromise();
      }
    };
    child.stdout.on("data", onData);
  });
}

async function startVite() {
  const child = spawn("npm", ["--prefix", "client", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: process.env,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitForProcess(child);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error.message}\n${stderr}`);
  }
  return { child, stderr: () => stderr };
}

function readStatus(pid) {
  return readFile(`/proc/${pid}/status`, "utf8").then((content) => {
    const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(content);
    const threads = /^Threads:\s+(\d+)$/m.exec(content);
    return { rss_bytes: rss ? Number(rss[1]) * 1024 : 0, threads: threads ? Number(threads[1]) : 0 };
  }).catch(() => null);
}

async function descendantPids(rootPid) {
  const procEntries = await readdir("/proc", { withFileTypes: true });
  const pids = procEntries.filter((entry) => /^\d+$/.test(entry.name)).map((entry) => Number(entry.name));
  const pairs = await Promise.all(pids.map(async (pid) => {
    try {
      const statLine = await readFile(`/proc/${pid}/stat`, "utf8");
      const close = statLine.lastIndexOf(")");
      return { pid, ppid: Number(statLine.slice(close + 2).split(" ")[1]) };
    } catch { return null; }
  }));
  const children = new Map();
  for (const pair of pairs) {
    if (!pair || !Number.isInteger(pair.ppid)) continue;
    const list = children.get(pair.ppid) ?? [];
    list.push(pair.pid);
    children.set(pair.ppid, list);
  }
  const result = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    result.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return result;
}

function parseProcessIdentity(pid, cmdline, statLine) {
  const close = statLine.lastIndexOf(")");
  const fields = statLine.slice(close + 2).trim().split(" ");
  return {
    pid,
    ppid: Number(fields[1]),
    start_time_ticks: fields[19] ?? null,
    argv: cmdline.split("\0").filter(Boolean),
  };
}

async function scanProcessByPid(pid) {
  try {
    const [cmdline, statLine] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`, "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    return { status: "present", pid, identity: parseProcessIdentity(pid, cmdline, statLine), errors: [] };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent", pid, identity: null, errors: [] };
    return { status: "unknown", pid, identity: null, errors: [`Could not inspect /proc/${pid}: ${error.message}`] };
  }
}

async function scanProcessesForProfile(profileDir) {
  let procEntries;
  try {
    procEntries = await readdir("/proc", { withFileTypes: true });
  } catch (error) {
    return { status: "unknown", profile_dir: profileDir, matches: [], errors: [`Could not enumerate /proc: ${error.message}`] };
  }
  const matches = [];
  const errors = [];
  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const [cmdline, statLine] = await Promise.all([
        readFile(`/proc/${pid}/cmdline`, "utf8"),
        readFile(`/proc/${pid}/stat`, "utf8"),
      ]);
      if (cmdline.includes(`--user-data-dir=${profileDir}`)) {
        matches.push(parseProcessIdentity(pid, cmdline, statLine));
      }
    } catch (error) {
      // ENOENT means the target exited between enumeration and inspection. Other
      // failures leave the scan inconclusive rather than treating it as clean.
      if (error?.code !== "ENOENT") errors.push(`Could not inspect /proc/${pid}: ${error.message}`);
    }
  }
  return {
    status: errors.length > 0 ? "unknown" : (matches.length > 0 ? "present" : "absent"),
    profile_dir: profileDir,
    matches,
    errors,
  };
}

async function waitForProfileShutdown(profileDir, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let scan = await scanProcessesForProfile(profileDir);
  while (scan.status === "present" && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    scan = await scanProcessesForProfile(profileDir);
  }
  return scan;
}

function browserSampler(browserProcess) {
  let timer;
  let samples = 0;
  let peak = { total_rss_bytes: 0, pids: [], per_process: [] };
  const sample = async () => {
    if (!browserProcess?.pid) return;
    const pids = await descendantPids(browserProcess.pid);
    const perProcess = (await Promise.all(pids.map(async (pid) => ({ pid, ...(await readStatus(pid) ?? { rss_bytes: 0, threads: 0 }) })))).filter((entry) => entry.rss_bytes > 0);
    const total = perProcess.reduce((sum, entry) => sum + entry.rss_bytes, 0);
    samples += 1;
    if (total >= peak.total_rss_bytes) peak = { total_rss_bytes: total, pids, per_process: perProcess };
  };
  return {
    start() { timer = setInterval(() => { void sample(); }, 20); void sample(); },
    async stop() { if (timer) clearInterval(timer); await sample(); return { samples, sample_interval_ms: 20, peak }; },
  };
}

const WORKER_TRACE_INIT_SCRIPT = `(() => {
  const NativeWorker = window.Worker;
  const trace = [];
  class ProbedWorker extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (event) => {
        const data = event.data || {};
        if (data.type === "progress" || data.type === "result" || data.error) {
          trace.push({ direction: "from-worker", type: data.type || "error", pageIndex: data.pageIndex, error: data.error || null, at_ms: performance.now() });
        }
      });
    }
    postMessage(message, transfer) {
      if (message && Array.isArray(message.pageCards) && message.settings) {
        trace.push({ direction: "to-worker", type: "page", pageIndex: message.pageIndex, pageCards: message.pageCards.length, dpi: message.settings.DPI, at_ms: performance.now() });
      }
      return transfer === undefined ? super.postMessage(message) : super.postMessage(message, transfer);
    }
  }
  window.Worker = ProbedWorker;
  window.__td7ac55eWorkerTrace = trace;
})();`;

async function validatePdf(path) {
  const bytes = await readFile(path);
  const pdf = await PDFDocument.load(bytes);
  return {
    sha256: sha256(bytes), bytes: bytes.length, page_count: pdf.getPageCount(),
    media_boxes_points: pdf.getPages().map((page) => { const { width, height } = page.getSize(); return [width, height]; }),
  };
}

async function stopChild(child) {
  if (!child) return { status: "unknown", error: "Vite child was never created" };
  if (child.exitCode !== null) return { status: "exited", pid: child.pid, exit_code: child.exitCode, signal: child.signalCode };
  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolvePromise(); }, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
    child.kill("SIGTERM");
  });
  return {
    status: child.exitCode !== null || child.signalCode !== null ? "exited" : "unknown",
    pid: child.pid,
    exit_code: child.exitCode,
    signal: child.signalCode,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outDir = resolve(options.outDir);
  const gitProvenance = await readGitProvenance();
  await createNewEvidenceDirectory(outDir);
  const facts = await readFacts();
  const fixture = await writeFixture(resolve(outDir, "fixture-card-300dpi.png"));
  const profileDir = resolve(outDir, "playwright-profile");
  await mkdir(profileDir);
  const vite = await startVite();
  const viteStartupProcScan = await scanProcessByPid(vite.child.pid);
  let context;
  let sampling;
  let browserProfileScan;
  let result;
  const started = process.hrtime.bigint();
  try {
    context = await chromium.launchPersistentContext(profileDir, { headless: true, acceptDownloads: true });
    const browser = context.browser();
    browserProfileScan = await scanProcessesForProfile(profileDir);
    if (browserProfileScan.status !== "present") {
      throw new Error(`Could not identify an owned Chromium process from retained profile ${profileDir}: ${JSON.stringify(browserProfileScan)}`);
    }
    const profilePids = new Set(browserProfileScan.matches.map((candidate) => candidate.pid));
    const browserIdentity = browserProfileScan.matches.find((candidate) => !profilePids.has(candidate.ppid));
    if (!browserIdentity) throw new Error("Could not identify the owned Chromium root PID from its unique retained profile; browser RSS is unavailable");
    const browserProcess = { pid: browserIdentity.pid };
    sampling = browserSampler(browserProcess);
    sampling.start();
    const page = context.pages()[0] ?? await context.newPage();
    const consoleErrors = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
    await page.addInitScript({ content: WORKER_TRACE_INIT_SCRIPT });
    await page.goto(VITE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator("#upload-images-unified").setInputFiles(resolve(outDir, "fixture-card-300dpi.png"));
    await page.waitForFunction(() => document.querySelectorAll("[data-dnd-sortable-item]").length === 1, undefined, { timeout: 60_000 });
    const dpiSelect = page.locator("select").filter({ has: page.locator("option[value='1200']") }).first();
    await dpiSelect.selectOption("1200");
    await page.waitForFunction(() => document.querySelector("select") !== null, undefined, { timeout: 5_000 });
    const downloadPromise = page.waitForEvent("download", { timeout: 180_000 });
    await page.getByRole("button", { name: /Export to PDF/ }).first().click();
    const download = await downloadPromise;
    const pdfPath = resolve(outDir, "actual-export-1200dpi-letter.pdf");
    await download.saveAs(pdfPath);
    const trace = await page.evaluate(() => (window).__td7ac55eWorkerTrace ?? []);
    const workerDispatchOrder = trace.filter((event) => event.direction === "to-worker").map((event) => event.pageIndex);
    const workerCompletionOrder = trace.filter((event) => event.direction === "from-worker" && event.type === "result").map((event) => event.pageIndex);
    const traceErrors = trace.filter((event) => event.error);
    const resource = await sampling.stop();
    const pdf = await validatePdf(pdfPath);
    result = {
      schema_version: 3,
      probe_kind: "bounded-real-browser-high-dpi-export",
      command: `node ${SCRIPT_RELATIVE_PATH} --out-dir ${options.outDir}`,
      manifests: facts,
      provenance: {
        git_before_evidence_directory: gitProvenance,
        build: {
          execution_mode: "Vite development server",
          command: ["npm", "--prefix", "client", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
          production_build: { status: "not_run", reason: "This bounded dev-mode probe does not build or serve client/dist." },
        },
      },
      runtime: {
        node: process.version, platform: process.platform, architecture: process.arch,
        browser: {
          engine: "chromium",
          version: browser.version(),
          root_pid: browserProcess.pid,
          profile_identity: { profile_dir: profileDir, profile_dir_sha256: sha256(profileDir), root_process: browserIdentity, startup_profile_scan: browserProfileScan },
        },
        vite: { pid: vite.child.pid, argv: ["npm", "--prefix", "client", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], startup_proc_scan: viteStartupProcScan },
        elapsed_ms: Number(process.hrtime.bigint() - started) / 1e6,
        orchestrator_ru_maxrss_bytes: process.resourceUsage().maxRSS * 1024,
      },
      fixture,
      workload: {
        cards: 1, pages_expected: 1, page: "US Letter 8.5x11in", dpi: HIGH_DPI,
        grid: "default 3x3; one occupied slot", worker_setting: "actual app setting passed to its real PDF worker",
        bounded_reason: "One application PDF worker and one occupied page; no parallel pages, profiles, or fixture reuse.",
      },
      actual_completion: { worker_dispatch_order: workerDispatchOrder, worker_completion_order: workerCompletionOrder, trace_errors: traceErrors, worker_trace: trace },
      actual_resources: {
        browser_process_tree_peak_rss_bytes: resource.peak.total_rss_bytes,
        browser_process_tree_peak_rss_mib: resource.peak.total_rss_bytes / MIB,
        peak_sample_pids: resource.peak.pids,
        peak_sample_processes: resource.peak.per_process,
        sampling: { samples: resource.samples, sample_interval_ms: resource.sample_interval_ms, basis: "Best-effort sum of Linux /proc/<pid>/status VmRSS for the owned Playwright Chromium root and descendants. Short-lived peaks may be missed." },
        gpu_allocation: "unavailable: browser GPU/driver allocations are opaque to /proc RSS and were not inferred.",
      },
      output_pdf: pdf,
      configured_budget_comparison: {
        admission_result: "actual export completed through assertPdfExportCpuAdmission with the current configured source budget",
        worker_result: `trace recorded ${workerDispatchOrder.length} worker dispatch(es); source config permits at most ${facts.configured_budgets.pdf_workers_max}`,
        rss_result: "observed browser RSS is recorded beside the CPU RGBA8 admission estimate, but is not directly comparable: RSS includes runtime overhead and excludes opaque driver/GPU allocations.",
        cache_result: "the 128 MiB worker canvas-cache budget is source configuration; this probe does not expose cache-byte counters from the worker.",
      },
      limitations: [
        "This real export uses one synthetic local card fixture, not a photographic production deck.",
        "The browser/app path was available; the standalone server was not started, so unrelated builtin-cardback requests may log 500 errors.",
        "No GPU, browser backing-store, encoder, or driver allocation was measured.",
      ],
      console_errors: consoleErrors,
    };
  } finally {
    if (sampling) await sampling.stop().catch(() => undefined);
    let browserClose = { status: "not_started", error: null };
    if (context) {
      try {
        await context.close();
        browserClose = { status: "closed", error: null };
      } catch (error) {
        browserClose = { status: "failed", error: error.message };
      }
    }
    const postcloseProfileScan = browserProfileScan
      ? await waitForProfileShutdown(profileDir).catch((error) => ({ status: "unknown", profile_dir: profileDir, matches: [], errors: [error.message] }))
      : { status: "unknown", profile_dir: profileDir, matches: [], errors: ["Browser profile was never identified"] };
    const viteShutdown = await stopChild(vite.child).catch((error) => ({ status: "unknown", pid: vite.child.pid, error: error.message }));
    const postcloseViteProcScan = await scanProcessByPid(vite.child.pid);
    if (result) {
      result.runtime.owned_process_shutdown = {
        browser_context_close: browserClose,
        postclose_profile_scan: postcloseProfileScan,
        vite: viteShutdown,
        postclose_vite_proc_scan: postcloseViteProcScan,
        status: browserClose.status === "closed" && postcloseProfileScan.status === "absent" && viteShutdown.status === "exited" && postcloseViteProcScan.status === "absent" ? "verified" : "unknown_or_incomplete",
        basis: "The probe closes only its Playwright context and Vite child, then scans Linux /proc for the exact retained Chromium --user-data-dir profile and the exact Vite child PID. A failed or incomplete scan is recorded as unknown, never as an empty clean result.",
      };
      await writeFile(resolve(outDir, "resource-probe-result.json"), `${JSON.stringify(result, null, 2)}\n`);
      await writeFile(resolve(outDir, "commands.sh"), `#!/bin/sh\nset -eu\n${result.command}\n`);
      await writeFile(resolve(outDir, "source-hashes.sha256"), `${Object.entries(facts.source_sha256).map(([path, hash]) => `${hash}  ${path}`).join("\n")}\n`);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.runtime.owned_process_shutdown.status !== "verified") {
        throw new Error(`Owned-process shutdown was not verified: ${JSON.stringify(result.runtime.owned_process_shutdown)}`);
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`export-resource-probe: ${error.stack || error}\n`);
  process.exitCode = 1;
});
