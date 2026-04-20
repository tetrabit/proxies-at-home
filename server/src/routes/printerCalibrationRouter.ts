import express, { type Request, type Response } from "express";
import multer from "multer";
import os from "os";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

export type PrinterCalibrationProfile = {
  name: string;
  front_x_mm: number;
  front_y_mm: number;
  back_x_mm: number;
  back_y_mm: number;
  paper_size?: string;
  duplex_mode?: string;
};

type PrinterCalibrationRunner =
  | {
      kind: "bin";
      cmd: string;
      cwd?: string;
      extraEnv?: Record<string, string>;
    }
  | { kind: "python"; python: string; repoDir?: string };

type CliResult = { stdout: string; stderr: string };
type CliRunner = (args: string[]) => Promise<CliResult>;

interface PrinterCalibrationRouterOptions {
  dataDirectory?: string;
  configuredProfilesPath?: string;
  runCli?: CliRunner;
}

const DEFAULT_PROFILES_FILENAME = "printer-calibration/profiles.toml";
const CENTER_X_MM = 107.95;
const CENTER_Y_MM = 139.7;
const ROUTES_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function fileExists(filePath: string) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function detectDefaultPrinterCalibrationRepo(): string | null {
  const candidates = new Set<string>();
  const home = process.env.HOME || process.env.USERPROFILE;

  if (home) {
    candidates.add(path.join(home, "projects", "printer-calibration"));
  }

  candidates.add(path.resolve(process.cwd(), "..", "printer-calibration"));
  candidates.add(path.resolve(process.cwd(), "..", "..", "printer-calibration"));
  candidates.add(
    path.resolve(ROUTES_DIRECTORY, "..", "..", "..", "..", "printer-calibration")
  );

  for (const candidate of candidates) {
    if (
      fileExists(candidate) &&
      fileExists(path.join(candidate, "src", "printer_calibration"))
    ) {
      return candidate;
    }
  }

  return null;
}

function resolveRunners(): PrinterCalibrationRunner[] {
  const out: PrinterCalibrationRunner[] = [];
  const bin = process.env.PRINTER_CALIBRATION_BIN;
  if (bin) out.push({ kind: "bin", cmd: bin });
  out.push({ kind: "bin", cmd: "printer-calibration" });

  const configuredRepoDir = process.env.PRINTER_CALIBRATION_REPO;
  const repoDir =
    configuredRepoDir &&
    fileExists(path.join(configuredRepoDir, "src", "printer_calibration"))
      ? configuredRepoDir
      : detectDefaultPrinterCalibrationRepo();

  const pythonCandidates = [
    process.env.PRINTER_CALIBRATION_PYTHON,
    "python3",
    "python",
  ].filter(Boolean) as string[];

  for (const python of pythonCandidates) {
    out.push({ kind: "python", python, repoDir: repoDir || undefined });
  }

  return out;
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}
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
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`printer calibration command timed out after ${timeoutMs}ms`)
      );
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

async function runPrinterCalibrationCli(args: string[]): Promise<CliResult> {
  const runners = resolveRunners();
  if (!runners.length) {
    throw new Error("Printer calibration is not configured.");
  }

  let lastError: unknown = null;
  for (const runner of runners) {
    try {
      if (runner.kind === "bin") {
        if (runner.cmd !== "printer-calibration" && !fileExists(runner.cmd)) {
          throw new Error(
            `PRINTER_CALIBRATION_BIN does not exist: ${runner.cmd}`
          );
        }
        const result = await runProcess(runner.cmd, args, {
          cwd: runner.cwd,
          env: runner.extraEnv,
          timeoutMs: 120_000,
        });
        if (result.code !== 0) {
          throw new Error(
            `printer-calibration failed (code=${result.code}): ${result.stderr || result.stdout}`.trim()
          );
        }
        return { stdout: result.stdout, stderr: result.stderr };
      }

      const env: Record<string, string> = {};
      if (runner.repoDir) {
        const pythonPathEntry = path.join(runner.repoDir, "src");
        env.PYTHONPATH = process.env.PYTHONPATH
          ? `${pythonPathEntry}${path.delimiter}${process.env.PYTHONPATH}`
          : pythonPathEntry;
      }

      const result = await runProcess(
        runner.python,
        ["-m", "printer_calibration.cli", ...args],
        {
          cwd: runner.repoDir,
          env,
          timeoutMs: 120_000,
        }
      );
      if (result.code !== 0) {
        throw new Error(
          `printer-calibration failed (code=${result.code}): ${result.stderr || result.stdout}`.trim()
        );
      }
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error: unknown) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("ENOENT") ||
        message.toLowerCase().includes("not found") ||
        message.toLowerCase().includes("no module named") ||
        message.toLowerCase().includes("does not exist")
      ) {
        continue;
      }
      throw error;
    }
  }

  const message =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Printer calibration unavailable. Install printer-calibration or set PRINTER_CALIBRATION_BIN/PRINTER_CALIBRATION_REPO. Last error: ${message}`
  );
}

function safeNumber(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${field}`);
  }
  return parsed;
}

function writeTempFile(buffer: Buffer, originalName: string): string {
  const extension = path.extname(originalName || "").slice(0, 10) || ".bin";
  const tempPath = path.join(
    os.tmpdir(),
    `proxxied-printer-calibration-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`
  );
  fs.writeFileSync(tempPath, buffer);
  return tempPath;
}

function unlinkQuiet(filePath: string | null | undefined) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore cleanup failures
  }
}

export function resolvePrinterCalibrationProfilesPath(
  configuredPath: string | undefined,
  dataDirectory: string
): string {
  const resolvedDataDirectory = path.resolve(dataDirectory);
  const rawPath = configuredPath?.trim() || DEFAULT_PROFILES_FILENAME;
  const resolvedPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(resolvedDataDirectory, rawPath);
  const relativePath = path.relative(resolvedDataDirectory, resolvedPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(
      `PRINTER_CALIBRATION_PROFILES_PATH must stay within ${resolvedDataDirectory}`
    );
  }
  return resolvedPath;
}

export function calculatePrinterCalibrationProfile(input: {
  front_x_measured_mm: number;
  front_y_measured_mm: number;
  back_x_measured_mm: number;
  back_y_measured_mm: number;
}): Omit<PrinterCalibrationProfile, "name"> {
  return {
    front_x_mm: CENTER_X_MM - input.front_x_measured_mm,
    front_y_mm: CENTER_Y_MM - input.front_y_measured_mm,
    back_x_mm: CENTER_X_MM - input.back_x_measured_mm,
    back_y_mm: CENTER_Y_MM - input.back_y_measured_mm,
    paper_size: "letter",
    duplex_mode: "long-edge",
  };
}

export function parsePrinterCalibrationProfileOutput(
  name: string,
  stdout: string
): PrinterCalibrationProfile {
  const data: Partial<PrinterCalibrationProfile> = { name };
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.includes(":")) continue;
    const [rawKey, ...rawValueParts] = line.split(":");
    const key = rawKey.trim();
    const rawValue = rawValueParts.join(":").trim();
    if (
      key === "front_x_mm" ||
      key === "front_y_mm" ||
      key === "back_x_mm" ||
      key === "back_y_mm"
    ) {
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid numeric value for ${key}`);
      }
      data[key] = parsed;
      continue;
    }
    if (key === "paper_size" || key === "duplex_mode") {
      data[key] = rawValue;
    }
  }

  if (
    typeof data.front_x_mm !== "number" ||
    typeof data.front_y_mm !== "number" ||
    typeof data.back_x_mm !== "number" ||
    typeof data.back_y_mm !== "number"
  ) {
    throw new Error("Failed to parse printer calibration profile output.");
  }

  return {
    name,
    front_x_mm: data.front_x_mm,
    front_y_mm: data.front_y_mm,
    back_x_mm: data.back_x_mm,
    back_y_mm: data.back_y_mm,
    paper_size: data.paper_size,
    duplex_mode: data.duplex_mode,
  };
}

function unavailableStatus(error: unknown): 500 | 501 {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes("unavailable") ||
    normalized.includes("not configured") ||
    normalized.includes("no module named") ||
    normalized.includes("does not exist")
    ? 501
    : 500;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

export function createPrinterCalibrationRouter(
  options: PrinterCalibrationRouterOptions = {}
) {
  const router = express.Router();
  const dataDirectory = options.dataDirectory ?? path.resolve(process.cwd(), "data");
  const profilesPath = resolvePrinterCalibrationProfilesPath(
    options.configuredProfilesPath ?? process.env.PRINTER_CALIBRATION_PROFILES_PATH,
    dataDirectory
  );
  const runCli = options.runCli ?? runPrinterCalibrationCli;

  router.get("/sheet", async (_req: Request, res: Response) => {
    const outputPath = path.join(
      os.tmpdir(),
      `proxxied-printer-calibration-sheet-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`
    );

    try {
      await runCli(["sheet", "--output", outputPath]);
      res.setHeader("Content-Type", "application/pdf");
      res.download(outputPath, "printer_calibration_sheet.pdf", (error) => {
        unlinkQuiet(outputPath);
        if (error) {
          console.error("[printer-calibration] download error:", error);
        }
      });
    } catch (error: unknown) {
      unlinkQuiet(outputPath);
      res.status(unavailableStatus(error)).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get("/profiles", async (_req: Request, res: Response) => {
    try {
      const listResult = await runCli(["profile", "list", "--profile-file", profilesPath]);
      const names = listResult.stdout
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter(Boolean);

      const profiles = await Promise.all(
        names.map(async (name) => {
          const result = await runCli([
            "profile",
            "show",
            "--name",
            name,
            "--profile-file",
            profilesPath,
          ]);
          return parsePrinterCalibrationProfileOutput(name, result.stdout);
        })
      );

      const byName: Record<string, PrinterCalibrationProfile> = {};
      for (const profile of profiles) {
        byName[profile.name] = profile;
      }
      res.json(byName);
    } catch (error: unknown) {
      res.status(unavailableStatus(error)).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get("/profiles/:name", async (req: Request, res: Response) => {
    try {
      const name = String(req.params.name || "").trim();
      if (!name) {
        return res.status(400).json({ error: "Profile name is required." });
      }
      const result = await runCli([
        "profile",
        "show",
        "--name",
        name,
        "--profile-file",
        profilesPath,
      ]);
      res.json(parsePrinterCalibrationProfileOutput(name, result.stdout));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("not found") ? 404 : unavailableStatus(error);
      res.status(status).json({ error: message });
    }
  });

  router.put("/profiles/:name", async (req: Request, res: Response) => {
    try {
      const name = String(req.params.name || "").trim();
      if (!name) {
        return res.status(400).json({ error: "Profile name is required." });
      }
      const frontX = safeNumber(req.body.front_x_mm, "front_x_mm");
      const frontY = safeNumber(req.body.front_y_mm, "front_y_mm");
      const backX = safeNumber(req.body.back_x_mm, "back_x_mm");
      const backY = safeNumber(req.body.back_y_mm, "back_y_mm");

      await runCli([
        "profile",
        "set",
        "--name",
        name,
        "--front-x-mm",
        String(frontX),
        "--front-y-mm",
        String(frontY),
        "--back-x-mm",
        String(backX),
        "--back-y-mm",
        String(backY),
        "--profile-file",
        profilesPath,
      ]);

      const showResult = await runCli([
        "profile",
        "show",
        "--name",
        name,
        "--profile-file",
        profilesPath,
      ]);

      res.json({
        saved: true,
        profile: parsePrinterCalibrationProfileOutput(name, showResult.stdout),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.startsWith("Invalid number") ? 400 : unavailableStatus(error);
      res.status(status).json({ error: message });
    }
  });

  router.delete("/profiles/:name", async (req: Request, res: Response) => {
    try {
      const name = String(req.params.name || "").trim();
      if (!name) {
        return res.status(400).json({ error: "Profile name is required." });
      }
      await runCli([
        "profile",
        "delete",
        "--name",
        name,
        "--profile-file",
        profilesPath,
      ]);
      res.json({ deleted: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("not found") ? 404 : unavailableStatus(error);
      res.status(status).json({ error: message });
    }
  });

  router.post("/calculate", (req: Request, res: Response) => {
    try {
      const profile = calculatePrinterCalibrationProfile({
        front_x_measured_mm: safeNumber(
          req.body.front_x_measured_mm,
          "front_x_measured_mm"
        ),
        front_y_measured_mm: safeNumber(
          req.body.front_y_measured_mm,
          "front_y_measured_mm"
        ),
        back_x_measured_mm: safeNumber(
          req.body.back_x_measured_mm,
          "back_x_measured_mm"
        ),
        back_y_measured_mm: safeNumber(
          req.body.back_y_measured_mm,
          "back_y_measured_mm"
        ),
      });
      res.json(profile);
    } catch (error: unknown) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post(
    "/apply",
    upload.single("file"),
    async (req: Request, res: Response) => {
      const file = req.file;
      const profileName = String(req.body.profileName || "").trim();
      if (!file) {
        return res.status(400).json({ error: "Missing file upload." });
      }
      if (!profileName) {
        return res.status(400).json({ error: "Missing profileName." });
      }

      let inputPath: string | null = null;
      let outputPath: string | null = null;
      try {
        inputPath = writeTempFile(file.buffer, file.originalname || "input.pdf");
        outputPath = path.join(
          os.tmpdir(),
          `proxxied-printer-calibration-output-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`
        );
        await runCli([
          "apply",
          "--profile",
          profileName,
          "--input",
          inputPath,
          "--output",
          outputPath,
          "--profile-file",
          profilesPath,
        ]);
        res.setHeader("Content-Type", "application/pdf");
        res.download(outputPath, `${path.parse(file.originalname || "document").name}.calibrated.pdf`, (error) => {
          unlinkQuiet(inputPath);
          unlinkQuiet(outputPath);
          if (error) {
            console.error("[printer-calibration] apply download error:", error);
          }
        });
      } catch (error: unknown) {
        unlinkQuiet(inputPath);
        unlinkQuiet(outputPath);
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes("not found") ? 404 : unavailableStatus(error);
        res.status(status).json({ error: message });
      }
    }
  );

  return router;
}

export const printerCalibrationRouter = createPrinterCalibrationRouter();
