import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactParent = resolve(repositoryRoot, '.review-artifacts');
const skippedDirectoryNames = new Set([
  '.git',
  '.recovery',
  '.review-artifacts',
  '.todos',
  'coverage',
  'data',
  'dist',
  'node_modules',
  '__pycache__',
]);

export function validateArtifactId(value) {
  if (!/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(value) || value.length > 80) {
    throw new Error(`Invalid artifact id: ${value}`);
  }
  return value;
}

export function chooseArtifactId(requestedId, exists) {
  const base = validateArtifactId(requestedId);
  if (!exists(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!exists(candidate)) return candidate;
  }
}

export function imageTagForArtifactId(artifactId) {
  return `proxxied-${validateArtifactId(artifactId)}:latest`;
}

export function buildRuntimeCommand(outputDirectory = '/output') {
  return `
set -eu
profile_file=${outputDirectory}/profiles.toml
input_pdf=${outputDirectory}/input.pdf
output_pdf=${outputDirectory}/calibrated.pdf
$PRINTER_CALIBRATION_BIN profile set --name smoke --front-x-mm 0.25 --front-y-mm -0.50 --back-x-mm 0.75 --back-y-mm -1.00 --profile-file "$profile_file"
profiles="$($PRINTER_CALIBRATION_BIN profile list --profile-file "$profile_file")"
printf 'PROFILE_LIST=%s\\n' "$profiles"
[ "$profiles" = smoke ]
$PRINTER_CALIBRATION_BIN sheet --output ${outputDirectory}/input.pdf
$PRINTER_CALIBRATION_BIN apply --profile smoke --input "$input_pdf" --output "$output_pdf" --profile-file "$profile_file"
$PRINTER_CALIBRATION_PYTHON -c 'import importlib.metadata as metadata, json; from pypdf import PdfReader; result = {};\nfor label, path in (("input", "/output/input.pdf"), ("calibrated", "/output/calibrated.pdf")):\n reader = PdfReader(path); boxes = [[float(page.mediabox.width), float(page.mediabox.height)] for page in reader.pages]; assert not reader.is_encrypted; assert len(reader.pages) == 2; assert boxes == [[612.0, 792.0], [612.0, 792.0]]; result[label] = {"pages": len(reader.pages), "media_boxes": boxes};\nprint("PDF_VALIDATION=" + json.dumps(result, sort_keys=True)); print("VERSIONS=" + json.dumps({name: metadata.version(name) for name in ("printer-calibration", "pypdf", "reportlab", "tomli-w", "hatchling")}, sort_keys=True))'
`.trim();
}

export function buildRuntimeArguments({ imageTag, containerName, outputDirectory, uid, gid }) {
  return [
    'run', '--name', containerName, '--network', 'none', '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m,mode=1777',
    '--user', `${uid}:${gid}`,
    '--mount', `type=bind,src=${outputDirectory},dst=/output`,
    '--entrypoint', '/bin/sh', imageTag, '-ceu', buildRuntimeCommand('/output'),
  ];
}

function parseArguments(argv) {
  if (argv.length === 0) return { requestedArtifactId: 'b21-image-smoke-01' };
  if (argv.length === 2 && argv[0] === '--artifact-id') {
    return { requestedArtifactId: validateArtifactId(argv[1]) };
  }
  throw new Error('Usage: node scripts/calibration-image-smoke.mjs [--artifact-id NAME]');
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function assertDescendant(path, parent) {
  const pathRelativeToParent = relative(parent, path);
  if (pathRelativeToParent === '' || pathRelativeToParent.startsWith('..') || pathRelativeToParent.includes('/../')) {
    throw new Error(`Refusing path outside artifact parent: ${path}`);
  }
}

function shouldSkip(entryName) {
  return skippedDirectoryNames.has(entryName) ||
    entryName === '.env' ||
    entryName.startsWith('.env.') ||
    entryName.endsWith('.pyc') ||
    (entryName.startsWith('test_') && entryName.endsWith('.py')) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entryName);
}

async function copyFiltered(source, destination) {
  const sourceStat = await stat(source);
  if (!sourceStat.isDirectory()) throw new Error(`Expected source directory: ${source}`);
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (shouldSkip(entry.name)) continue;
    const sourcePath = resolve(source, entry.name);
    const destinationPath = resolve(destination, entry.name);
    if (entry.isDirectory()) {
      await copyFiltered(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await cp(sourcePath, destinationPath, { force: false, errorOnExist: true });
    } else {
      throw new Error(`Refusing non-regular build-context entry: ${sourcePath}`);
    }
  }
}

function run(command, args, logPath, { captureStdout = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repositoryRoot, shell: false });
    let stdout = '';
    let stderr = '';
    const writeLog = (prefix, chunk) => writeFile(logPath, `${prefix}${chunk.toString()}`, { flag: 'a' });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      void writeLog('', chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      void writeLog('', chunk);
    });
    child.on('error', rejectRun);
    child.on('close', (code, signal) => {
      if (code === 0) resolveRun({ stdout: captureStdout ? stdout : '', stderr });
      else rejectRun(Object.assign(new Error(`${command} exited ${code ?? `by signal ${signal}`}`), { stdout, stderr, code, signal }));
    });
  });
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function parseRequiredRuntimeOutput(stdout) {
  const profileLine = stdout.split('\n').find((line) => line.startsWith('PROFILE_LIST='));
  const pdfLine = stdout.split('\n').find((line) => line.startsWith('PDF_VALIDATION='));
  const versionsLine = stdout.split('\n').find((line) => line.startsWith('VERSIONS='));
  if (profileLine !== 'PROFILE_LIST=smoke' || !pdfLine || !versionsLine) {
    throw new Error('Runtime output did not prove profile listing, PDF validation, and resolved versions');
  }
  const pdf = JSON.parse(pdfLine.slice('PDF_VALIDATION='.length));
  const versions = JSON.parse(versionsLine.slice('VERSIONS='.length));
  for (const label of ['input', 'calibrated']) {
    if (pdf[label]?.pages !== 2 || JSON.stringify(pdf[label]?.media_boxes) !== JSON.stringify([[612, 792], [612, 792]])) {
      throw new Error(`Runtime PDF validation did not confirm two US Letter pages for ${label}`);
    }
  }
  for (const packageName of ['printer-calibration', 'pypdf', 'reportlab', 'tomli-w', 'hatchling']) {
    if (typeof versions[packageName] !== 'string' || versions[packageName] === '') {
      throw new Error(`Runtime output omitted resolved version for ${packageName}`);
    }
  }
  return { pdf, versions };
}

async function dockerInspect(args, logPath) {
  return (await run('docker', args, logPath, { captureStdout: true })).stdout.trim();
}

export async function main(argv = process.argv.slice(2)) {
  const { requestedArtifactId } = parseArguments(argv);
  await mkdir(artifactParent, { recursive: true });
  const artifactId = chooseArtifactId(requestedArtifactId, (candidate) => {
    // This synchronous check is intentionally only advisory; mkdir below is the collision authority.
    return false;
  });
  let artifactPath = resolve(artifactParent, artifactId);
  assertDescendant(artifactPath, artifactParent);
  let collisionSuffix = 2;
  while (await pathExists(artifactPath)) {
    artifactPath = resolve(artifactParent, `${requestedArtifactId}-${collisionSuffix}`);
    assertDescendant(artifactPath, artifactParent);
    collisionSuffix += 1;
  }
  await mkdir(artifactPath);
  const resolvedArtifactId = relative(artifactParent, artifactPath);

  const buildContext = resolve(artifactPath, 'filtered-build-context');
  const outputDirectory = resolve(artifactPath, 'runtime-output');
  await mkdir(outputDirectory);
  await copyFiltered(resolve(repositoryRoot, 'server'), resolve(buildContext, 'server'));
  await copyFiltered(resolve(repositoryRoot, 'shared'), resolve(buildContext, 'shared'));

  const imageTag = imageTagForArtifactId(resolvedArtifactId);
  const containerName = `${resolvedArtifactId}-runtime-${randomUUID().slice(0, 8)}`;
  const buildLog = resolve(artifactPath, 'docker-build.log');
  const runtimeLog = resolve(artifactPath, 'docker-runtime.log');
  const inspectLog = resolve(artifactPath, 'docker-inspect.log');
  const buildArgs = ['build', '--file', 'server/dockerfile', '--target', 'runtime', '--tag', imageTag, buildContext];
  const runtimeArgs = buildRuntimeArguments({
    imageTag,
    containerName,
    outputDirectory,
    uid: process.getuid(),
    gid: process.getgid(),
  });

  const manifest = {
    artifact_id: relative(artifactParent, artifactPath),
    build: { command: ['docker', ...buildArgs], context: 'filtered-build-context (server + shared only; excludes .env, .git, .todos, .recovery, .review-artifacts, data, node_modules, dist, tests, and Python bytecode)' },
    runtime: { command: ['docker', ...runtimeArgs.slice(0, -1), '<bounded CLI smoke command>'], container_name: containerName },
  };
  await writeFile(resolve(artifactPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  try {
    await run('docker', buildArgs, buildLog);
    const imageId = await dockerInspect(['image', 'inspect', '--format', '{{.Id}}', imageTag], inspectLog);
    const runtimeResult = await run('docker', runtimeArgs, runtimeLog, { captureStdout: true });
    const validation = parseRequiredRuntimeOutput(runtimeResult.stdout);
    const containerState = await dockerInspect(['container', 'inspect', '--format', '{{json .State}} {{json .HostConfig.NetworkMode}} {{json .HostConfig.ReadonlyRootfs}}', containerName], inspectLog);
    if (!containerState.includes('"ExitCode":0') || !containerState.endsWith('"none" true')) {
      throw new Error(`Retained container did not exit successfully with network none and a read-only root: ${containerState}`);
    }
    manifest.result = {
      image_id: imageId,
      container_state: containerState,
      pdf: validation.pdf,
      resolved_versions: validation.versions,
      output_sha256: {
        input_pdf: await sha256(resolve(outputDirectory, 'input.pdf')),
        calibrated_pdf: await sha256(resolve(outputDirectory, 'calibrated.pdf')),
        profiles_toml: await sha256(resolve(outputDirectory, 'profiles.toml')),
      },
      retained: { container_name: containerName, artifact_path: relative(repositoryRoot, artifactPath) },
    };
    await writeFile(resolve(artifactPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest.result, null, 2));
  } catch (error) {
    manifest.result = { status: 'BLOCKED_OR_FAILED', error: error instanceof Error ? error.message : String(error), retained: { container_name: containerName, artifact_path: relative(repositoryRoot, artifactPath) } };
    await writeFile(resolve(artifactPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
