import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { networkIsolatedLaunch, preflightStage } from "./electron-native-lifecycle-smoke.mjs";

const SOURCE_BUILD = {
  kind: "nativeSqliteIsolated",
  sourceCommit: "dcb2825257e196be190d3739560eb92a64db0e8b",
  sourceTree: "dc8dbfb8b8a3dbd8453e99ef3b03d0c1f75dcdf1",
  sourceArchiveSha256: "e7b959549f88943dabb242ec6e50788b06e4876e61a0bb6e0fa38c99103f4c16",
  sourceLockSha256: "976bab6b945b691bb24abd693541f80aebb01c9e0ee530cc8c5167bf44bf5aed",
  patchSha256: "cfdae2db9613af918e3aced537de532b728f718f4e28d71833e2b8e8cc19e6a7",
};

async function fixture() {
  const stage = await mkdtemp(path.join(os.tmpdir(), "electron-lifecycle-stage-"));
  const binary = path.join(stage, process.platform === "win32" ? "scryfall-cache.exe" : "scryfall-cache");
  const bytes = Buffer.from("verified offline smoke artifact");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(binary, bytes);
  await writeFile(path.join(stage, "microservice-artifact.json"), JSON.stringify({
    schemaVersion: 2, runtime: "desktopSQLite", backend: "sqlite", platform: process.platform, profile: "release",
    binary: { sourcePath: "/producer/provenance-only/scryfall-cache", fileName: path.basename(binary), sha256: digest }, sourceBuild: SOURCE_BUILD,
  }));
  return { stage, binary };
}

test("offline lifecycle preflight accepts only an explicit verified co-staged v2 pair", async (t) => {
  const f = await fixture(); t.after(() => rm(f.stage, { recursive: true, force: true }));
  const preflight = await preflightStage(f.stage);
  assert.equal(preflight.binary, f.binary);
  assert.equal(preflight.binarySha256, preflight.manifest.binary.sha256);
  await writeFile(f.binary, "tampered");
  await assert.rejects(() => preflightStage(f.stage), /SHA-256/);
});

test("network-isolated launch rejects Chromium sandbox-disabling switches", () => {
  assert.throws(() => networkIsolatedLaunch(["--headless", "--no-sandbox"]), /forbidden Chromium sandbox switch/);
  assert.throws(() => networkIsolatedLaunch(["--headless", "--disable-setuid-sandbox"]), /forbidden Chromium sandbox switch/);
  assert.throws(() => networkIsolatedLaunch(["--headless", "--no-sandbox=1"]), /forbidden Chromium sandbox switch/);
  assert.throws(() => networkIsolatedLaunch(["--headless", "--disable-setuid-sandbox=1"]), /forbidden Chromium sandbox switch/);
});
