import { promises as fs } from "fs";
import { randomUUID } from "node:crypto";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivateIdentity } from "../auth/privateRouteAuth.js";
import { createPrinterCalibrationRouter } from "./printerCalibrationRouter.js";

const fixtureState = vi.hoisted(() => ({ tmpdir: "" }));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const tmpdir = () => fixtureState.tmpdir;
  return {
    ...actual,
    tmpdir,
    default: { ...actual, tmpdir },
  };
});

const FIXTURE_PARENT_DIRECTORY = fileURLToPath(
  new URL("../../../.review-artifacts/calibration-auth-fixtures/", import.meta.url)
);

async function createRetainedFixtureDirectory(label: string): Promise<string> {
  await fs.mkdir(FIXTURE_PARENT_DIRECTORY, { recursive: true });
  const directory = path.join(
    FIXTURE_PARENT_DIRECTORY,
    `${label}-${process.pid}-${Date.now()}-${randomUUID()}`
  );
  await fs.mkdir(directory);
  return directory;
}

const testIdentity: PrivateIdentity = {
  ownerId: "default-runner-test-owner",
  capabilities: new Set(["calibration:read", "calibration:write"]),
  transport: "server",
};

describe("printerCalibrationRouter default CLI runner", () => {
  let tempDirectory: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempDirectory = await createRetainedFixtureDirectory("default-runner");
    fixtureState.tmpdir = tempDirectory;
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function app() {
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use((req, _res, next) => {
      req.privateIdentity = testIdentity;
      next();
    });
    expressApp.use(
      "/api/printer-calibration",
      createPrinterCalibrationRouter({
        dataDirectory: path.join(tempDirectory, "data"),
        privateRouteAuth: { private: () => (_req, _res, next) => next() },
      })
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

  const realRuntime = process.env.PRINTER_CALIBRATION_REAL_BIN;
  const realRuntimeTest = realRuntime ? it : it.skip;
  realRuntimeTest("calculates and persists a profile through the installed runtime", async () => {
    process.env.PRINTER_CALIBRATION_BIN = realRuntime;
    process.env.PRINTER_CALIBRATION_PYTHON = process.env.PRINTER_CALIBRATION_REAL_PYTHON;
    delete process.env.PRINTER_CALIBRATION_REPO;

    const calculated = await request(app())
      .post("/api/printer-calibration/calculate")
      .send({
        front_x_measured_mm: 0.25,
        front_y_measured_mm: -0.5,
        back_x_measured_mm: 0.75,
        back_y_measured_mm: -1,
      });
    expect(calculated.status).toBe(200);
    expect(calculated.body).toEqual({
      front_x_mm: 107.7,
      front_y_mm: 140.2,
      back_x_mm: 107.2,
      back_y_mm: 140.7,
      paper_size: "letter",
      duplex_mode: "long-edge",
    });

    const saved = await request(app())
      .put("/api/printer-calibration/profiles/real-runtime")
      .send(calculated.body);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      saved: true,
      profile: {
        name: "real-runtime",
        paper_size: "letter",
        duplex_mode: "long-edge",
        ...calculated.body,
      },
    });

    const listed = await request(app()).get("/api/printer-calibration/profiles");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ "real-runtime": saved.body.profile });
    const readBack = await request(app()).get("/api/printer-calibration/profiles/real-runtime");
    expect(readBack.status).toBe(200);
    expect(readBack.body).toEqual(saved.body.profile);
  });
});
