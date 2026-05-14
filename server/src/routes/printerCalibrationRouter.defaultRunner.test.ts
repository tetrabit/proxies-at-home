import { promises as fs } from "fs";
import os from "os";
import path from "path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrinterCalibrationRouter } from "./printerCalibrationRouter.js";

describe("printerCalibrationRouter default CLI runner", () => {
  let tempDirectory: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "printer-calibration-runner-"));
    originalEnv = { ...process.env };
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  function app() {
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use(
      "/api/printer-calibration",
      createPrinterCalibrationRouter({ dataDirectory: path.join(tempDirectory, "data") })
    );
    return expressApp;
  }

  async function writeExecutable(name: string, body: string) {
    const filePath = path.join(tempDirectory, name);
    await fs.writeFile(filePath, body, { mode: 0o755 });
    await fs.chmod(filePath, 0o755);
    return filePath;
  }

  it("runs a configured binary runner for profile list/show", async () => {
    const binPath = await writeExecutable(
      "printer-calibration-bin",
      `#!/bin/sh
if [ "$1 $2" = "profile list" ]; then
  printf 'office\\n'
  exit 0
fi
if [ "$1 $2" = "profile show" ]; then
  cat <<'PROFILE'
paper_size: letter
duplex_mode: long-edge
front_x_mm: 1
front_y_mm: 2
back_x_mm: 3
back_y_mm: 4
PROFILE
  exit 0
fi
printf 'unexpected args: %s\\n' "$*" >&2
exit 1
`
    );
    process.env.PRINTER_CALIBRATION_BIN = binPath;
    delete process.env.PRINTER_CALIBRATION_REPO;

    const response = await request(app()).get("/api/printer-calibration/profiles");

    expect(response.status).toBe(200);
    expect(response.body.office).toMatchObject({ front_x_mm: 1, back_y_mm: 4 });
  });

  it("uses a configured python repo through PYTHONPATH", async () => {
    const repoDir = path.join(tempDirectory, "repo");
    const cwdFile = path.join(tempDirectory, "cwd.txt");
    const pythonPathFile = path.join(tempDirectory, "pythonpath.txt");
    await fs.mkdir(path.join(repoDir, "src", "printer_calibration"), { recursive: true });
    const pythonPath = await writeExecutable(
      "python-custom",
      `#!/bin/sh
pwd > '${cwdFile}'
printf '%s' "$PYTHONPATH" > '${pythonPathFile}'
printf ''
exit 0
`
    );
    process.env.PRINTER_CALIBRATION_REPO = repoDir;
    process.env.PRINTER_CALIBRATION_PYTHON = pythonPath;
    delete process.env.PRINTER_CALIBRATION_BIN;

    const response = await request(app()).get("/api/printer-calibration/profiles");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
    expect((await fs.readFile(cwdFile, "utf8")).trim()).toBe(repoDir);
    expect((await fs.readFile(pythonPathFile, "utf8")).split(path.delimiter)[0]).toBe(
      path.join(repoDir, "src")
    );
  });

  it("continues past incompatible runners and reports final unavailable errors", async () => {
    const pythonPath = await writeExecutable(
      "python-custom",
      `#!/bin/sh
printf 'error: unrecognized option --profile-file\\n' >&2
exit 2
`
    );
    process.env.PRINTER_CALIBRATION_PYTHON = pythonPath;
    process.env.PRINTER_CALIBRATION_BIN = path.join(tempDirectory, "missing-bin");
    delete process.env.PRINTER_CALIBRATION_REPO;

    const response = await request(app()).get("/api/printer-calibration/profiles");

    expect(response.status).toBe(501);
    expect(response.body.error).toContain("Printer calibration unavailable");
  });
});
