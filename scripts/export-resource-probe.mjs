#!/usr/bin/env node
/**
 * Bounded export resource probe.
 *
 * This intentionally does not render the application's 1200-DPI canvas. It creates
 * one physical-Letter, 3x3-card PDF with a reusable 300-DPI synthetic card raster,
 * reads and rewrites it through the repository calibration venv, and records that
 * subprocess's own ru_maxrss. The 1200-DPI surface values in the JSON are arithmetic
 * estimates only; they are not observations of browser GPU/canvas memory.
 *
 * Usage:
 *   node scripts/export-resource-probe.mjs \
 *     --out-dir .review-artifacts/resource-measurement-01
 *     --python .review-artifacts/resource-runtime-01/bin/python
 *
 * Options:
 *   --out-dir <directory>  Evidence/output directory (required)
 *   --python <path>        Calibration venv Python executable
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIB = 1024 ** 2;
const DEFAULT_PYTHON = ".review-artifacts/resource-runtime-01/bin/python";
const SCRIPT_PATH = fileURLToPath(import.meta.url);

const PYTHON_PROBE = String.raw`
import json
import os
import resource
import sys
from io import BytesIO
from importlib.metadata import version

from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

pdf_path, rewritten_path = sys.argv[1], sys.argv[2]
page_width_pt, page_height_pt = 612, 792  # US Letter at 72 points/inch
card_width_pt = 63 / 25.4 * 72
card_height_pt = 88 / 25.4 * 72
sample_width_px, sample_height_px = 744, 1039  # 63 x 88 mm at 300 DPI, rounded down

# One bounded raster is reused for all nine cards. It is deliberately not a 1200-DPI
# page/card allocation, so this helper is safe on development hosts.
image = Image.new("RGB", (sample_width_px, sample_height_px), "#18243b")
draw = ImageDraw.Draw(image)
for y in range(0, sample_height_px, 32):
    shade = 35 + (y * 140 // sample_height_px)
    draw.rectangle((0, y, sample_width_px, min(sample_height_px, y + 32)), fill=(20, shade, 110))
draw.rectangle((22, 22, sample_width_px - 22, sample_height_px - 22), outline="#f3c969", width=12)
draw.text((52, 52), "BOUND\nPROBE", fill="#ffffff", spacing=8)
image_bytes = BytesIO()
image.save(image_bytes, format="PNG", optimize=False)
image_bytes.seek(0)

# Physical dimensions and 3 x 3 placement match the default Letter/63x88mm grid.
pdf = canvas.Canvas(pdf_path, pagesize=(page_width_pt, page_height_pt), pageCompression=1)
for row in range(3):
    for column in range(3):
        x = (page_width_pt - 3 * card_width_pt) / 2 + column * card_width_pt
        y = (page_height_pt - 3 * card_height_pt) / 2 + (2 - row) * card_height_pt
        pdf.drawImage(ImageReader(image_bytes), x, y, width=card_width_pt, height=card_height_pt)
pdf.showPage()
pdf.save()

# Exercise the actual calibration package dependency's PDF library in a second real
# PDF read/write phase. This is intentionally a single-page, small-raster fixture.
reader = PdfReader(pdf_path)
writer = PdfWriter()
for page in reader.pages:
    writer.add_page(page)
with open(rewritten_path, "wb") as output:
    writer.write(output)

verified = PdfReader(rewritten_path)
box = verified.pages[0].mediabox
peak_kib = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
print(json.dumps({
    "python_version": sys.version.split()[0],
    "reportlab_version": version("reportlab"),
    "pypdf_version": version("pypdf"),
    "pages": len(verified.pages),
    "media_box_points": [float(box.left), float(box.bottom), float(box.right), float(box.top)],
    "card_grid": {"columns": 3, "rows": 3, "card_mm": [63, 88]},
    "synthetic_raster": {"width_px": sample_width_px, "height_px": sample_height_px, "dpi": 300},
    "input_pdf_bytes": os.path.getsize(pdf_path),
    "rewritten_pdf_bytes": os.path.getsize(rewritten_path),
    "child_ru_maxrss_bytes": peak_kib * 1024,
    "peak_rss_basis": "Linux resource.getrusage(RUSAGE_SELF).ru_maxrss, KiB converted to bytes",
}, sort_keys=True))
`;

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: node scripts/export-resource-probe.mjs --out-dir <directory> [--python <path>]\n",
  );
  process.exitCode = 2;
}

function parseArgs(argv) {
  const result = { outDir: undefined, python: DEFAULT_PYTHON };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir" || arg === "--python") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      result[arg === "--out-dir" ? "outDir" : "python"] = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      return null;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!result.outDir) throw new Error("--out-dir is required");
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && path !== "..");
}

async function createNewEvidenceDirectory(outDir) {
  const repositoryRoot = resolve(process.cwd());
  const protectedRoots = [".git", ".todos", ".recovery"].map((path) => resolve(repositoryRoot, path));
  if (!isWithin(repositoryRoot, outDir)) {
    throw new Error(`--out-dir must stay inside the repository: ${outDir}`);
  }
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

function ceilSurface(name, widthPx, heightPx) {
  const width = Math.ceil(widthPx);
  const height = Math.ceil(heightPx);
  const pixels = width * height;
  const rgbaBytes = pixels * 4;
  return {
    name,
    source_dimensions_px: { width: widthPx, height: heightPx },
    conservative_integer_canvas_px: { width, height },
    pixels,
    rgba8_bytes: rgbaBytes,
    rgba8_mib: rgbaBytes / MIB,
  };
}

function estimates() {
  const dpi = 1200;
  const mmToPx = (mm) => (mm / 25.4) * dpi;
  const inchToPx = (inches) => inches * dpi;
  const page = ceilSurface("Letter page 8.5x11in", inchToPx(8.5), inchToPx(11));
  const card = ceilSurface("Card content 63x88mm", mmToPx(63), mmToPx(88));
  const cardOneMmBleed = ceilSurface("Card 63x88mm plus 1mm bleed per side", mmToPx(65), mmToPx(90));
  const cardMpcBleed = ceilSurface("Card 63x88mm plus 3.175mm bleed per side", mmToPx(69.35), mmToPx(94.35));
  return {
    basis: {
      dpi,
      format: "RGBA8: ceil(width_px) * ceil(height_px) * 4 bytes",
      source_geometry: "client/src/helpers/pdf.worker.ts:485-488, 540-543; client/src/constants/imageProcessing.ts:34-39",
      caveat: "These are conservative CPU/canvas byte estimates. Browser canvas backing stores may be CPU, GPU, tiled, compressed, or duplicated by the implementation; no GPU allocation is measured here.",
    },
    surfaces: [page, card, cardOneMmBleed, cardMpcBleed],
    illustrative_compositions: {
      page_plus_full_page_guides: {
        count: 2,
        bytes: page.rgba8_bytes * 2,
        mib: (page.rgba8_bytes * 2) / MIB,
        rationale: "pdf.worker creates the page canvas and may create a same-sized full-page guide canvas.",
      },
      one_card_decode_effect_final_at_1mm_bleed: {
        count: 3,
        bytes: cardOneMmBleed.rgba8_bytes * 3,
        mib: (cardOneMmBleed.rgba8_bytes * 3) / MIB,
        rationale: "Illustrative decode/effect/final RGBA8 surfaces; actual effect pipeline may allocate more or fewer intermediates.",
      },
      four_active_cards_decode_effect_final_at_1mm_bleed: {
        count: 12,
        bytes: cardOneMmBleed.rgba8_bytes * 12,
        mib: (cardOneMmBleed.rgba8_bytes * 12) / MIB,
        rationale: "Current pdf.worker source has MAX_CONCURRENT_CARDS = 4; this is an estimate, not a measurement.",
      },
    },
  };
}

async function readManifestFacts() {
  // Read dependency manifests before starting the Python process that imports them.
  const [rootManifest, clientManifest, calibrationManifest, probeSource, pdfWorkerSource] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("client/package.json", "utf8"),
    readFile("server/vendor/printer-calibration/pyproject.toml", "utf8"),
    readFile(SCRIPT_PATH, "utf8"),
    readFile("client/src/helpers/pdf.worker.ts", "utf8"),
  ]);
  const root = JSON.parse(rootManifest);
  const client = JSON.parse(clientManifest);
  if (client.dependencies?.["pdf-lib"] !== "^1.17.1") {
    throw new Error("client/package.json does not declare the expected pdf-lib dependency");
  }
  if (!calibrationManifest.includes('"pypdf"') || !calibrationManifest.includes('"reportlab"')) {
    throw new Error("printer-calibration manifest does not declare pypdf and reportlab");
  }
  return {
    root_package_name: root.name,
    root_package_version: root.version,
    client_pdf_lib: client.dependencies["pdf-lib"],
    source_sha256: {
      "package.json": sha256(rootManifest),
      "client/package.json": sha256(clientManifest),
      "server/vendor/printer-calibration/pyproject.toml": sha256(calibrationManifest),
      "scripts/export-resource-probe.mjs": sha256(probeSource),
      "client/src/helpers/pdf.worker.ts": sha256(pdfWorkerSource),
    },
  };
}

async function writeEvidenceFiles(outDir, command, result) {
  const runtime = [
    `node=${result.runtime.node}`,
    `platform=${result.runtime.platform}`,
    `architecture=${result.runtime.architecture}`,
    `python=${result.synthetic_pdf.python_version}`,
    `reportlab=${result.synthetic_pdf.reportlab_version}`,
    `pypdf=${result.synthetic_pdf.pypdf_version}`,
    `elapsed_ms=${result.runtime.elapsed_ms}`,
    `child_ru_maxrss_bytes=${result.measured_rss.child_ru_maxrss_bytes}`,
    `node_sampled_child_vmrss_peak_bytes=${result.measured_rss.node_sampled_child_vmrss_peak_bytes}`,
    `orchestrator_ru_maxrss_bytes=${result.runtime.orchestrator_ru_maxrss_bytes}`,
  ].join("\n");
  const sourceHashes = Object.entries(result.manifests.source_sha256)
    .map(([path, hash]) => `${hash}  ${path}`)
    .join("\n");
  await Promise.all([
    writeFile(resolve(outDir, "commands.sh"), `#!/bin/sh\nset -eu\n${command}\n`),
    writeFile(resolve(outDir, "runtime.txt"), `${runtime}\n`),
    writeFile(resolve(outDir, "source-hashes.sha256"), `${sourceHashes}\n`),
  ]);
}

async function runChild(python, inputPdf, rewrittenPdf) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(python, ["-c", PYTHON_PROBE, inputPdf, rewrittenPdf], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let sampledPeakRssBytes = 0;
    const sample = () => {
      if (!child.pid) return;
      readFile(`/proc/${child.pid}/status`, "utf8")
        .then((status) => {
          const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
          if (match) sampledPeakRssBytes = Math.max(sampledPeakRssBytes, Number(match[1]) * 1024);
        })
        .catch(() => undefined);
    };
    const timer = setInterval(sample, 5);
    sample();
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearInterval(timer);
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      clearInterval(timer);
      const resultLine = stdout.trim().split("\n").filter(Boolean).at(-1);
      if (code !== 0 || !resultLine) {
        rejectPromise(new Error(`Python probe failed (code=${code}, signal=${signal}): ${stderr || stdout}`));
        return;
      }
      try {
        resolvePromise({
          child: JSON.parse(resultLine),
          sampled_peak_rss_bytes: sampledPeakRssBytes,
          stderr: stderr.trim(),
        });
      } catch (error) {
        rejectPromise(new Error(`Python probe returned invalid JSON: ${error}\n${stdout}`));
      }
    });
  });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage(error.message);
    return;
  }
  if (!options) return;

  const outDir = resolve(options.outDir);
  await createNewEvidenceDirectory(outDir);
  const manifests = await readManifestFacts();
  const inputPdf = resolve(outDir, "probe-letter-300dpi.pdf");
  const rewrittenPdf = resolve(outDir, "probe-letter-300dpi-rewritten.pdf");
  const start = process.hrtime.bigint();
  const run = await runChild(resolve(options.python), inputPdf, rewrittenPdf);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  const result = {
    schema_version: 1,
    probe_kind: "bounded-synthetic-python-pdf",
    command: `node scripts/export-resource-probe.mjs --out-dir ${options.outDir} --python ${options.python}`,
    manifests,
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      elapsed_ms: elapsedMs,
      orchestrator_ru_maxrss_bytes: process.resourceUsage().maxRSS * 1024,
    },
    measured_rss: {
      child_ru_maxrss_bytes: run.child.child_ru_maxrss_bytes,
      child_ru_maxrss_basis: run.child.peak_rss_basis,
      node_sampled_child_vmrss_peak_bytes: run.sampled_peak_rss_bytes,
      node_sampled_child_vmrss_basis: "Best-effort /proc/<pid>/status sampling every 5ms; may miss short-lived peaks and is not the child ru_maxrss measurement.",
      limitation: "These are Linux process RSS measurements from the small Python PDF probe. They do not measure browser JavaScript, OffscreenCanvas backing-store, encoder, driver, or GPU memory.",
    },
    synthetic_pdf: run.child,
    estimated_canvas_bytes: estimates(),
    limits_decision: {
      status: "proposed_for_downstream_implementation",
      pdf_workers_max: 1,
      high_dpi_card_decode_max: 1,
      pdf_effect_admission_bytes: 268435456,
      pdf_canvas_cache_bytes: 134217728,
      calibration_upload_bytes: 67108864,
      calibration_aggregate_temp_bytes: 134217728,
      calibration_subprocesses_max: 1,
      rationale: "One 1200-DPI Letter page is about 513.6 MiB RGBA8; page plus full-page guides is about 1.0 GiB before card preparation. Do not multiply that uncertain canvas/GPU working set by CPU count. A 256 MiB effect admission admits at most one illustrative 1200-DPI 1mm-bleed decode/effect/final set; cache and calibration limits are conservative provisional controls pending high-DPI photo/browser and calibration-transform measurements.",
      limitation: "These configuration values are a documented proposal, not implemented behavior. The 64 MiB upload ceiling is not derived from the small synthetic PDF size and must be revalidated with representative high-DPI photographic calibration PDFs before enforcement.",
    },
  };
  await writeFile(resolve(outDir, "resource-probe-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeEvidenceFiles(outDir, result.command, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`export-resource-probe: ${error.stack || error}\n`);
  process.exitCode = 1;
});
