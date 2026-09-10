#!/usr/bin/env node
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = path.join(root, ".review-artifacts", "td-4496de-real-electron-lifecycle");
const stage = path.join(root, "electron", "dist", "microservice-package");
const manifestPath = path.join(stage, "microservice-artifact.json");
const electron = path.join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const manager = path.join(root, "electron", "dist", "microservice-manager.js");
const quitGate = path.join(root, "electron", "dist", "quit-gate.js");
const preload = path.join(root, "electron", "dist", "preload.cjs");
const harness = path.join(root, "scripts", "fixtures", "electron-native-lifecycle-harness.mjs");
const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
async function port() { const server = net.createServer(); await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve)); const address = server.address(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); if (!address || typeof address === "string") throw new Error("no loopback port"); return address.port; }
const run = path.join(artifactRoot, `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`); await mkdir(run, { recursive: true });
const userData = path.join(run, "user-data"); const runtimeReport = path.join(run, "runtime.json"); const stdoutFile = path.join(run, "electron.stdout.log"); const stderrFile = path.join(run, "electron.stderr.log");
const required = [manifestPath, electron, manager, quitGate, preload, harness]; const missing = required.filter((entry) => !existsSync(entry));
let manifest; let binary; let binarySha256 = null; let output = ""; let errors = ""; let result = { code: null, signal: null, timedOut: false }; let runtime = null;
if (missing.length === 0) { manifest = JSON.parse(await readFile(manifestPath, "utf8")); binary = path.join(stage, manifest.binary.fileName); binarySha256 = await sha256(binary); }
if (!missing.length && manifest?.schemaVersion === 2 && binarySha256 === manifest.binary?.sha256) {
  const apiPort = await port(); const child = spawn(electron, ["--headless", "--disable-gpu", `--user-data-dir=${userData}`, harness, `--preload=${preload}`, `--manager=${manager}`, `--quit-gate=${quitGate}`, `--user-data=${userData}`, `--report-file=${runtimeReport}`, `--port=${apiPort}`], { cwd: run, env: { PATH: process.env.PATH, HOME: process.env.HOME, DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XAUTHORITY: process.env.XAUTHORITY, ELECTRON_DISABLE_GPU: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { errors += chunk; });
  const exited = await Promise.race([once(child, "exit").then(([code, signal]) => ({ exited: true, code, signal })), new Promise((resolve) => setTimeout(() => resolve({ exited: false }), 20000))]);
  if (exited.exited) result = { code: exited.code, signal: exited.signal, timedOut: false }; else { result.timedOut = true; child.kill("SIGTERM"); }
}
await Promise.all([writeFile(stdoutFile, output), writeFile(stderrFile, errors)]); try { runtime = JSON.parse(await readFile(runtimeReport, "utf8")); } catch { /* classified below */ }
const status = !missing.length && binarySha256 === manifest?.binary?.sha256 && result.code === 0 && !result.timedOut && runtime?.status === "PASS" && runtime.stopCalls === 1 ? "PASS" : "FAIL";
const report = { schema: "td-4496de-electron-native-lifecycle-smoke/v2", status, stage, manifestPath, binary, expectedBinarySha256: manifest?.binary?.sha256 ?? null, binarySha256, userData, process: result, runtime, missing, logs: { stdoutFile, stderrFile } };
await writeFile(path.join(run, "report.json"), `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2)); process.exitCode = status === "PASS" ? 0 : 2;
