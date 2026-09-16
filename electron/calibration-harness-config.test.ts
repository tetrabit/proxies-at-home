import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CALIBRATION_HARNESS_CONFIG_MAX_BYTES,
  calibrationHarnessPrivateValues,
  ensureHarnessCredentialProvisioned,
  loadCalibrationHarnessConfig,
  parseCalibrationHarnessConfig,
  replaceCalibrationHarnessConfigCredential,
  retargetLoopbackHarnessOrigin,
  type CalibrationHarnessCredentialStore,
} from "./calibration-harness-config.js";

const credential = `calibration_pair_${"a".repeat(43)}`;
const replacementCredential = `calibration_pair_${"b".repeat(43)}`;
const base = { version: 1, backendOrigin: "https://calibration.example.test", harnessId: "harness-a", credential };
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type FixtureDirectory = Readonly<{ parent: string; invocation: string; directory: string }>;

function containedPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertNonSymlinkDirectoryChain(root: string, directory: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  if (resolvedDirectory !== resolvedRoot && !containedPath(resolvedRoot, resolvedDirectory)) {
    throw new Error("fixture parent escapes module-anchored repository root");
  }
  const rootStat = await lstat(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("fixture ancestor is unsafe");
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  let current = resolvedRoot;
  for (const component of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, component);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("fixture ancestor is unsafe");
  }
}

async function ensureControlledParent(parent: string): Promise<void> {
  if (!containedPath(repositoryRoot, parent)) throw new Error("fixture parent escapes module-anchored repository root");
  await assertNonSymlinkDirectoryChain(repositoryRoot, path.dirname(parent));
  try {
    await mkdir(parent, { mode: 0o700 });
  } catch (error) {
    if (!(typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST")) throw error;
  }
  await assertNonSymlinkDirectoryChain(repositoryRoot, parent);
}

async function fixtureDirectory(controlledParent = path.join(repositoryRoot, ".review-artifacts")): Promise<FixtureDirectory> {
  await ensureControlledParent(controlledParent);
  const invocation = path.join(controlledParent, `td-30aa34-config-${randomUUID()}`);
  if (!containedPath(controlledParent, invocation)) throw new Error("fixture invocation escapes controlled parent");
  await mkdir(invocation, { mode: 0o700 });
  await assertNonSymlinkDirectoryChain(repositoryRoot, invocation);
  const directory = await mkdtemp(path.join(invocation, "case-"));
  if (!containedPath(invocation, directory)) throw new Error("fixture case escapes invocation root");
  await assertNonSymlinkDirectoryChain(repositoryRoot, directory);
  return Object.freeze({ parent: controlledParent, invocation, directory });
}

async function privateConfig(directory: string, value: unknown = base): Promise<string> {
  const filename = path.join(directory, "harness-config.json");
  await writeFile(filename, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600
    || (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("new synthetic config is not an exclusive private fixture");
  }
  return filename;
}

describe("calibration harness private config", () => {
  it("parses only the exact provisioned shape and canonical origins", () => {
    const config = parseCalibrationHarnessConfig(base);
    expect(config.harnessId).toBe("harness-a");
    expect(() => parseCalibrationHarnessConfig({ ...base, ownerId: "invented" })).toThrow("invalid private configuration");
    expect(() => parseCalibrationHarnessConfig({ ...base, backendOrigin: "http://example.test" })).toThrow("invalid private configuration");
    expect(() => parseCalibrationHarnessConfig({ ...base, backendOrigin: "https://example.test/path" })).toThrow("invalid private configuration");
    expect(() => parseCalibrationHarnessConfig({ ...base, credential: "bad" })).toThrow("invalid private configuration");
  });

  it("returns typed not-configured before a missing config can be used", async () => {
    const fixture = await fixtureDirectory();
    await expect(loadCalibrationHarnessConfig(path.join(fixture.directory, "absent.json"))).resolves.toEqual({ kind: "not-configured" });
  });

  it("loads a bounded current-user private regular file without exposing its credential", async () => {
    const fixture = await fixtureDirectory();
    const filename = await privateConfig(fixture.directory);
    const result = await loadCalibrationHarnessConfig(filename);
    expect(result.kind).toBe("configured");
    if (result.kind === "configured") {
      expect(result.config.harnessId).toBe("harness-a");
      expect(result.config).not.toHaveProperty("credential");
      expect(result.file.byteLength).toBeGreaterThan(0);
      expect(result.file.mode).toBe(0o600);
    }
  });

  it("fails closed for oversized, symlinked, and non-private fixture files", async () => {
    const oversizedDirectory = (await fixtureDirectory()).directory;
    const oversized = await privateConfig(oversizedDirectory, `${"x".repeat(CALIBRATION_HARNESS_CONFIG_MAX_BYTES + 1)}`);
    await expect(loadCalibrationHarnessConfig(oversized)).rejects.toThrow("invalid private configuration");

    const linkedDirectory = (await fixtureDirectory()).directory;
    const target = await privateConfig(linkedDirectory);
    const linked = path.join(linkedDirectory, "linked.json");
    await symlink(target, linked);
    await expect(loadCalibrationHarnessConfig(linked)).rejects.toThrow("untrusted private configuration");

    const modeDirectory = (await fixtureDirectory()).directory;
    const modeFile = await privateConfig(modeDirectory);
    await chmod(modeFile, 0o644);
    await expect(loadCalibrationHarnessConfig(modeFile)).rejects.toThrow("untrusted private configuration");
    expect((await lstat(modeFile)).isFile()).toBe(true);
  });

  it("allocates distinct module-anchored invocation roots without overwriting a collision sentinel", async () => {
    const first = await fixtureDirectory();
    const sentinel = path.join(first.directory, "collision-sentinel");
    await writeFile(sentinel, "retain", { encoding: "utf8", flag: "wx", mode: 0o600 });
    const second = await fixtureDirectory();

    expect(first.invocation).not.toBe(second.invocation);
    expect(first.directory).not.toBe(second.directory);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("retain");
  });

  it("creates a fresh contained controlled parent nonrecursively without inherited artifact ancestry", async () => {
    const owner = await fixtureDirectory();
    const freshParent = path.join(owner.directory, "fresh-controlled-parent");
    await expect(lstat(freshParent)).rejects.toMatchObject({ code: "ENOENT" });

    const fresh = await fixtureDirectory(freshParent);
    const stat = await lstat(fresh.parent);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(containedPath(repositoryRoot, fresh.directory)).toBe(true);
  });

  it("refuses symlinked and escaping fixture parents before writing through them", async () => {
    const owner = await fixtureDirectory();
    const symlinkedParent = path.join(owner.directory, "symlinked-parent");
    await symlink(owner.directory, symlinkedParent);

    await expect(fixtureDirectory(symlinkedParent)).rejects.toThrow("fixture ancestor is unsafe");
    await expect(fixtureDirectory(path.resolve(repositoryRoot, "..", "fixture-escape"))).rejects
      .toThrow("fixture parent escapes module-anchored repository root");
  });
});

function fakeCredentialStore(
  existing: readonly string[] = [],
  ownerForHarness?: (harnessId: string) => string | null,
): {
  store: CalibrationHarnessCredentialStore;
  provisions: Array<Readonly<{ ownerId: string; harnessId: string; noExpiry: boolean }>>;
} {
  const tokens = new Set(existing);
  const provisions: Array<Readonly<{ ownerId: string; harnessId: string; noExpiry: boolean }>> = [];
  const store: CalibrationHarnessCredentialStore = {
    provision(input) {
      provisions.push({ ...input });
      tokens.add(replacementCredential);
      return replacementCredential;
    },
    verifyBearer(token) {
      return tokens.has(token) ? { ownerId: "desktop-local", harnessId: "harness-a" } : null;
    },
  };
  if (ownerForHarness !== undefined) {
    store.ownerForHarness = ownerForHarness;
  }
  return { store, provisions };
}

describe("desktop harness loopback origin retargeting", () => {
  it("retargets a stale loopback origin at the live local port and preserves identity fields", async () => {
    const fixture = await fixtureDirectory();
    const filename = await privateConfig(fixture.directory, { ...base, backendOrigin: "http://127.0.0.1:3001" });
    const loaded = await loadCalibrationHarnessConfig(filename);
    expect(loaded.kind).toBe("configured");
    const retargeted = retargetLoopbackHarnessOrigin(loaded, 54321);
    expect(retargeted.kind).toBe("configured");
    if (loaded.kind === "configured" && retargeted.kind === "configured") {
      expect(retargeted.config.harnessId).toBe(loaded.config.harnessId);
      expect(calibrationHarnessPrivateValues(retargeted.config).backendOrigin).toBe("http://127.0.0.1:54321");
      expect(calibrationHarnessPrivateValues(retargeted.config).credential).toBe(credential);
      expect(calibrationHarnessPrivateValues(loaded.config).backendOrigin).toBe("http://127.0.0.1:3001");
    }
  });

  it("preserves the bracketed IPv6 loopback form when retargeting", async () => {
    const fixture = await fixtureDirectory();
    const filename = await privateConfig(fixture.directory, { ...base, backendOrigin: "http://[::1]:3001" });
    const loaded = await loadCalibrationHarnessConfig(filename);
    const retargeted = retargetLoopbackHarnessOrigin(loaded, 61771);
    expect(retargeted.kind).toBe("configured");
    if (retargeted.kind === "configured") {
      expect(calibrationHarnessPrivateValues(retargeted.config).backendOrigin).toBe("http://[::1]:61771");
    }
  });

  it("passes already-correct, remote, and not-configured results through unchanged", async () => {
    const exactFixture = await fixtureDirectory();
    const exact = await privateConfig(exactFixture.directory, { ...base, backendOrigin: "http://127.0.0.1:3001" });
    const exactLoaded = await loadCalibrationHarnessConfig(exact);
    expect(retargetLoopbackHarnessOrigin(exactLoaded, 3001)).toBe(exactLoaded);

    const remoteFixture = await fixtureDirectory();
    const remote = await privateConfig(remoteFixture.directory, base);
    const remoteLoaded = await loadCalibrationHarnessConfig(remote);
    expect(retargetLoopbackHarnessOrigin(remoteLoaded, 54321)).toBe(remoteLoaded);

    const notConfigured = Object.freeze({ kind: "not-configured" as const });
    expect(retargetLoopbackHarnessOrigin(notConfigured, 54321)).toBe(notConfigured);
  });
});

describe("desktop harness credential self-healing", () => {
  it("rewrites only the credential of an operator-provisioned loopback config", async () => {
    const fixture = await fixtureDirectory();
    const filename = await privateConfig(fixture.directory, { ...base, backendOrigin: "http://127.0.0.1:3001" });
    await replaceCalibrationHarnessConfigCredential(filename, replacementCredential);
    const reloaded = await loadCalibrationHarnessConfig(filename);
    expect(reloaded.kind).toBe("configured");
    if (reloaded.kind === "configured") {
      expect(reloaded.config.harnessId).toBe("harness-a");
      expect(calibrationHarnessPrivateValues(reloaded.config).backendOrigin).toBe("http://127.0.0.1:3001");
      expect(calibrationHarnessPrivateValues(reloaded.config).credential).toBe(replacementCredential);
      expect((await lstat(filename)).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses malformed replacement credentials without touching the file", async () => {
    const fixture = await fixtureDirectory();
    const filename = await privateConfig(fixture.directory);
    const before = await readFile(filename, "utf8");
    await expect(replaceCalibrationHarnessConfigCredential(filename, "not-a-credential")).rejects
      .toThrow("invalid private configuration");
    expect(await readFile(filename, "utf8")).toBe(before);
  });

  it("leaves a still-valid provisioned credential untouched", async () => {
    const fixture = await fixtureDirectory();
    const filename = await privateConfig(fixture.directory, { ...base, backendOrigin: "http://127.0.0.1:3001" });
    const before = await readFile(filename, "utf8");
    const fake = fakeCredentialStore([credential]);
    const outcome = await ensureHarnessCredentialProvisioned(filename, () => fake.store, {});
    expect(outcome).toBe("already-valid");
    expect(fake.provisions).toEqual([]);
    expect(await readFile(filename, "utf8")).toBe(before);
  });

  it("provisions a replacement for an orphaned credential and rewrites the config atomically", async () => {
    const fixture = await fixtureDirectory();
    const filename = await privateConfig(fixture.directory, { ...base, backendOrigin: "http://127.0.0.1:3001" });
    const fake = fakeCredentialStore();
    const outcome = await ensureHarnessCredentialProvisioned(filename, () => fake.store, {});
    expect(outcome).toBe("provisioned");
    expect(fake.provisions).toEqual([{ ownerId: "desktop-local", harnessId: "harness-a", noExpiry: true }]);
    const reloaded = await loadCalibrationHarnessConfig(filename);
    expect(reloaded.kind).toBe("configured");
    if (reloaded.kind === "configured") {
      expect(calibrationHarnessPrivateValues(reloaded.config).credential).toBe(replacementCredential);
      expect(fake.store.verifyBearer(replacementCredential)).not.toBeNull();
    }
    const entries = await readdir(fixture.directory);
    expect(entries.find((entry) => entry.endsWith(".tmp"))).toBeUndefined();
  });

  it("preserves the existing harness owner when re-provisioning a replaced database", async () => {
    const fixture = await fixtureDirectory();
    const filename = await privateConfig(fixture.directory, { ...base, backendOrigin: "http://127.0.0.1:3001" });
    const fake = fakeCredentialStore([], () => "8826a106-72a7-420a-b63b-b0e250e9e409");
    const outcome = await ensureHarnessCredentialProvisioned(filename, () => fake.store, {});
    expect(outcome).toBe("provisioned");
    expect(fake.provisions).toEqual([
      { ownerId: "8826a106-72a7-420a-b63b-b0e250e9e409", harnessId: "harness-a", noExpiry: true },
    ]);
  });

  it("falls back to the default owner when the database does not own the harness", async () => {
    const fixture = await fixtureDirectory();
    const filename = await privateConfig(fixture.directory, { ...base, backendOrigin: "http://127.0.0.1:3001" });
    const fake = fakeCredentialStore([], () => null);
    const outcome = await ensureHarnessCredentialProvisioned(filename, () => fake.store, {});
    expect(outcome).toBe("provisioned");
    expect(fake.provisions).toEqual([{ ownerId: "desktop-local", harnessId: "harness-a", noExpiry: true }]);
  });

  it("ignores a failing owner probe instead of breaking self-healing", async () => {
    const fixture = await fixtureDirectory();
    const filename = await privateConfig(fixture.directory, { ...base, backendOrigin: "http://127.0.0.1:3001" });
    const fake = fakeCredentialStore([], () => {
      throw new Error("probe failed");
    });
    const outcome = await ensureHarnessCredentialProvisioned(filename, () => fake.store, {});
    expect(outcome).toBe("provisioned");
    expect(fake.provisions).toEqual([{ ownerId: "desktop-local", harnessId: "harness-a", noExpiry: true }]);
  });

  it("reports absent and invalid configs without provisioning", async () => {
    const fixture = await fixtureDirectory();
    const fake = fakeCredentialStore();
    expect(await ensureHarnessCredentialProvisioned(path.join(fixture.directory, "absent.json"), () => fake.store, {}))
      .toBe("absent");

    const invalidFilename = path.join(fixture.directory, "invalid.json");
    await writeFile(invalidFilename, "not json", { encoding: "utf8", flag: "wx", mode: 0o600 });
    expect(await ensureHarnessCredentialProvisioned(invalidFilename, () => fake.store, {}))
      .toBe("invalid");
    expect(fake.provisions).toEqual([]);
  });
});
