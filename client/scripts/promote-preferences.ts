import { randomUUID } from "node:crypto";
import { rename, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as preferenceFixtureValidationModule from "../../shared/preferenceFixtureValidation.ts";

const preferenceFixtureValidation =
  (preferenceFixtureValidationModule as typeof preferenceFixtureValidationModule & {
    default?: typeof preferenceFixtureValidationModule;
  }).default ?? preferenceFixtureValidationModule;
const { parseMpcPreferenceFixtureForPromotion } = preferenceFixtureValidation;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultDestinationPath = path.resolve(
  scriptDirectory,
  "../tests/fixtures/mpc-preference-defaults.v1.json"
);

interface PromotionPaths {
  sourcePath: string;
  destinationPath: string;
}

function usageError(): Error {
  return new Error(
    "Usage: npm run preferences:promote -- /absolute/path/to/mpc-preferences.user.json [--destination /path/to/fixture.json]"
  );
}

function parsePromotionPaths(arguments_: string[]): PromotionPaths {
  const [sourcePath, ...options] = arguments_;
  if (!sourcePath) {
    throw usageError();
  }

  if (options.length === 0) {
    return { sourcePath, destinationPath: defaultDestinationPath };
  }

  if (options.length === 2 && options[0] === "--destination" && options[1]) {
    return { sourcePath, destinationPath: path.resolve(options[1]) };
  }

  throw usageError();
}

function parseFixtureJson(contents: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new Error("Invalid preference fixture: invalid JSON");
  }
}

export interface AtomicFileOperations {
  writeTemporaryFile(temporaryPath: string, contents: string): Promise<void>;
  renameTemporaryFile(temporaryPath: string, destinationPath: string): Promise<void>;
  removeTemporaryFile(temporaryPath: string): Promise<void>;
}

const nodeAtomicFileOperations: AtomicFileOperations = {
  writeTemporaryFile: (temporaryPath, contents) =>
    writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" }),
  renameTemporaryFile: rename,
  removeTemporaryFile: unlink,
};

function isAlreadyExistingTemporaryFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

export async function atomicallyReplace(
  destinationPath: string,
  contents: string,
  operations: AtomicFileOperations = nodeAtomicFileOperations
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${randomUUID()}.tmp`
  );

  let temporaryFileWritten = false;

  try {
    await operations.writeTemporaryFile(temporaryPath, contents);
    temporaryFileWritten = true;
    await operations.renameTemporaryFile(temporaryPath, destinationPath);
  } catch (error: unknown) {
    // "wx" cannot create a file on EEXIST, so that path was not made by this operation.
    if (temporaryFileWritten || !isAlreadyExistingTemporaryFileError(error)) {
      await operations.removeTemporaryFile(temporaryPath);
    }
    throw error;
  }
}

export async function promotePreferences(arguments_: string[]): Promise<PromotionPaths> {
  const { sourcePath, destinationPath } = parsePromotionPaths(arguments_);
  const payload = parseFixtureJson(await readFile(sourcePath, "utf8"));
  const normalizedPayload = parseMpcPreferenceFixtureForPromotion(payload);
  const serializedPayload = `${JSON.stringify(normalizedPayload, null, 2)}\n`;

  // Do not create a temporary file until JSON parsing and shared-schema validation pass.
  await atomicallyReplace(destinationPath, serializedPayload);
  return { sourcePath, destinationPath };
}

async function main(): Promise<void> {
  try {
    const { sourcePath, destinationPath } = await promotePreferences(process.argv.slice(2));
    console.log(`Promoted preferences from ${sourcePath} to ${destinationPath}`);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
