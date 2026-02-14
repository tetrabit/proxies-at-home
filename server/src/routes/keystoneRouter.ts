import express, { type Request, type Response } from "express";
import multer from "multer";
import os from "os";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";

export const keystoneRouter = express.Router();

type KeystoneRunner =
  | { kind: "bin"; cmd: string; cwd?: string; extraEnv?: Record<string, string> }
  | { kind: "python"; python: string; repoDir?: string };

function fileExists(p: string) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function detectDefaultPrinterKeystoneRepo(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  const candidate = path.join(home, "projects", "printer-keystone");
  if (fileExists(candidate) && fileExists(path.join(candidate, "printer_keystone"))) return candidate;
  return null;
}

function resolveRunners(): KeystoneRunner[] {
  const out: KeystoneRunner[] = [];

  // 1) Explicit binary path
  const bin = process.env.PRINTER_KEYSTONE_BIN;
  if (bin) out.push({ kind: "bin", cmd: bin });

  // 2) printer-keystone on PATH (try at runtime; may ENOENT)
  out.push({ kind: "bin", cmd: "printer-keystone" });

  // 3) Python module execution, optionally with a repo checkout on disk.
  const repoDir = process.env.PRINTER_KEYSTONE_REPO || detectDefaultPrinterKeystoneRepo();
  const pythonCandidates = [
    process.env.PRINTER_KEYSTONE_PYTHON,
    "python3",
    "python",
  ].filter(Boolean) as string[];
  for (const py of pythonCandidates) {
    out.push({ kind: "python", python: py, repoDir: repoDir || undefined });
  }

  return out;
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`keystone analyzer timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

async function runPrinterKeystone(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const runners = resolveRunners();
  if (!runners.length) {
    throw new Error("Keystone analyzer not configured.");
  }

  let lastErr: unknown = null;
  for (const runner of runners) {
    try {
      if (runner.kind === "bin") {
        if (runner.cmd !== "printer-keystone" && !fileExists(runner.cmd)) {
          throw new Error(`PRINTER_KEYSTONE_BIN does not exist: ${runner.cmd}`);
        }
        const res = await runProcess(runner.cmd, args, { cwd: runner.cwd, env: runner.extraEnv, timeoutMs: 120_000 });
        if (res.code !== 0) {
          throw new Error(`printer-keystone failed (code=${res.code}): ${res.stderr || res.stdout}`.trim());
        }
        return { stdout: res.stdout, stderr: res.stderr };
      }

      // Python module. If repoDir exists, add to PYTHONPATH so we can run without installing.
      const env: Record<string, string> = {};
      if (runner.repoDir) {
        env.PYTHONPATH = runner.repoDir + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : "");
      }

      const pyArgs = ["-m", "printer_keystone.cli", ...args];
      const res = await runProcess(runner.python, pyArgs, { cwd: runner.repoDir, env, timeoutMs: 120_000 });
      if (res.code !== 0) {
        throw new Error(`printer-keystone failed (code=${res.code}): ${res.stderr || res.stdout}`.trim());
      }
      return { stdout: res.stdout, stderr: res.stderr };
    } catch (e: unknown) {
      lastErr = e;
      // Try next runner on common "not found" cases.
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes("ENOENT") ||
        msg.toLowerCase().includes("not found") ||
        msg.toLowerCase().includes("no module named") ||
        msg.toLowerCase().includes("does not exist")
      ) {
        continue;
      }
      // For other failures (tool ran but couldn't analyze), stop and report.
      throw e;
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `Keystone analyzer unavailable. Install printer-keystone (python/opencv) or set PRINTER_KEYSTONE_BIN/PRINTER_KEYSTONE_REPO. Last error: ${msg}`,
  );
}

function safeNumber(v: unknown, field: string): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${field}`);
  return n;
}

type KeystoneAnalyzeResult = {
  back_shift_mm: { x: number; y: number };
  front: { translation_mm: { x: number; y: number }; rot_deg: number; scale: number; coord_fix?: string; markers?: number[] };
  back: { translation_mm: { x: number; y: number }; rot_deg: number; scale: number; coord_fix?: string; markers?: number[] };
  extra: {
    rot_deg: number;
    scale: number;
    translation_mm: { x: number; y: number };
    translation_method: "inv(back_affine)*diff(translation)";
  };
  raw: { stdout: string };
};

function parseMarkersList(s: string): number[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
}

export function parsePrinterKeystoneAnalyzeStdout(stdout: string): KeystoneAnalyzeResult {
  const rx = {
    backShiftX: /back_shift_x_mm:\s*([-+]?(\d+(\.\d*)?|\.\d+))/i,
    backShiftY: /back_shift_y_mm:\s*([-+]?(\d+(\.\d*)?|\.\d+))/i,
    // front/back diagnostics lines include translation, rot, scale, coord_fix, markers list.
    sideGlobal:
      /(front|back):\s+translation_mm=\(\s*([-+0-9.]+)\s*,\s*([-+0-9.]+)\s*\)\s+rot_deg=([-+0-9.]+)\s+scale=([-+0-9.]+)\s+coord_fix=([^\s]+)\s+markers=\[([0-9,\s]+)\]/gi,
  };

  const mX = stdout.match(rx.backShiftX);
  const mY = stdout.match(rx.backShiftY);
  if (!mX || !mY) {
    throw new Error("Failed to parse printer-keystone output (missing back_shift_x_mm/back_shift_y_mm).");
  }

  const sides: Record<"front" | "back", KeystoneAnalyzeResult["front"]> = {
    front: { translation_mm: { x: 0, y: 0 }, rot_deg: 0, scale: 1 },
    back: { translation_mm: { x: 0, y: 0 }, rot_deg: 0, scale: 1 },
  };

  for (const m of stdout.matchAll(rx.sideGlobal)) {
    const sideName = (m[1] || "").toLowerCase() as "front" | "back";
    const tx = Number(m[2]);
    const ty = Number(m[3]);
    const rot = Number(m[4]);
    const scale = Number(m[5]);
    const coordFix = m[6];
    const markers = parseMarkersList(m[7] || "");
    if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(rot) || !Number.isFinite(scale)) continue;
    sides[sideName] = {
      translation_mm: { x: tx, y: ty },
      rot_deg: rot,
      scale,
      coord_fix: coordFix,
      markers,
    };
  }

  const dxRaw = Number(mX[1]);
  const dyRaw = Number(mY[1]);

  // Compute a better "extra transform" to apply to back content so it matches front:
  // See derivation: Rb*(Rextra*x + textra) + tb = Rf*x + tf  =>  textra = inv(Rb)*(tf - tb)
  const tDiff = {
    x: sides.front.translation_mm.x - sides.back.translation_mm.x,
    y: sides.front.translation_mm.y - sides.back.translation_mm.y,
  };
  const thetaB = (sides.back.rot_deg * Math.PI) / 180;
  const cosB = Math.cos(thetaB);
  const sinB = Math.sin(thetaB);
  const sB = sides.back.scale || 1;
  const invSB = 1 / sB;
  const tExtra = {
    x: invSB * (cosB * tDiff.x + sinB * tDiff.y),
    y: invSB * (-sinB * tDiff.x + cosB * tDiff.y),
  };

  const rotExtra = sides.front.rot_deg - sides.back.rot_deg;
  const scaleExtra = (sides.front.scale || 1) / (sides.back.scale || 1);

  return {
    back_shift_mm: { x: dxRaw, y: dyRaw },
    front: sides.front,
    back: sides.back,
    extra: {
      rot_deg: rotExtra,
      scale: scaleExtra,
      translation_mm: tExtra,
      translation_method: "inv(back_affine)*diff(translation)",
    },
    raw: { stdout },
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 30 * 1024 * 1024, // 30MB per file
  },
});

function writeTempFile(buf: Buffer, originalName: string): string {
  const ext = path.extname(originalName || "").slice(0, 10) || ".bin";
  const p = path.join(os.tmpdir(), `proxxied-keystone-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
  fs.writeFileSync(p, buf);
  return p;
}

function unlinkQuiet(p: string | null | undefined) {
  if (!p) return;
  try {
    fs.unlinkSync(p);
  } catch {
    // ignore
  }
}

// GET /api/keystone/calibration?paper=letter
keystoneRouter.get("/calibration", async (req: Request, res: Response) => {
  const paper = String(req.query.paper || "letter").toLowerCase();
  if (!["letter", "a4"].includes(paper)) {
    return res.status(400).json({ error: "Invalid paper. Use letter or a4." });
  }

  const outPath = path.join(
    os.tmpdir(),
    `proxxied-keystone-calibration-${paper}-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`,
  );
  try {
    await runPrinterKeystone(["generate", "--paper", paper, "--out", outPath]);
    res.setHeader("Content-Type", "application/pdf");
    res.download(outPath, `keystone_calibration_${paper}.pdf`, (err) => {
      unlinkQuiet(outPath);
      if (err) {
        // download already attempted; nothing else to do
        console.error("[keystone] download error:", err);
      }
    });
  } catch (e: unknown) {
    unlinkQuiet(outPath);
    const msg = e instanceof Error ? e.message : String(e);
    // In production web, we likely won't have python/opencv; report as not supported.
    const status = msg.toLowerCase().includes("not configured") ? 501 : 500;
    res.status(status).json({ error: msg });
  }
});

// POST /api/keystone/analyze (multipart form: front/back + options)
keystoneRouter.post(
  "/analyze",
  upload.fields([
    { name: "front", maxCount: 1 },
    { name: "back", maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const front = files?.front?.[0];
    const back = files?.back?.[0];
    if (!front || !back) {
      return res.status(400).json({ error: "Missing files. Provide front and back." });
    }

    const paper = String(req.body.paper || "letter").toLowerCase();
    const dpi = safeNumber(req.body.dpi ?? 300, "dpi");
    const frontPage = safeNumber(req.body.frontPage ?? 1, "frontPage");
    const backPage = safeNumber(req.body.backPage ?? 1, "backPage");
    const borderInsetMm = req.body.borderInsetMm !== undefined && req.body.borderInsetMm !== ""
      ? safeNumber(req.body.borderInsetMm, "borderInsetMm")
      : null;

    if (!["letter", "a4"].includes(paper)) {
      return res.status(400).json({ error: "Invalid paper. Use letter or a4." });
    }
    if (dpi < 72 || dpi > 1200) {
      return res.status(400).json({ error: "Invalid dpi. Use 72..1200." });
    }
    if (frontPage < 1 || backPage < 1) {
      return res.status(400).json({ error: "Invalid page number (must be >= 1)." });
    }

    let frontPath: string | null = null;
    let backPath: string | null = null;
    try {
      frontPath = writeTempFile(front.buffer, front.originalname);
      backPath = writeTempFile(back.buffer, back.originalname);

      const args = [
        "analyze",
        "--front",
        frontPath,
        "--front-page",
        String(frontPage),
        "--back",
        backPath,
        "--back-page",
        String(backPage),
        "--dpi",
        String(dpi),
        "--paper",
        paper,
      ];
      if (borderInsetMm !== null) {
        args.push("--border-inset-mm", String(borderInsetMm));
      }

      const { stdout } = await runPrinterKeystone(args);
      const parsed = parsePrinterKeystoneAnalyzeStdout(stdout);
      res.json(parsed);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.toLowerCase().includes("not configured") ? 501 : 500;
      res.status(status).json({ error: msg });
    } finally {
      unlinkQuiet(frontPath);
      unlinkQuiet(backPath);
    }
  },
);
