// @vitest-environment node

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { atomicallyReplace } from "./promote-preferences.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const promotionScript = path.join(scriptDirectory, "promote-preferences.mjs");
const artifactRoot = path.join(repositoryRoot, ".review-artifacts");

let artifactDirectory: string;

async function createExclusiveArtifactDirectory(): Promise<string> {
  await mkdir(artifactRoot, { recursive: true });

  for (let id = 1; ; id += 1) {
    const candidate = path.join(
      artifactRoot,
      `promotion-atomic-failure-${String(id).padStart(2, "0")}`
    );

    try {
      await mkdir(candidate);
      return candidate;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
}

async function runPromotion(sourcePath: string, destinationPath: string) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [promotionScript, sourcePath, "--destination", destinationPath],
      { cwd: repositoryRoot, stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function validCandidate() {
  return {
    identifier: "abc123",
    name: "Thalia, Guardian of Thraben",
    rawName: "Thalia, Guardian of Thraben",
    smallThumbnailUrl: "https://example.test/small.jpg",
    mediumThumbnailUrl: "https://example.test/medium.jpg",
    dpi: 300,
    tags: ["human"],
    sourceName: "MakePlayingCards",
    source: "mpc",
    extension: "jpg",
    size: 12345,
  };
}

beforeAll(async () => {
  artifactDirectory = await createExclusiveArtifactDirectory();
});

afterAll(() => {
  // Evidence is intentionally retained under .review-artifacts.
});

describe("preference promotion CLI", { retry: 0 }, () => {
  it("cleans only its generated temporary target after a partial write failure", async () => {
    const destinationPath = path.join(artifactDirectory, "partial-write-destination.json");
    const priorBytes = "retained-partial-write-destination\n";
    await writeFile(destinationPath, priorBytes, "utf8");

    const diskFullError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const writeTemporaryFile = vi.fn().mockRejectedValue(diskFullError);
    const removeTemporaryFile = vi.fn().mockResolvedValue(undefined);

    await expect(
      atomicallyReplace(destinationPath, "replacement\n", {
        writeTemporaryFile,
        renameTemporaryFile: vi.fn(),
        removeTemporaryFile,
      })
    ).rejects.toBe(diskFullError);

    const temporaryPath = writeTemporaryFile.mock.calls[0]?.[0];
    expect(temporaryPath).toMatch(
      new RegExp(`^${path.dirname(destinationPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.${path.basename(destinationPath)}\\.[0-9a-f-]{36}\\.tmp$`)
    );
    expect(removeTemporaryFile).toHaveBeenCalledExactlyOnceWith(temporaryPath);
    expect(removeTemporaryFile).not.toHaveBeenCalledWith(destinationPath);
    await expect(readFile(destinationPath, "utf8")).resolves.toBe(priorBytes);
  });

  it("reports a cleanup failure instead of silently retaining its temporary target", async () => {
    const destinationPath = path.join(artifactDirectory, "cleanup-failure-destination.json");
    const writeError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const cleanupError = new Error("cleanup failed");
    const writeTemporaryFile = vi.fn().mockRejectedValue(writeError);
    const removeTemporaryFile = vi.fn().mockRejectedValue(cleanupError);

    await expect(
      atomicallyReplace(destinationPath, "replacement\n", {
        writeTemporaryFile,
        renameTemporaryFile: vi.fn(),
        removeTemporaryFile,
      })
    ).rejects.toBe(cleanupError);

    expect(removeTemporaryFile).toHaveBeenCalledExactlyOnceWith(
      writeTemporaryFile.mock.calls[0]?.[0]
    );
  });

  it("cleans only its generated temporary target after a rename failure", async () => {
    const destinationPath = path.join(artifactDirectory, "rename-failure-destination.json");
    const priorBytes = "retained-rename-failure-destination\n";
    await writeFile(destinationPath, priorBytes, "utf8");

    const renameError = Object.assign(new Error("rename failed"), { code: "EEXIST" });
    const writeTemporaryFile = vi.fn().mockResolvedValue(undefined);
    const renameTemporaryFile = vi.fn().mockRejectedValue(renameError);
    const removeTemporaryFile = vi.fn().mockResolvedValue(undefined);

    await expect(
      atomicallyReplace(destinationPath, "replacement\n", {
        writeTemporaryFile,
        renameTemporaryFile,
        removeTemporaryFile,
      })
    ).rejects.toBe(renameError);

    const temporaryPath = writeTemporaryFile.mock.calls[0]?.[0];
    expect(renameTemporaryFile).toHaveBeenCalledExactlyOnceWith(temporaryPath, destinationPath);
    expect(removeTemporaryFile).toHaveBeenCalledExactlyOnceWith(temporaryPath);
    expect(removeTemporaryFile).not.toHaveBeenCalledWith(destinationPath);
    await expect(readFile(destinationPath, "utf8")).resolves.toBe(priorBytes);
  });

  it("writes through an exclusive UUID temporary file and reads back the promoted bytes", async () => {
    const destinationPath = path.join(artifactDirectory, "success-readback-destination.json");
    const promotedBytes = "promoted-success-readback\n";

    await atomicallyReplace(destinationPath, promotedBytes);

    await expect(readFile(destinationPath, "utf8")).resolves.toBe(promotedBytes);
    await expect(readdir(artifactDirectory)).resolves.not.toContain(
      expect.stringMatching(/^\.success-readback-destination\.json\.[0-9a-f-]{36}\.tmp$/)
    );
  });

  it.each([
    [
      "versioned",
      {
        version: "1",
        exportedAt: "2026-09-09T00:00:00.000Z",
        cases: [],
      },
      "Invalid preference fixture: missing version",
    ],
    [
      "unversioned",
      {
        cases: [{ name: "Thalia, Guardian of Thraben", candidates: {} }],
      },
      "Invalid preference fixture: candidates must be an array",
    ],
  ])(
    "reports an explicit error for malformed %s input without changing the destination",
    async (_kind, malformedPayload, expectedError) => {
      const sourcePath = path.join(artifactDirectory, `${_kind}-malformed.json`);
      const destinationPath = path.join(artifactDirectory, `${_kind}-destination.json`);
      const priorBytes = `prior-${_kind}-destination-bytes\n`;
      await writeFile(sourcePath, JSON.stringify(malformedPayload), "utf8");
      await writeFile(destinationPath, priorBytes, "utf8");

      const result = await runPromotion(sourcePath, destinationPath);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(expectedError);
      await expect(readFile(destinationPath, "utf8")).resolves.toBe(priorBytes);
    }
  );

  it("validates and normalizes a versioned fixture before atomically promoting it", async () => {
    const sourcePath = path.join(artifactDirectory, "valid-versioned.json");
    const destinationPath = path.join(artifactDirectory, "valid-destination.json");
    await writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        exportedAt: "2026-09-09T00:00:00.000Z",
        cases: [
          {
            source: {
              name: "Thalia, Guardian of Thraben",
              set: "DKA",
              collectorNumber: "24",
            },
            expectedIdentifier: "abc123",
            candidates: [validCandidate()],
          },
        ],
      }),
      "utf8"
    );

    const result = await runPromotion(sourcePath, destinationPath);

    expect(result.code).toBe(0);
    await expect(readFile(destinationPath, "utf8")).resolves.toBe(
      `${JSON.stringify(
        {
          cases: [
            {
              name: "Thalia, Guardian of Thraben",
              expectedIdentifier: "abc123",
              candidates: [validCandidate()],
            },
          ],
        },
        null,
        2
      )}\n`
    );
  });
});
