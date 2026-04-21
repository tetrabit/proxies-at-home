import { promises as fs } from "fs";
import os from "os";
import path from "path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPythonCliArgs,
  calculatePrinterCalibrationProfile,
  createPrinterCalibrationRouter,
  detectDefaultPrinterCalibrationRepo,
  parsePrinterCalibrationProfileOutput,
  resolvePrinterCalibrationProfilesPath,
  shouldTryNextPrinterCalibrationRunner,
  type PrinterCalibrationProfile,
} from "./printerCalibrationRouter.js";

describe("printerCalibrationRouter", () => {
  let tempDirectory: string;
  let dataDirectory: string;
  let app: express.Express;
  let profiles = new Map<string, PrinterCalibrationProfile>();
  let applyInvocations: string[][] = [];

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "printer-calibration-router-")
    );
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
    app.use(express.json());
    app.use(
      "/api/printer-calibration",
      createPrinterCalibrationRouter({ dataDirectory, runCli })
    );
  });

  afterEach(async () => {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  it("rejects configured paths that escape the data directory", () => {
    expect(() =>
      resolvePrinterCalibrationProfilesPath("../outside.toml", dataDirectory)
    ).toThrow(
      `PRINTER_CALIBRATION_PROFILES_PATH must stay within ${path.resolve(dataDirectory)}`
    );
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

  it("returns 400 when apply is missing required fields", async () => {
    const response = await request(app)
      .post("/api/printer-calibration/apply")
      .field("profileName", "office");
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Missing file upload.");
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
    unavailableApp.use(express.json());
    unavailableApp.use(
      "/api/printer-calibration",
      createPrinterCalibrationRouter({
        dataDirectory,
        runCli: async () => {
          throw new Error("Printer calibration unavailable. No module named printer_calibration");
        },
      })
    );

    const response = await request(unavailableApp).get(
      "/api/printer-calibration/profiles"
    );
    expect(response.status).toBe(501);
  });
});
