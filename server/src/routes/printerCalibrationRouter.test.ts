import nativeFs, { promises as fs } from "fs";
import { randomUUID } from "node:crypto";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const filesystemState = vi.hoisted(() => ({
  tmpdir: "",
}));

const createWriteStreamSpy = vi.spyOn(nativeFs, "createWriteStream");
const unlinkSyncSpy = vi.spyOn(nativeFs, "unlinkSync").mockImplementation(() => undefined);

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const tmpdir = () => filesystemState.tmpdir;
  return {
    ...actual,
    tmpdir,
    default: { ...actual, tmpdir },
  };
});

import {
  createPrivateRouteAuth,
  type PrivateCredentialVerifier,
  type PrivateIdentity,
} from "../auth/privateRouteAuth.js";
import {
  CALIBRATION_UPLOAD_LIMIT_BYTES,
  __printerCalibrationTestInternals,
  buildPythonCliArgs,
  calculatePrinterCalibrationProfile,
  createPrinterCalibrationRouter,
  detectDefaultPrinterCalibrationRepo,
  parsePrinterCalibrationProfileOutput,
  resolvePrinterCalibrationProfilesPath,
  shouldTryNextPrinterCalibrationRunner,
  type PrinterCalibrationProfile,
} from "./printerCalibrationRouter.js";

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

describe("printer calibration route authorization", () => {
  const reader: PrivateIdentity = {
    ownerId: "server-owner-a",
    capabilities: new Set(["calibration:read"]),
    transport: "server",
  };
  const writer: PrivateIdentity = {
    ownerId: "server-owner-a",
    capabilities: new Set(["calibration:write"]),
    transport: "server",
  };

  function verifierFor(...identities: Array<[string, PrivateIdentity]>): PrivateCredentialVerifier {
    return {
      verifyBearer: vi.fn((bearer: string) =>
        identities.find(([configuredBearer]) => configuredBearer === bearer)?.[1] ?? null
      ),
    };
  }

  it("authenticates before calibration runners or Multer allocate upload files", async () => {
    const runCli = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const fixtureDirectory = await createRetainedFixtureDirectory("route-auth");
    filesystemState.tmpdir = fixtureDirectory;
    const app = express();
    app.use(express.json());
    app.use(
      "/api/printer-calibration",
      createPrinterCalibrationRouter({
        dataDirectory: path.join(fixtureDirectory, "data"),
        runCli,
        privateRouteAuth: createPrivateRouteAuth(verifierFor(["reader", reader], ["writer", writer])),
      })
    );
    createWriteStreamSpy.mockClear();

    const unauthenticatedList = await request(app).get("/api/printer-calibration/profiles");
    const forbiddenList = await request(app)
      .get("/api/printer-calibration/profiles")
      .set("Authorization", "Bearer writer");
    const forbiddenCalculate = await request(app)
      .post("/api/printer-calibration/calculate")
      .set("Authorization", "Bearer reader")
      .send({});
    const unauthenticatedUpload = await request(app)
      .post("/api/printer-calibration/apply")
      .attach("file", Buffer.from("%PDF-1.4\ninput\n"), "input.pdf");

    expect(unauthenticatedList.status).toBe(401);
    expect(unauthenticatedList.body).toEqual({ error: "unauthorized" });
    expect(forbiddenList.status).toBe(403);
    expect(forbiddenList.body).toEqual({ error: "forbidden" });
    expect(forbiddenCalculate.status).toBe(403);
    expect(forbiddenCalculate.body).toEqual({ error: "forbidden" });
    expect(unauthenticatedUpload.status).toBe(401);
    expect(unauthenticatedUpload.body).toEqual({ error: "unauthorized" });
    expect(runCli).not.toHaveBeenCalled();
    expect(createWriteStreamSpy).not.toHaveBeenCalled();

    const authorizedCalculate = await request(app)
      .post("/api/printer-calibration/calculate")
      .set("Authorization", "Bearer writer")
      .send({
        front_x_measured_mm: 1,
        front_y_measured_mm: 2,
        back_x_measured_mm: 3,
        back_y_measured_mm: 4,
      });
    expect(authorizedCalculate.status).toBe(200);
  });

  it("derives profile namespaces from verified owners and rejects legacy global profile paths", async () => {
    const fixtureDirectory = await createRetainedFixtureDirectory("owner-isolation");
    filesystemState.tmpdir = fixtureDirectory;
    const ownerA: PrivateIdentity = {
      ...writer,
      capabilities: new Set(["calibration:read", "calibration:write"]),
    };
    const ownerB: PrivateIdentity = {
      ...reader,
      ownerId: "server-owner-b",
      capabilities: new Set(["calibration:read", "calibration:write"]),
    };
    const profilesByPath = new Map<string, PrinterCalibrationProfile>();
    const runCli = vi.fn(async (args: string[]) => {
      const profilePath = args[args.indexOf("--profile-file") + 1];
      const name = args[args.indexOf("--name") + 1];
      if (args[0] === "profile" && args[1] === "set") {
        profilesByPath.set(profilePath, {
          name,
          front_x_mm: Number(args[args.indexOf("--front-x-mm") + 1]),
          front_y_mm: Number(args[args.indexOf("--front-y-mm") + 1]),
          back_x_mm: Number(args[args.indexOf("--back-x-mm") + 1]),
          back_y_mm: Number(args[args.indexOf("--back-y-mm") + 1]),
        });
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "profile" && args[1] === "show") {
        const profile = profilesByPath.get(profilePath);
        if (profile) {
          return {
            stdout: `front_x_mm: ${profile.front_x_mm}\nfront_y_mm: ${profile.front_y_mm}\nback_x_mm: ${profile.back_x_mm}\nback_y_mm: ${profile.back_y_mm}`,
            stderr: "",
          };
        }
      }
      throw new Error("Profile not found");
    });
    const app = express();
    app.use(express.json());
    app.use(
      "/api/printer-calibration",
      createPrinterCalibrationRouter({
        dataDirectory: path.join(fixtureDirectory, "data"),
        runCli,
        privateRouteAuth: createPrivateRouteAuth(
          verifierFor(["owner-a", ownerA], ["owner-b", ownerB])
        ),
      })
    );

    const saved = await request(app)
      .put("/api/printer-calibration/profiles/office?ownerId=client-controlled-owner")
      .set("Authorization", "Bearer owner-a")
      .send({ front_x_mm: 1, front_y_mm: 2, back_x_mm: 3, back_y_mm: 4 });
    const otherOwner = await request(app)
      .get("/api/printer-calibration/profiles/office?ownerId=server-owner-a")
      .set("Authorization", "Bearer owner-b");
    const owner = await request(app)
      .get("/api/printer-calibration/profiles/office?profilesPath=client-controlled-path")
      .set("Authorization", "Bearer owner-a");

    expect(saved.status).toBe(200);
    expect(otherOwner.status).toBe(404);
    expect(owner.status).toBe(200);
    const usedPaths = runCli.mock.calls
      .map(([args]) => (args as string[])[(args as string[]).indexOf("--profile-file") + 1])
      .filter(Boolean);
    expect(new Set(usedPaths).size).toBe(2);
    expect(usedPaths.some((profilePath) => profilePath.includes("server-owner-a"))).toBe(false);
    expect(usedPaths.some((profilePath) => profilePath.includes("server-owner-b"))).toBe(false);

    expect(() =>
      createPrinterCalibrationRouter({
        dataDirectory: path.join(fixtureDirectory, "legacy-global"),
        configuredProfilesPath: "printer-calibration/profiles.toml",
        privateRouteAuth: createPrivateRouteAuth(verifierFor(["owner-a", writer])),
      })
    ).toThrow("legacy global profile path");
  });
});

const functionalTestIdentity: PrivateIdentity = {
  ownerId: "functional-test-owner",
  capabilities: new Set(["calibration:read", "calibration:write"]),
  transport: "server",
};

function mountAuthorizedCalibrationRouter(
  app: express.Express,
  options: Parameters<typeof createPrinterCalibrationRouter>[0]
): void {
  app.use(express.json());
  app.use((req, _res, next) => {
    req.privateIdentity = functionalTestIdentity;
    next();
  });
  app.use(
    "/api/printer-calibration",
    createPrinterCalibrationRouter({
      ...options,
      privateRouteAuth: { private: () => (_req, _res, next) => next() },
    })
  );
}

function installRetainedDownloadBoundary(): () => void {
  const downloadSpy = vi.spyOn(express.response, "download").mockImplementation(function (
    this: express.Response,
    ...args: Parameters<typeof express.response.download>
  ) {
    const [filePath, filename, optionsOrCallback, callback] = args;
    const completion =
      typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
    void fs.readFile(filePath).then(
      (contents) => {
        this.attachment(filename);
        this.send(contents);
        completion?.(undefined as never);
      },
      (error: unknown) => {
        completion?.(error instanceof Error ? error : new Error(String(error)));
        if (!this.headersSent) this.status(500).end();
      }
    );
  });
  return () => downloadSpy.mockRestore();
}

describe("printerCalibrationRouter", () => {
  let tempDirectory: string;
  let dataDirectory: string;
  let app: express.Express;
  let profiles = new Map<string, PrinterCalibrationProfile>();
  let applyInvocations: string[][] = [];
  let restoreDownloadBoundary: () => void = () => undefined;

  beforeEach(async () => {
    tempDirectory = await createRetainedFixtureDirectory("router");
    filesystemState.tmpdir = tempDirectory;
    dataDirectory = path.join(tempDirectory, "data");
    profiles = new Map();
    applyInvocations = [];

    const runCli = vi.fn(async (args: string[]) => {
      const [command, subcommand] = args;
      if (command === "sheet") {
        const outputIndex = args.indexOf("--output");
        const outputPath = args[outputIndex + 1];
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, "%PDF-1.4\nmock sheet\n");
        return { stdout: "", stderr: "" };
      }

      if (command === "profile" && subcommand === "list") {
        return { stdout: `${Array.from(profiles.keys()).join("\n")}${profiles.size ? "\n" : ""}`, stderr: "" };
      }

      if (command === "profile" && subcommand === "show") {
        const name = args[args.indexOf("--name") + 1];
        const profile = profiles.get(name);
        if (!profile) {
          throw new Error(`Profile '${name}' not found`);
        }
        return {
          stdout: [
            `paper_size: ${profile.paper_size ?? "letter"}`,
            `duplex_mode: ${profile.duplex_mode ?? "long-edge"}`,
            `front_x_mm: ${profile.front_x_mm}`,
            `front_y_mm: ${profile.front_y_mm}`,
            `back_x_mm: ${profile.back_x_mm}`,
            `back_y_mm: ${profile.back_y_mm}`,
          ].join("\n"),
          stderr: "",
        };
      }

      if (command === "profile" && subcommand === "set") {
        const name = args[args.indexOf("--name") + 1];
        profiles.set(name, {
          name,
          front_x_mm: Number(args[args.indexOf("--front-x-mm") + 1]),
          front_y_mm: Number(args[args.indexOf("--front-y-mm") + 1]),
          back_x_mm: Number(args[args.indexOf("--back-x-mm") + 1]),
          back_y_mm: Number(args[args.indexOf("--back-y-mm") + 1]),
          paper_size: "letter",
          duplex_mode: "long-edge",
        });
        return { stdout: "saved", stderr: "" };
      }

      if (command === "profile" && subcommand === "delete") {
        const name = args[args.indexOf("--name") + 1];
        if (!profiles.delete(name)) {
          throw new Error(`Profile '${name}' not found`);
        }
        return { stdout: "deleted", stderr: "" };
      }

      if (command === "apply") {
        applyInvocations.push(args);
        const outputPath = args[args.indexOf("--output") + 1];
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, "%PDF-1.4\nmock calibrated\n");
        return { stdout: "applied", stderr: "" };
      }

      throw new Error(`Unhandled args: ${args.join(" ")}`);
    });

    app = express();
    mountAuthorizedCalibrationRouter(app, { dataDirectory, runCli });
    restoreDownloadBoundary = installRetainedDownloadBoundary();
  });

  it("allows calibration uploads up to 10 GB", () => {
    expect(CALIBRATION_UPLOAD_LIMIT_BYTES).toBe(10 * 1024 * 1024 * 1024);
  });

  afterEach(() => {
    restoreDownloadBoundary();
    unlinkSyncSpy.mockClear();
  });

  it("rejects configured paths that escape the data directory", () => {
    expect(() =>
      resolvePrinterCalibrationProfilesPath("../outside.toml", dataDirectory)
    ).toThrow(
      `PRINTER_CALIBRATION_PROFILES_PATH must stay within ${path.resolve(dataDirectory)}`
    );
    expect(
      resolvePrinterCalibrationProfilesPath(
        path.join(dataDirectory, "inside", "profiles.toml"),
        dataDirectory
      )
    ).toBe(path.join(dataDirectory, "inside", "profiles.toml"));
  });

  it("calculates translation offsets from measured values", () => {
    const result = calculatePrinterCalibrationProfile({
      front_x_measured_mm: 111.14,
      front_y_measured_mm: 136.84,
      back_x_measured_mm: 110.5,
      back_y_measured_mm: 140.7,
    });

    expect(result.front_x_mm).toBeCloseTo(-3.19);
    expect(result.front_y_mm).toBeCloseTo(2.86);
    expect(result.back_x_mm).toBeCloseTo(-2.55);
    expect(result.back_y_mm).toBeCloseTo(-1);
    expect(result.paper_size).toBe("letter");
    expect(result.duplex_mode).toBe("long-edge");
  });

  it("parses profile show output", () => {
    expect(
      parsePrinterCalibrationProfileOutput(
        "office",
        [
          "paper_size: letter",
          "duplex_mode: long-edge",
          "front_x_mm: -3.19",
          "front_y_mm: 2.86",
          "back_x_mm: -3.19",
          "back_y_mm: 2.86",
        ].join("\n")
      )
    ).toEqual({
      name: "office",
      paper_size: "letter",
      duplex_mode: "long-edge",
      front_x_mm: -3.19,
      front_y_mm: 2.86,
      back_x_mm: -3.19,
      back_y_mm: 2.86,
    });
  });

  it("detects the vendored printer calibration repo from a server cwd", async () => {
    const originalCwd = process.cwd();
    const originalHome = process.env.HOME;
    const repoRoot = path.join(tempDirectory, "workspace", "proxies-at-home");
    const serverRoot = path.join(repoRoot, "server");
    const vendorRepo = path.join(serverRoot, "vendor", "printer-calibration");

    await fs.mkdir(path.join(vendorRepo, "src", "printer_calibration"), {
      recursive: true,
    });

    process.env.HOME = path.join(tempDirectory, "no-home-match");
    process.chdir(serverRoot);
    try {
      expect(detectDefaultPrinterCalibrationRepo()).toBe(
        vendorRepo
      );
    } finally {
      process.chdir(originalCwd);
      process.env.HOME = originalHome;
    }
  });

  it("builds python module invocations through the package entrypoint", () => {
    expect(buildPythonCliArgs(["apply", "--profile", "office"])).toEqual([
      "-m",
      "printer_calibration",
      "apply",
      "--profile",
      "office",
    ]);
  });

  it("continues to the next runner for missing or incompatible cli implementations", () => {
    expect(
      shouldTryNextPrinterCalibrationRunner(
        "printer-calibration failed (code=2): error: unrecognized arguments: --page-mode duplex"
      )
    ).toBe(true);
    expect(
      shouldTryNextPrinterCalibrationRunner(
        "Printer calibration unavailable. No module named printer_calibration"
      )
    ).toBe(true);
    expect(
      shouldTryNextPrinterCalibrationRunner("printer-calibration failed (code=1): invalid profile")
    ).toBe(false);
  });

  it("returns an empty profile map when nothing is saved", async () => {
    const response = await request(app).get("/api/printer-calibration/profiles");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
  });

  it("creates, lists, loads, and deletes profiles", async () => {
    const createResponse = await request(app)
      .put("/api/printer-calibration/profiles/office")
      .send({
        front_x_mm: -3.19,
        front_y_mm: 2.86,
        back_x_mm: -3.19,
        back_y_mm: 2.86,
      });
    expect(createResponse.status).toBe(200);
    expect(createResponse.body.saved).toBe(true);

    const listResponse = await request(app).get("/api/printer-calibration/profiles");
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.office).toMatchObject({
      name: "office",
      front_x_mm: -3.19,
      back_y_mm: 2.86,
    });

    const getResponse = await request(app).get(
      "/api/printer-calibration/profiles/office"
    );
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.name).toBe("office");

    const deleteResponse = await request(app).delete(
      "/api/printer-calibration/profiles/office"
    );
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body).toEqual({ deleted: true });
  });

  it("returns 400 for malformed calculate payloads", async () => {
    const response = await request(app)
      .post("/api/printer-calibration/calculate")
      .send({ front_x_measured_mm: "nope" });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid number");
  });

  it("returns 400 when calculate numeric fields are missing", async () => {
    const response = await request(app)
      .post("/api/printer-calibration/calculate")
      .send({
        front_x_measured_mm: 111.14,
        front_y_measured_mm: 136.84,
        back_x_measured_mm: 110.5,
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid number for back_y_measured_mm");
  });

  it("returns 400 when apply is missing required fields", async () => {
    const response = await request(app)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office");
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Missing file upload.");
  });

  it("returns 400 for blank profile names on profile routes", async () => {
    const getResponse = await request(app).get("/api/printer-calibration/profiles/%20");
    expect(getResponse.status).toBe(400);
    expect(getResponse.body.error).toBe("Profile name is required.");

    const putResponse = await request(app)
      .put("/api/printer-calibration/profiles/%20")
      .send({ front_x_mm: 0, front_y_mm: 0, back_x_mm: 0, back_y_mm: 0 });
    expect(putResponse.status).toBe(400);
    expect(putResponse.body.error).toBe("Profile name is required.");

    const deleteResponse = await request(app).delete("/api/printer-calibration/profiles/%20");
    expect(deleteResponse.status).toBe(400);
    expect(deleteResponse.body.error).toBe("Profile name is required.");
  });

  it("returns calibrated pdfs from the apply endpoint", async () => {
    profiles.set("office", {
      name: "office",
      front_x_mm: 1,
      front_y_mm: 2,
      back_x_mm: 3,
      back_y_mm: 4,
      paper_size: "letter",
      duplex_mode: "long-edge",
    });

    const response = await request(app)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office")
      .attach("file", Buffer.from("%PDF-1.4\ninput\n"), "input.pdf");

    expect(response.status).toBe(200);
    expect(response.header["content-type"]).toContain("application/pdf");
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(applyInvocations).toHaveLength(1);
    expect(applyInvocations[0]).toContain("--page-mode");
    expect(applyInvocations[0][applyInvocations[0].indexOf("--page-mode") + 1]).toBe("duplex");
  });

  it("uses the default runner path when no CLI is injected", async () => {
    const originalEnv = { ...process.env };
    const binPath = path.join(tempDirectory, "printer-calibration-bin");
    await fs.writeFile(
      binPath,
      `#!/bin/sh
if [ "$1" = "sheet" ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--output" ]; then
      shift
      printf '%s\\n' '%PDF-1.4 mock sheet' > "$1"
      exit 0
    fi
    shift
  done
fi
exit 1
`,
      { mode: 0o755 }
    );
    await fs.chmod(binPath, 0o755);
    process.env = {
      ...originalEnv,
      PRINTER_CALIBRATION_BIN: binPath,
      PRINTER_CALIBRATION_REPO: "",
    };

    try {
      const defaultApp = express();
      mountAuthorizedCalibrationRouter(defaultApp, { dataDirectory });

      const response = await request(defaultApp).get("/api/printer-calibration/sheet");
      expect(response.status).toBe(200);
      expect(response.header["content-type"]).toContain("application/pdf");
    } finally {
      process.env = originalEnv;
    }
  });

  it("exposes runner internals for configured binary, python, process, and cleanup branches", async () => {
    const originalEnv = { ...process.env };
    const originalCwd = process.cwd();
    try {
      const scriptsDirectory = path.join(tempDirectory, "scripts");
      await fs.mkdir(scriptsDirectory, { recursive: true });

      const echoScript = path.join(scriptsDirectory, "echo.sh");
      await fs.writeFile(echoScript, "#!/bin/sh\necho ok\n", { mode: 0o755 });
      await fs.chmod(echoScript, 0o755);
      await expect(
        __printerCalibrationTestInternals.runProcess(echoScript, [])
      ).resolves.toMatchObject({ stdout: "ok\n", code: 0 });
      await expect(
        __printerCalibrationTestInternals.runProcess(path.join(scriptsDirectory, "missing-command"), [])
      ).rejects.toThrow();

      const terminatingScript = path.join(scriptsDirectory, "terminates.sh");
      await fs.writeFile(terminatingScript, "#!/bin/sh\nkill -TERM $$\n", { mode: 0o755 });
      await fs.chmod(terminatingScript, 0o755);
      await expect(
        __printerCalibrationTestInternals.runProcess(terminatingScript, [], { timeoutMs: 1_000 })
      ).resolves.toMatchObject({ code: -1 });

      const sleepingScript = path.join(scriptsDirectory, "sleeps.sh");
      await fs.writeFile(sleepingScript, "#!/bin/sh\nsleep 1\n", { mode: 0o755 });
      await fs.chmod(sleepingScript, 0o755);
      await expect(
        __printerCalibrationTestInternals.runProcess(sleepingScript, [], { timeoutMs: 5 })
      ).rejects.toThrow("timed out");

      const failingBin = path.join(scriptsDirectory, "printer-calibration-bin");
      await fs.writeFile(failingBin, "#!/bin/sh\necho bad-bin >&2\nexit 7\n", { mode: 0o755 });
      await fs.chmod(failingBin, 0o755);
      process.env = {
        ...originalEnv,
        PRINTER_CALIBRATION_BIN: path.join(scriptsDirectory, "missing-bin"),
        PRINTER_CALIBRATION_REPO: "",
        PRINTER_CALIBRATION_PYTHON: failingBin,
      };
      await expect(
        __printerCalibrationTestInternals.runPrinterCalibrationCli(["profile", "list"])
      ).rejects.toThrow();

      process.env = {
        ...originalEnv,
        PRINTER_CALIBRATION_BIN: failingBin,
        PRINTER_CALIBRATION_REPO: "",
        PRINTER_CALIBRATION_PYTHON: "",
      };
      await expect(
        __printerCalibrationTestInternals.runPrinterCalibrationCli(["profile", "list"])
      ).rejects.toThrow("code=7");

      const stdoutFailingBin = path.join(scriptsDirectory, "printer-calibration-bin-stdout");
      await fs.writeFile(stdoutFailingBin, "#!/bin/sh\necho bad-bin-stdout\nexit 6\n", { mode: 0o755 });
      await fs.chmod(stdoutFailingBin, 0o755);
      process.env = {
        ...originalEnv,
        PRINTER_CALIBRATION_BIN: stdoutFailingBin,
        PRINTER_CALIBRATION_REPO: "",
        PRINTER_CALIBRATION_PYTHON: "",
      };
      await expect(
        __printerCalibrationTestInternals.runPrinterCalibrationCli(["profile", "list"])
      ).rejects.toThrow("bad-bin-stdout");

      const repoDir = path.join(tempDirectory, "printer-calibration");
      await fs.mkdir(path.join(repoDir, "src", "printer_calibration"), { recursive: true });
      const pythonShim = path.join(scriptsDirectory, "python-shim");
      await fs.writeFile(
        pythonShim,
        "#!/bin/sh\necho \"$PYTHONPATH\"\necho py-bad >&2\nexit 9\n",
        { mode: 0o755 }
      );
      await fs.chmod(pythonShim, 0o755);
      process.env = {
        ...originalEnv,
        PRINTER_CALIBRATION_BIN: "",
        PRINTER_CALIBRATION_REPO: repoDir,
        PRINTER_CALIBRATION_PYTHON: pythonShim,
        PYTHONPATH: "existing-pythonpath",
      };
      await expect(
        __printerCalibrationTestInternals.runPrinterCalibrationCli(["profile", "list"])
      ).rejects.toThrow("code=9");

      const stdoutFailingPython = path.join(scriptsDirectory, "python-stdout-fail");
      await fs.writeFile(stdoutFailingPython, "#!/bin/sh\necho py-stdout-bad\nexit 8\n", { mode: 0o755 });
      await fs.chmod(stdoutFailingPython, 0o755);
      process.env = {
        ...originalEnv,
        PRINTER_CALIBRATION_BIN: "",
        PRINTER_CALIBRATION_REPO: repoDir,
        PRINTER_CALIBRATION_PYTHON: stdoutFailingPython,
        PYTHONPATH: "",
      };
      await expect(
        __printerCalibrationTestInternals.runPrinterCalibrationCli(["profile", "list"])
      ).rejects.toThrow("py-stdout-bad");

      const successPython = path.join(scriptsDirectory, "python-success");
      await fs.writeFile(successPython, "#!/bin/sh\necho py-ok\nexit 0\n", { mode: 0o755 });
      await fs.chmod(successPython, 0o755);
      process.env = {
        ...originalEnv,
        PRINTER_CALIBRATION_BIN: "",
        PRINTER_CALIBRATION_REPO: repoDir,
        PRINTER_CALIBRATION_PYTHON: successPython,
        PYTHONPATH: "",
      };
      await expect(
        __printerCalibrationTestInternals.runPrinterCalibrationCli(["profile", "list"])
      ).resolves.toEqual({ stdout: "py-ok\n", stderr: "" });

      process.env = {
        ...originalEnv,
        HOME: "",
        USERPROFILE: path.join(tempDirectory, "profile-home"),
        PRINTER_CALIBRATION_BIN: "",
        PRINTER_CALIBRATION_REPO: repoDir,
        PRINTER_CALIBRATION_PYTHON: pythonShim,
      };
      process.chdir(tempDirectory);
      const runners = __printerCalibrationTestInternals.resolveRunners();
      expect(runners.some((runner) => runner.kind === "python")).toBe(true);

      const tempPath = __printerCalibrationTestInternals.buildTempFilePath("unit", "");
      expect(tempPath).toMatch(/\.bin$/);
      const doomed = path.join(tempDirectory, "retained-unlink-boundary.txt");
      await fs.writeFile(doomed, "retain me");
      unlinkSyncSpy.mockClear();
      __printerCalibrationTestInternals.unlinkQuiet(null);
      __printerCalibrationTestInternals.unlinkQuiet(doomed);
      expect(unlinkSyncSpy).toHaveBeenCalledTimes(1);
      expect(unlinkSyncSpy).toHaveBeenCalledWith(doomed);
      await expect(fs.readFile(doomed, "utf8")).resolves.toBe("retain me");

      expect(__printerCalibrationTestInternals.unavailableStatus("not configured")).toBe(501);
    } finally {
      process.chdir(originalCwd);
      process.env = originalEnv;
    }
  });

  it("logs download callback failures when calibrated pdf delivery fails", async () => {
    profiles.set("office", {
      name: "office",
      front_x_mm: 1,
      front_y_mm: 2,
      back_x_mm: 3,
      back_y_mm: 4,
      paper_size: "letter",
      duplex_mode: "long-edge",
    });

    const downloadSpy = vi.spyOn(express.response, "download").mockImplementation(function (
      this: express.Response,
      _path: string,
      _filename: string,
      callback?: (err?: Error) => void
    ) {
      callback?.(new Error("download failed"));
      this.status(200).end();
      return this;
    });
    const consoleErrorSpy = vi.spyOn(console, "error");

    const response = await request(app)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office")
      .attach("file", Buffer.from("%PDF-1.4\ninput\n"), "input.pdf");

    expect(response.status).toBe(200);
    expect(downloadSpy).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[printer-calibration] apply download error:",
      expect.any(Error)
    );

    downloadSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("falls back to a .bin temp extension when the upload has no extension", async () => {
    profiles.set("office", {
      name: "office",
      front_x_mm: 1,
      front_y_mm: 2,
      back_x_mm: 3,
      back_y_mm: 4,
      paper_size: "letter",
      duplex_mode: "long-edge",
    });

    const response = await request(app)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office")
      .attach("file", Buffer.from("%PDF-1.4\ninput\n"), "input");

    expect(response.status).toBe(200);
    expect(applyInvocations[0].some((arg) => arg.endsWith(".bin"))).toBe(true);
  });

  it("passes back-only page mode to the apply command", async () => {
    profiles.set("office", {
      name: "office",
      front_x_mm: 1,
      front_y_mm: 2,
      back_x_mm: 3,
      back_y_mm: 4,
      paper_size: "letter",
      duplex_mode: "long-edge",
    });

    const response = await request(app)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office")
      .field("pageMode", "back-only")
      .attach("file", Buffer.from("%PDF-1.4\ninput\n"), "input.pdf");

    expect(response.status).toBe(200);
    expect(applyInvocations).toHaveLength(1);
    expect(applyInvocations[0][applyInvocations[0].indexOf("--page-mode") + 1]).toBe("back-only");
  });

  it("passes grouped-duplex ordering and front-page count to the apply command", async () => {
    const response = await request(app)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office")
      .field("pageMode", "grouped-duplex")
      .field("frontPageCount", "2")
      .attach("file", Buffer.from("%PDF-1.4\ninput\n"), "input.pdf");

    expect(response.status).toBe(200);
    expect(applyInvocations).toHaveLength(1);
    expect(applyInvocations[0]).toContain("--page-mode");
    expect(applyInvocations[0][applyInvocations[0].indexOf("--page-mode") + 1]).toBe("grouped-duplex");
    expect(applyInvocations[0]).toContain("--front-page-count");
    expect(applyInvocations[0][applyInvocations[0].indexOf("--front-page-count") + 1]).toBe("2");
  });

  it("rejects invalid grouped-duplex front-page counts before invoking the runner", async () => {
    for (const frontPageCount of ["0", "-1", "1.5", "Infinity"]) {
      const response = await request(app)
        .post("/api/printer-calibration/apply")
        .field("profileName", "office")
        .field("pageMode", "grouped-duplex")
        .field("frontPageCount", frontPageCount)
        .attach("file", Buffer.from("%PDF-1.4\ninput\n"), "input.pdf");

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid frontPageCount. Expected a positive integer.");
    }

    const missingCount = await request(app)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office")
      .field("pageMode", "grouped-duplex")
      .attach("file", Buffer.from("%PDF-1.4\ninput\n"), "input.pdf");

    expect(missingCount.status).toBe(400);
    expect(missingCount.body.error).toBe("Invalid frontPageCount. Expected a positive integer.");
    expect(applyInvocations).toEqual([]);
  });

  it("rejects invalid page modes", async () => {
    const response = await request(app)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office")
      .field("pageMode", "weird-mode")
      .attach("file", Buffer.from("%PDF-1.4\ninput\n"), "input.pdf");

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid pageMode");
  });

  it("returns 501 when the python tool is unavailable", async () => {
    const unavailableApp = express();
    mountAuthorizedCalibrationRouter(unavailableApp, {
        dataDirectory,
        runCli: async () => {
          throw new Error("Printer calibration unavailable. No module named printer_calibration");
        },
      });

    const response = await request(unavailableApp).get(
      "/api/printer-calibration/profiles"
    );
    expect(response.status).toBe(501);
  });

  it("downloads calibration sheets and reports sheet errors", async () => {
    const ok = await request(app).get("/api/printer-calibration/sheet");
    expect(ok.status).toBe(200);
    expect(ok.header["content-type"]).toContain("application/pdf");

    const failingApp = express();
    mountAuthorizedCalibrationRouter(failingApp, {
        dataDirectory,
        runCli: async () => {
          throw new Error("sheet unavailable");
        },
      });
    const failed = await request(failingApp).get("/api/printer-calibration/sheet");
    expect(failed.status).toBe(501);
    expect(failed.body.error).toBe("sheet unavailable");
  });

  it("logs sheet download callback failures", async () => {
    const downloadSpy = vi.spyOn(express.response, "download").mockImplementation(function (
      this: express.Response,
      _path: string,
      _filename: string,
      callback?: (err?: Error) => void
    ) {
      callback?.(new Error("sheet download failed"));
      this.status(200).end();
      return this;
    });
    const consoleErrorSpy = vi.spyOn(console, "error");

    try {
      const response = await request(app).get("/api/printer-calibration/sheet");

      expect(response.status).toBe(200);
      expect(downloadSpy).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[printer-calibration] download error:",
        expect.any(Error)
      );
    } finally {
      downloadSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it("maps profile route errors to 400, 404, 500, and 501 statuses", async () => {
    const missingGet = await request(app).get("/api/printer-calibration/profiles/missing");
    expect(missingGet.status).toBe(404);

    const invalidPut = await request(app)
      .put("/api/printer-calibration/profiles/bad")
      .send({ front_x_mm: "nope", front_y_mm: 0, back_x_mm: 0, back_y_mm: 0 });
    expect(invalidPut.status).toBe(400);

    const missingDelete = await request(app).delete("/api/printer-calibration/profiles/missing");
    expect(missingDelete.status).toBe(404);

    const badShowApp = express();
    mountAuthorizedCalibrationRouter(badShowApp, {
        dataDirectory,
        runCli: async (args: string[]) => {
          if (args[0] === "profile" && args[1] === "list") return { stdout: "bad\n", stderr: "" };
          if (args[0] === "profile" && args[1] === "show") throw new Error("show exploded");
          return { stdout: "", stderr: "" };
        },
      });
    const listFailure = await request(badShowApp).get("/api/printer-calibration/profiles");
    expect(listFailure.status).toBe(500);
    expect(listFailure.body.error).toBe("show exploded");

    const missingToolApp = express();
    mountAuthorizedCalibrationRouter(missingToolApp, {
        dataDirectory,
        runCli: async () => {
          throw new Error("PRINTER_CALIBRATION_BIN does not exist: /missing");
        },
      });
    const unavailable = await request(missingToolApp).delete("/api/printer-calibration/profiles/office");
    expect(unavailable.status).toBe(501);
  });

  it("stringifies non-Error failures from sheet and profile routes", async () => {
    const stringErrorApp = express();
    mountAuthorizedCalibrationRouter(stringErrorApp, {
        dataDirectory,
        runCli: async (args: string[]) => {
          const [command, subcommand] = args;
          if (command === "sheet") throw "plain sheet failure";
          if (command === "profile" && subcommand === "list") throw "plain list failure";
          if (command === "profile" && subcommand === "show") {
            const name = args[args.indexOf("--name") + 1];
            throw name === "missing-string" ? "plain not found" : "plain get failure";
          }
          if (command === "profile" && subcommand === "set") throw "plain put failure";
          if (command === "profile" && subcommand === "delete") throw "plain delete failure";
          return { stdout: "", stderr: "" };
        },
      });

    const sheet = await request(stringErrorApp).get("/api/printer-calibration/sheet");
    expect(sheet.status).toBe(500);
    expect(sheet.body.error).toBe("plain sheet failure");

    const list = await request(stringErrorApp).get("/api/printer-calibration/profiles");
    expect(list.status).toBe(500);
    expect(list.body.error).toBe("plain list failure");

    const get = await request(stringErrorApp).get("/api/printer-calibration/profiles/office");
    expect(get.status).toBe(500);
    expect(get.body.error).toBe("plain get failure");

    const missing = await request(stringErrorApp).get("/api/printer-calibration/profiles/missing-string");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("plain not found");

    const put = await request(stringErrorApp)
      .put("/api/printer-calibration/profiles/office")
      .send({ front_x_mm: 0, front_y_mm: 0, back_x_mm: 0, back_y_mm: 0 });
    expect(put.status).toBe(500);
    expect(put.body.error).toBe("plain put failure");

    const deleted = await request(stringErrorApp).delete("/api/printer-calibration/profiles/office");
    expect(deleted.status).toBe(500);
    expect(deleted.body.error).toBe("plain delete failure");
  });

  it("returns apply validation and execution errors", async () => {
    const missingProfile = await request(app)
      .post("/api/printer-calibration/apply")
      .attach("file", Buffer.from("%PDF-1.4\ninput\n"), "input.pdf");
    expect(missingProfile.status).toBe(400);
    expect(missingProfile.body.error).toBe("Missing profileName.");

    const notFoundApp = express();
    mountAuthorizedCalibrationRouter(notFoundApp, {
        dataDirectory,
        runCli: async () => {
          throw new Error("Profile 'office' not found");
        },
      });
    const notFound = await request(notFoundApp)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office")
      .attach("file", Buffer.from("%PDF-1.4\ninput\n"), "input.pdf");
    expect(notFound.status).toBe(404);

    const failingApp = express();
    mountAuthorizedCalibrationRouter(failingApp, {
        dataDirectory,
        runCli: async () => {
          throw "plain failure";
        },
      });
    const failed = await request(failingApp)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office")
      .attach("file", Buffer.from("%PDF-1.4\ninput\n"), "input.pdf");
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe("plain failure");
  });

  it("rejects malformed profile output", () => {
    expect(() => parsePrinterCalibrationProfileOutput("bad", "front_x_mm: nope\nfront_y_mm: 1\nback_x_mm: 2\nback_y_mm: 3")).toThrow("Invalid numeric value");
    expect(() => parsePrinterCalibrationProfileOutput("bad", "front_x_mm: 1")).toThrow("Failed to parse");
    expect(() => parsePrinterCalibrationProfileOutput("bad", "paper_size: letter\nignored line\nignored: value\nfront_x_mm: 1\nfront_y_mm: 2\nback_x_mm: 3\nback_y_mm: 4")).not.toThrow();
  });


});

afterAll(() => {
  createWriteStreamSpy.mockRestore();
  unlinkSyncSpy.mockRestore();
});
