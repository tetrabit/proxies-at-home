import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("resource probe retains Git/index/build provenance and fail-closed shutdown evidence", async () => {
  const source = await readFile(new URL("./export-resource-probe.mjs", import.meta.url), "utf8");

  assert.match(source, /async function readGitProvenance\(\)/);
  assert.match(source, /async function scanProcessesForProfile\(profileDir\)/);
  assert.match(source, /postclose_profile_scan/);
  assert.match(source, /postclose_vite_proc_scan/);
  assert.match(source, /status: "unknown"/);
  assert.match(source, /index_fingerprint_sha256/);
  assert.match(source, /production_build: \{ status: "not_run"/);
  assert.match(source, /console_errors/);
});
