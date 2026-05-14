import { EventEmitter } from "events";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SpawnCall = {
  cmd: string;
  args: string[];
  opts: { cwd?: string; env?: Record<string, string> };
};

type SpawnPlan = {
  code?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
};

function createMockChildProcess(plan: SpawnPlan) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: (encoding: string) => void };
    stderr: EventEmitter & { setEncoding: (encoding: string) => void };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.kill = vi.fn(() => true);

  process.nextTick(() => {
    if (plan.error) {
      child.emit("error", plan.error);
      return;
    }
    if (plan.stdout) child.stdout.emit("data", plan.stdout);
    if (plan.stderr) child.stderr.emit("data", plan.stderr);
    child.emit("close", plan.code ?? 0);
  });

  return child;
}

describe("printerCalibrationRouter default CLI runner", () => {
  let tempDirectory: string;
  let originalEnv: NodeJS.ProcessEnv;
  let spawnCalls: SpawnCall[];
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "printer-calibration-runner-"));
    originalEnv = { ...process.env };
    spawnCalls = [];
    vi.resetModules();
  });

  afterEach(async () => {
    process.env = originalEnv;
    vi.doUnmock("child_process");
    vi.resetModules();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  async function loadApp(plans: SpawnPlan[]) {
    spawnMock = vi.fn((cmd: string, args: string[], opts: SpawnCall["opts"]) => {
      spawnCalls.push({ cmd, args, opts });
      const plan = plans.shift() ?? { code: 0 };
      return createMockChildProcess(plan);
    });
    vi.doMock("child_process", () => ({ spawn: spawnMock }));

    const { createPrinterCalibrationRouter } = await import("./printerCalibrationRouter.js");
    const app = express();
    app.use(express.json());
    app.use(
      "/api/printer-calibration",
      createPrinterCalibrationRouter({ dataDirectory: path.join(tempDirectory, "data") })
    );
    return app;
  }

  it("runs a configured binary runner for profile list/show", async () => {
    const binPath = path.join(tempDirectory, "printer-calibration-bin");
    await fs.writeFile(binPath, "#!/bin/sh\nexit 0\n");
    process.env.PRINTER_CALIBRATION_BIN = binPath;
    delete process.env.PRINTER_CALIBRATION_REPO;

    const app = await loadApp([
      { stdout: "office\n" },
      {
        stdout: [
          "paper_size: letter",
          "duplex_mode: long-edge",
          "front_x_mm: 1",
          "front_y_mm: 2",
          "back_x_mm: 3",
          "back_y_mm: 4",
        ].join("\n"),
      },
    ]);

    const response = await request(app).get("/api/printer-calibration/profiles");

    expect(response.status).toBe(200);
    expect(response.body.office).toMatchObject({ front_x_mm: 1, back_y_mm: 4 });
    expect(spawnCalls[0]).toMatchObject({ cmd: binPath });
    expect(spawnCalls[0].args).toEqual([
      "profile",
      "list",
      "--profile-file",
      path.join(tempDirectory, "data", "printer-calibration", "profiles.toml"),
    ]);
  });

  it("uses a configured python repo through PYTHONPATH", async () => {
    const repoDir = path.join(tempDirectory, "repo");
    await fs.mkdir(path.join(repoDir, "src", "printer_calibration"), { recursive: true });
    process.env.PRINTER_CALIBRATION_REPO = repoDir;
    process.env.PRINTER_CALIBRATION_PYTHON = "python-custom";
    delete process.env.PRINTER_CALIBRATION_BIN;

    const app = await loadApp([{ stdout: "" }]);
    const response = await request(app).get("/api/printer-calibration/profiles");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
    expect(spawnCalls[0].cmd).toBe("python-custom");
    expect(spawnCalls[0].args.slice(0, 2)).toEqual(["-m", "printer_calibration"]);
    expect(spawnCalls[0].opts.cwd).toBe(repoDir);
    expect(spawnCalls[0].opts.env?.PYTHONPATH?.split(path.delimiter)[0]).toBe(
      path.join(repoDir, "src")
    );
  });

  it("continues past incompatible runners and reports final unavailable errors", async () => {
    process.env.PRINTER_CALIBRATION_PYTHON = "python-custom";
    delete process.env.PRINTER_CALIBRATION_BIN;
    delete process.env.PRINTER_CALIBRATION_REPO;

    const app = await loadApp([
      { code: 2, stderr: "error: unrecognized option --profile-file" },
      { error: Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" }) },
      { error: Object.assign(new Error("spawn python ENOENT"), { code: "ENOENT" }) },
      { error: Object.assign(new Error("spawn printer-calibration ENOENT"), { code: "ENOENT" }) },
    ]);

    const response = await request(app).get("/api/printer-calibration/profiles");

    expect(response.status).toBe(501);
    expect(response.body.error).toContain("Printer calibration unavailable");
    expect(spawnCalls.map((call) => call.cmd)).toEqual([
      "python-custom",
      "python3",
      "python",
      "printer-calibration",
    ]);
  });
});
