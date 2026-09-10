#!/usr/bin/env node
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import { userInfo } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = path.join(root, ".review-artifacts", "td-4496de-real-electron-lifecycle");
const electron = path.join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const manager = path.join(root, "electron", "dist", "microservice-manager.js");
const quitGate = path.join(root, "electron", "dist", "quit-gate.js");
const preload = path.join(root, "electron", "dist", "preload.cjs");
const harness = path.join(root, "scripts", "fixtures", "electron-native-lifecycle-harness.mjs");
const SOURCE_BUILD = {
  kind: "nativeSqliteIsolated",
  sourceCommit: "dcb2825257e196be190d3739560eb92a64db0e8b",
  sourceTree: "dc8dbfb8b8a3dbd8453e99ef3b03d0c1f75dcdf1",
  sourceArchiveSha256: "e7b959549f88943dabb242ec6e50788b06e4876e61a0bb6e0fa38c99103f4c16",
  sourceLockSha256: "976bab6b945b691bb24abd693541f80aebb01c9e0ee530cc8c5167bf44bf5aed",
  patchSha256: "cfdae2db9613af918e3aced537de532b728f718f4e28d71833e2b8e8cc19e6a7",
};
const SHA256 = /^[0-9a-f]{64}$/;
const NO_EXTERNAL_ROUTE_MARKER = "SMOKE_NETWORK_ROUTES=";
const OFFLINE_RUNTIME_ENV = { REDIS_ENABLED: "false", BULK_DATA_LOAD_ON_STARTUP: "false", BULK_REFRESH_ENABLED: "false" };
const FORBIDDEN_CHROMIUM_SWITCHES = ["--no-sandbox", "--disable-setuid-sandbox"];
const SMOKE_ELECTRON_UID = 1000;
const NO_EXTERNAL_ROUTE_FIXTURE = { command: "unshare --user --net with explicit non-root Electron uid", loopback: "127.0.0.1 only", defaultRoute: "absent", marker: NO_EXTERNAL_ROUTE_MARKER, electronUid: SMOKE_ELECTRON_UID };
const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

function usage() {
  return "usage: node scripts/electron-native-lifecycle-smoke.mjs --stage <absolute-existing-microservice-package>";
}

function parseArguments(args) {
  if (args.length !== 2 || args[0] !== "--stage" || !path.isAbsolute(args[1])) {
    throw new Error(`${usage()}; offline lifecycle smoke never builds or downloads artifacts`);
  }
  return { stage: args[1] };
}

function exactKeys(value, expected, label) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} must be an object`);
  const keys = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) throw new Error(`${label} has missing or extra keys`);
}

async function regularFile(file, label) {
  const stat = await lstat(file);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${file}`);
}

export async function preflightStage(inputStage) {
  if (process.platform !== "linux") {
    throw new Error(`offline route fixture requires Linux network namespaces; current platform is ${process.platform}`);
  }
  const stage = await realpath(inputStage);
  const stageStat = await lstat(stage);
  if (!stageStat.isDirectory()) throw new Error(`stage is not a directory: ${stage}`);
  const manifestPath = path.join(stage, "microservice-artifact.json");
  await regularFile(manifestPath, "artifact manifest");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  exactKeys(manifest, ["backend", "binary", "platform", "profile", "runtime", "schemaVersion", "sourceBuild"], "manifest");
  if (manifest.schemaVersion !== 2 || manifest.runtime !== "desktopSQLite" || manifest.backend !== "sqlite" || manifest.profile !== "release") throw new Error("manifest is not a desktop SQLite v2 release artifact");
  if (manifest.platform !== process.platform) throw new Error(`manifest platform ${String(manifest.platform)} does not match ${process.platform}`);
  exactKeys(manifest.binary, ["fileName", "sha256", "sourcePath"], "manifest.binary");
  const expectedBinaryName = process.platform === "win32" ? "scryfall-cache.exe" : "scryfall-cache";
  if (manifest.binary.fileName !== expectedBinaryName || path.basename(manifest.binary.fileName) !== manifest.binary.fileName || !SHA256.test(manifest.binary.sha256)) throw new Error("manifest has invalid canonical binary metadata");
  exactKeys(manifest.sourceBuild, Object.keys(SOURCE_BUILD), "manifest.sourceBuild");
  for (const [key, expected] of Object.entries(SOURCE_BUILD)) {
    if (manifest.sourceBuild[key] !== expected) throw new Error(`manifest has invalid source provenance ${key}`);
  }
  const binary = path.join(stage, manifest.binary.fileName);
  if (path.dirname(binary) !== stage) throw new Error("manifest binary escaped the supplied stage");
  await regularFile(binary, "staged binary");
  const resolvedBinary = await realpath(binary);
  if (path.dirname(resolvedBinary) !== stage) throw new Error("staged binary resolves outside the supplied stage");
  const binarySha256 = await sha256(resolvedBinary);
  if (binarySha256 !== manifest.binary.sha256) throw new Error("staged binary SHA-256 does not match its v2 manifest");
  return { stage, manifestPath, manifest, binary: resolvedBinary, binarySha256 };
}

async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("no loopback port");
  return address.port;
}

function rejectSandboxDisablingSwitches(electronArgs) {
  const forbidden = electronArgs.find((argument) => FORBIDDEN_CHROMIUM_SWITCHES.some((switchName) => argument === switchName || argument.startsWith(`${switchName}=`)));
  if (forbidden) throw new Error(`forbidden Chromium sandbox switch: ${forbidden}`);
}

function subordinateId(content, account, callerId, label) {
  for (const line of content.split("\n")) {
    const [owner, startText, countText] = line.trim().split(":");
    if (owner !== account) continue;
    const start = Number(startText); const count = Number(countText);
    const candidate = start === callerId ? start + 1 : start;
    if (Number.isSafeInteger(start) && Number.isSafeInteger(count) && count > 0 && Number.isSafeInteger(candidate) && candidate > 0 && candidate !== callerId && candidate < start + count) return candidate;
  }
  throw new Error(`no usable non-root subordinate ${label} mapping for ${account}`);
}

async function sandboxIdentity() {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") throw new Error("secure lifecycle namespace requires Unix uid/gid support");
  const callerUid = process.getuid(); const callerGid = process.getgid();
  if (callerUid === 0 || callerGid === 0) throw new Error("secure lifecycle smoke refuses to launch Electron from host UID or GID 0");
  const account = userInfo().username;
  const [subuid, subgid] = await Promise.all([readFile("/etc/subuid", "utf8"), readFile("/etc/subgid", "utf8")]);
  return { callerUid, callerGid, electronUid: SMOKE_ELECTRON_UID, hostElectronUid: subordinateId(subuid, account, callerUid, "UID"), hostElectronGid: subordinateId(subgid, account, callerGid, "GID") };
}

export function networkIsolatedLaunch(electronArgs, identity, electronExecutable) {
  rejectSandboxDisablingSwitches(electronArgs);
  if (!identity) throw new Error("secure lifecycle launch requires a verified namespace identity");
  if (!electronExecutable) throw new Error("secure lifecycle launch requires a mounted Electron executable");
  // A user/network namespace has loopback only and no default route. The native child
  // inherits this namespace, so an accidental external request is impossible. The
  // setup process is namespace-root only long enough to configure loopback; Electron
  // itself is a non-root subordinate host identity with no retained capabilities.
  return {
    command: "unshare",
    args: ["--user", "--mount", "--net", "--fork", `--map-users=0:${identity.callerUid}:1`, `--map-users=${identity.electronUid}:${identity.hostElectronUid}:1`, `--map-groups=0:${identity.callerGid}:1`, `--map-groups=1000:${identity.hostElectronGid}:1`, "--setuid", "0", "--setgid", "0", "sh", "-c", `mount --make-rprivate / && mount --bind "$SMOKE_REPOSITORY_ROOT" "$SMOKE_REPOSITORY_MOUNT" && ip link set lo up && test -z "$(ip route show default)" && chmod 700 "$SMOKE_USER_DATA" && cd "$SMOKE_REPOSITORY_MOUNT" && printf '${NO_EXTERNAL_ROUTE_MARKER}%s\\n' "$(ip route show default)" && exec unshare --user --fork --map-users=0:$SMOKE_ELECTRON_UID:1 --map-users=$SMOKE_ELECTRON_UID:0:1 --map-groups=0:1000:1 --map-groups=1000:0:1 --setuid 0 --setgid 0 sh -c "$SMOKE_INNER_LAUNCH" offline-lifecycle-inner "$@"`, "offline-lifecycle-route-fixture", electronExecutable, ...electronArgs],
    fixture: NO_EXTERNAL_ROUTE_FIXTURE,
    env: {
      SMOKE_ELECTRON_UID: String(identity.electronUid),
      SMOKE_INNER_LAUNCH: "exec setpriv --reuid \"$SMOKE_ELECTRON_UID\" --regid \"$SMOKE_ELECTRON_UID\" --clear-groups --bounding-set=-all --nnp sh -c \"$SMOKE_ELECTRON_EXEC\" offline-lifecycle-electron \"$@\"",
      SMOKE_ELECTRON_EXEC: "test \"$(id -u)\" = \"$SMOKE_ELECTRON_UID\" && printf \"SMOKE_ELECTRON_IDENTITY=uid=%s gid=%s\\n\" \"$(id -u)\" \"$(id -g)\" && exec \"$@\"",
    },
  };
}

function offlineLogEvidence(stdout, stderr) {
  const logs = `${stdout}\n${stderr}`;
  const prohibited = ["No cards in database, bulk data load required", "Loading bulk data...", "Starting bulk data import", "Starting bulk data refresh job", "api.scryfall.com"];
  const observedProhibited = prohibited.filter((entry) => logs.includes(entry));
  const required = ["Redis cache is disabled", "Bulk data load on startup is disabled", "Bulk data refresh job is disabled", NO_EXTERNAL_ROUTE_MARKER, `SMOKE_ELECTRON_IDENTITY=uid=${SMOKE_ELECTRON_UID}`];
  const missingRequired = required.filter((entry) => !logs.includes(entry));
  return { required, prohibited, observedProhibited, missingRequired, status: observedProhibited.length === 0 && missingRequired.length === 0 ? "PASS" : "FAIL" };
}

async function main() {
  const run = path.join(artifactRoot, `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
  await mkdir(run, { recursive: true });
  const userData = path.join(run, "user-data"); const runtimeReport = path.join(run, "runtime.json"); const stdoutFile = path.join(run, "electron.stdout.log"); const stderrFile = path.join(run, "electron.stderr.log");
  let input = null; let preflight = null; let output = ""; let errors = ""; let runtime = null; let failure = null;
  let result = { code: null, signal: null, timedOut: false };
  try {
    input = parseArguments(process.argv.slice(2));
    preflight = await preflightStage(input.stage);
    const required = [electron, manager, quitGate, preload, harness];
    const missing = required.filter((entry) => !existsSync(entry));
    if (missing.length) throw new Error(`required existing Electron runtime input is missing: ${missing.join(", ")}`);
    const apiPort = await port();
    const identity = await sandboxIdentity();
    // Keep /tmp intact: the host display socket lives at /tmp/.X11-unix.
    const sandboxRepositoryMount = "/var/tmp";
    const sandboxPath = (file) => path.join(sandboxRepositoryMount, path.relative(root, file));
    await mkdir(userData, { recursive: true });
    await writeFile(runtimeReport, "");
    await chmod(runtimeReport, 0o660);
    const sandboxUserData = sandboxPath(userData);
    const electronArgs = ["--headless", "--disable-gpu", "--no-proxy-server", `--user-data-dir=${sandboxUserData}`, sandboxPath(harness), `--preload=${sandboxPath(preload)}`, `--manager=${sandboxPath(manager)}`, `--quit-gate=${sandboxPath(quitGate)}`, `--user-data=${sandboxUserData}`, `--report-file=${sandboxPath(runtimeReport)}`, `--port=${apiPort}`];
    const launch = networkIsolatedLaunch(electronArgs, identity, sandboxPath(electron));
    const child = spawn(launch.command, launch.args, {
      cwd: run,
      env: { PATH: process.env.PATH, HOME: sandboxUserData, DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XAUTHORITY: process.env.XAUTHORITY, ELECTRON_DISABLE_GPU: "1", SMOKE_REPOSITORY_ROOT: root, SMOKE_REPOSITORY_MOUNT: sandboxRepositoryMount, SMOKE_USER_DATA: sandboxUserData, SMOKE_RUNTIME_REPORT: sandboxPath(runtimeReport), ...launch.env, ...OFFLINE_RUNTIME_ENV },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { errors += chunk; });
    const exited = await Promise.race([once(child, "exit").then(([code, signal]) => ({ exited: true, code, signal })), new Promise((resolve) => setTimeout(() => resolve({ exited: false }), 20_000))]);
    if (exited.exited) result = { code: exited.code, signal: exited.signal, timedOut: false }; else { result.timedOut = true; child.kill("SIGTERM"); }
    try { runtime = JSON.parse(await readFile(runtimeReport, "utf8")); } catch { /* classified below */ }
    const network = offlineLogEvidence(output, errors);
    if (network.status !== "PASS") throw new Error(`offline network evidence failed: ${JSON.stringify(network)}`);
    const status = result.code === 0 && !result.timedOut && runtime?.status === "PASS" && runtime?.stopCalls === 1 && Number.isInteger(runtime?.runtime?.childPid) && runtime.runtime.childPid > 0 && runtime?.runtime?.processSandbox?.seccomp === "2" && runtime.runtime.processSandbox.noNewPrivs === "1";
    if (!status) throw new Error("Electron lifecycle assertions failed (health, ready, sandbox bridge, stop, or child PID)");
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  await Promise.all([writeFile(stdoutFile, output), writeFile(stderrFile, errors)]);
  const network = offlineLogEvidence(output, errors);
  const report = {
    schema: "td-4496de-electron-native-lifecycle-smoke/v4", status: failure ? "FAIL" : "PASS", failure,
    input, preflight: preflight && { stage: preflight.stage, manifestPath: preflight.manifestPath, binary: preflight.binary, expectedBinarySha256: preflight.manifest.binary.sha256, binarySha256: preflight.binarySha256, provenance: preflight.manifest.sourceBuild },
    userData, process: result, runtime, offlineConfig: { ...OFFLINE_RUNTIME_ENV, databaseUrlPresent: false, apiHost: "127.0.0.1" }, network: { ...network, routeFixture: NO_EXTERNAL_ROUTE_FIXTURE }, logs: { stdoutFile, stderrFile },
  };
  await writeFile(path.join(run, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = failure ? 2 : 0;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  await main();
}
