#!/usr/bin/env node
/** Validates the strict development-stage contract used by the emitted manager. */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, "electron", "dist", "microservice-package");
const manifestPath = path.join(stage, "microservice-artifact.json");
const bytes = await readFile(manifestPath);
const manifest = JSON.parse(bytes.toString("utf8"));
const expectedName = process.platform === "win32" ? "scryfall-cache.exe" : "scryfall-cache";
if (manifest?.schemaVersion !== 2 || manifest?.runtime !== "desktopSQLite" || manifest?.backend !== "sqlite" || manifest?.profile !== "release" || manifest?.platform !== process.platform) throw new Error("development stage is not a strict desktop SQLite v2 artifact");
if (manifest?.binary?.fileName !== expectedName || path.basename(manifest.binary.fileName) !== expectedName) throw new Error("development stage has a noncanonical binary name");
const binary = path.join(stage, expectedName); const binaryStat = await lstat(binary);
if (!binaryStat.isFile()) throw new Error("development stage binary is not a regular file");
const digest = createHash("sha256").update(await readFile(binary)).digest("hex");
if (digest !== manifest.binary.sha256) throw new Error("development stage binary SHA-256 mismatch");
process.stdout.write(`${JSON.stringify({ schema: "td-4496de-development-manifest-probe/v2", stage, manifestPath, binary, sha256: digest, status: "PASS" })}\n`);
