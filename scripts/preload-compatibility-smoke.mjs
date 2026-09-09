#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptDirectory = path.join(repositoryRoot, 'scripts');
const artifactRoot = path.join(repositoryRoot, '.review-artifacts', 'preload-compatibility-smoke');
const electronExecutable = path.join(
  repositoryRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);
const typescriptExecutable = path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const harness = path.join(scriptDirectory, 'preload-compatibility-harness.mjs');
const buildInputPaths = [
  path.join(repositoryRoot, 'electron', 'main.ts'),
  path.join(repositoryRoot, 'electron', 'preload.cts'),
  path.join(repositoryRoot, 'electron', 'preload-api.ts'),
  path.join(repositoryRoot, 'electron', 'mpc-preferences.ts'),
  path.join(repositoryRoot, 'electron', 'tsconfig.json'),
  path.join(repositoryRoot, 'package.json'),
  path.join(repositoryRoot, 'package-lock.json'),
];
const lockInputPaths = [path.join(repositoryRoot, 'package-lock.json')];
const postbuildArtifactPaths = [
  path.join(repositoryRoot, 'electron', 'dist', 'preload.cjs'),
];
const provenanceScopePaths = [
  ...buildInputPaths,
  harness,
  path.join(scriptDirectory, 'preload-compatibility-smoke.mjs'),
  path.join(scriptDirectory, 'preload-compatibility-smoke.test.mjs'),
];

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function fileRecord(filePath) {
  if (!existsSync(filePath)) return { path: filePath, exists: false };
  const details = await stat(filePath);
  return {
    path: filePath,
    exists: true,
    bytes: details.size,
    mtime: details.mtime.toISOString(),
    sha256: await sha256(filePath),
  };
}

export function emittedPreloadDependencyGraph(source) {
  const requireSpecifiers = [];
  const requirePattern = /\brequire\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  for (const match of source.matchAll(requirePattern)) {
    if (!requireSpecifiers.includes(match[2])) requireSpecifiers.push(match[2]);
  }
  const relativeRequireSpecifiers = requireSpecifiers.filter((specifier) =>
    specifier.startsWith('./') || specifier.startsWith('../') || path.isAbsolute(specifier)
  );
  const unexpectedRequireSpecifiers = requireSpecifiers.filter((specifier) => specifier !== 'electron');
  return {
    requireSpecifiers,
    relativeRequireSpecifiers,
    unexpectedRequireSpecifiers,
    selfContained: relativeRequireSpecifiers.length === 0 && unexpectedRequireSpecifiers.length === 0,
  };
}

function serializeCommandError(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: error && typeof error === 'object' && 'code' in error ? error.code ?? null : null,
    message: error instanceof Error ? error.message : String(error),
  };
}

function commandRecord(executable, arguments_, { cwd = repositoryRoot } = {}) {
  try {
    return {
      executable,
      arguments: arguments_,
      cwd,
      ok: true,
      stdout: execFileSync(executable, arguments_, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    };
  } catch (error) {
    return {
      executable,
      arguments: arguments_,
      cwd,
      ok: false,
      error: serializeCommandError(error),
      stdout: typeof error?.stdout === 'string' ? error.stdout.trim() : null,
      stderr: typeof error?.stderr === 'string' ? error.stderr.trim() : null,
    };
  }
}

function gitRecord(arguments_) {
  return commandRecord('git', arguments_, { cwd: repositoryRoot });
}

function captureGitProvenance() {
  const commit = gitRecord(['rev-parse', 'HEAD']);
  const tree = gitRecord(['rev-parse', 'HEAD^{tree}']);
  const indexTree = gitRecord(['write-tree']);
  const scopedStatus = gitRecord([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ...provenanceScopePaths,
  ]);
  return {
    commit: commit.ok ? commit.stdout : null,
    tree: tree.ok ? tree.stdout : null,
    indexTree: indexTree.ok ? indexTree.stdout : null,
    dirtyScopedStatus: scopedStatus.ok ? scopedStatus.stdout.split('\n').filter(Boolean) : null,
    commands: { commit, tree, indexTree, scopedStatus },
  };
}

async function createRunDirectory() {
  const runsRoot = path.join(artifactRoot, 'runs');
  await mkdir(runsRoot, { recursive: true });
  for (;;) {
    const runDirectory = path.join(
      runsRoot,
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomUUID()}`
    );
    try {
      await mkdir(runDirectory);
      return runDirectory;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'EEXIST') continue;
      throw error;
    }
  }
}

export function ownedProcessGroupMembers(processGroupId, { execFileSyncFn = execFileSync } = {}) {
  if (process.platform === 'win32') {
    return { supported: false, status: 'unsupported', pids: null };
  }
  try {
    const output = execFileSyncFn('ps', ['-o', 'pid=', '-g', String(processGroupId)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return {
      supported: true,
      status: 'known',
      pids: output.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger),
    };
  } catch (error) {
    const stdout = typeof error?.stdout === 'string'
      ? error.stdout
      : Buffer.isBuffer(error?.stdout) ? error.stdout.toString('utf8') : '';
    const stderr = typeof error?.stderr === 'string'
      ? error.stderr
      : Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : '';
    if (error?.status === 1 && stdout.trim() === '' && stderr.trim() === '') {
      return {
        supported: true,
        status: 'known',
        pids: [],
        source: 'ps-no-matching-process-group',
      };
    }
    return {
      supported: true,
      status: 'unknown',
      pids: null,
      error: serializeCommandError(error),
    };
  }
}

export function isVerifiedOwnedChildShutdown({ reaped, scan }) {
  return Boolean(
    reaped &&
    scan?.supported === true &&
    scan.status === 'known' &&
    Array.isArray(scan.pids) &&
    scan.pids.length === 0
  );
}

async function closeOnlyOwnedChildProcessGroup(child) {
  if (!child.pid) return { attempted: false, mode: 'no-child-pid', verified: false };
  if (process.platform === 'win32') {
    child.kill('SIGTERM');
    return {
      attempted: true,
      mode: 'owned-child-windows',
      pid: child.pid,
      verified: false,
      reason: 'process-group scan unsupported on Windows',
    };
  }

  const signals = [];
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-child.pid, signal);
      signals.push({ signal, delivered: true });
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ESRCH') {
        signals.push({ signal, delivered: false, reason: 'process-group-not-found' });
        break;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, signal === 'SIGTERM' ? 750 : 250));
    const scan = ownedProcessGroupMembers(child.pid);
    if (scan.status === 'known' && scan.pids.length === 0) {
      return {
        attempted: true,
        mode: 'owned-child-process-group',
        pid: child.pid,
        signals,
        scan,
        verified: false,
        reason: 'child exit must still be reaped by the parent',
      };
    }
    if (signal === 'SIGKILL') {
      return {
        attempted: true,
        mode: 'owned-child-process-group',
        pid: child.pid,
        signals,
        scan,
        verified: false,
        reason: scan.status === 'unknown'
          ? 'owned process-group scan failed; shutdown is unknown'
          : 'owned process group still has members after SIGKILL',
      };
    }
  }
  return { attempted: true, mode: 'owned-child-process-group', pid: child.pid, signals, verified: false };
}

async function runProbe() {
  const runDirectory = await createRunDirectory();
  const retainedProfileDirectory = path.join(runDirectory, 'retained-user-data');
  const harnessReportFile = path.join(runDirectory, 'harness-report.json');
  const stdoutFile = path.join(runDirectory, 'electron.stdout.log');
  const stderrFile = path.join(runDirectory, 'electron.stderr.log');
  const reportFile = path.join(runDirectory, 'probe-report.json');
  await mkdir(retainedProfileDirectory, { recursive: true });

  const git = captureGitProvenance();
  const buildInputs = await Promise.all(buildInputPaths.map(fileRecord));
  const lockInputs = await Promise.all(lockInputPaths.map(fileRecord));
  const compilerVersion = commandRecord(process.execPath, [typescriptExecutable, '--version']);
  const build = commandRecord(process.execPath, [typescriptExecutable, '-p', 'electron/tsconfig.json']);
  const postbuildArtifacts = await Promise.all(postbuildArtifactPaths.map(fileRecord));
  const emittedPreload = postbuildArtifacts[0];
  let emittedDependencyGraph = null;
  let emittedPreloadDependencyGraphError = null;
  if (emittedPreload?.exists) {
    try {
      emittedDependencyGraph = emittedPreloadDependencyGraph(await readFile(emittedPreload.path, 'utf8'));
    } catch (error) {
      emittedPreloadDependencyGraphError = serializeCommandError(error);
    }
  }
  const runtimeInputs = await Promise.all([
    electronExecutable,
    harness,
    ...postbuildArtifactPaths,
  ].map(fileRecord));
  const missing = [...buildInputs, ...lockInputs, ...runtimeInputs]
    .filter((record) => !record.exists)
    .map((record) => record.path);

  let stdout = '';
  let stderr = '';
  let electronPid = null;
  let exitCode = null;
  let exitSignal = null;
  let launchError = null;
  let timedOut = false;
  let reapedOwnedChild = false;
  let childClosure = { attempted: false, mode: 'not-needed', verified: false };
  let ownedProcessGroupAfterExit = { supported: process.platform !== 'win32', status: 'not-observed', pids: null };

  if (missing.length === 0 && build.ok) {
    const child = spawn(
      electronExecutable,
      [
        '--headless',
        '--disable-gpu',
        `--user-data-dir=${retainedProfileDirectory}`,
        harness,
        `--preload=${path.join(repositoryRoot, 'electron', 'dist', 'preload.cjs')}`,
        `--user-data=${retainedProfileDirectory}`,
        `--report-file=${harnessReportFile}`,
      ],
      {
        cwd: repositoryRoot,
        detached: process.platform !== 'win32',
        env: { ...process.env, ELECTRON_DISABLE_GPU: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    electronPid = child.pid ?? null;
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ kind: 'exit', code, signal }));
      child.once('error', (error) => resolve({ kind: 'error', error }));
    });
    const result = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 15_000)),
    ]);
    if (result.kind === 'exit') {
      reapedOwnedChild = electronPid !== null;
      exitCode = result.code;
      exitSignal = result.signal;
    } else if (result.kind === 'error') {
      launchError = `${result.error.name}: ${result.error.message}`;
    } else {
      timedOut = true;
      childClosure = await closeOnlyOwnedChildProcessGroup(child);
      const finalResult = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve({ kind: 'unreaped' }), 2_000)),
      ]);
      if (finalResult.kind === 'exit') {
        reapedOwnedChild = electronPid !== null;
        exitCode = finalResult.code;
        exitSignal = finalResult.signal;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    ownedProcessGroupAfterExit = ownedProcessGroupMembers(child.pid);
  }

  await Promise.all([
    writeFile(stdoutFile, stdout, 'utf8'),
    writeFile(stderrFile, stderr, 'utf8'),
  ]);
  let harnessReport = null;
  try {
    harnessReport = JSON.parse(await readFile(harnessReportFile, 'utf8'));
  } catch {
    // The report records this absence as a failed real-runtime execution.
  }

  const processOwnership = {
    reapedOwnedChild,
    ownedProcessGroupAfterExit,
    verifiedShutdown: isVerifiedOwnedChildShutdown({
      reaped: reapedOwnedChild,
      scan: ownedProcessGroupAfterExit,
    }),
  };
  const provenanceComplete =
    git.commit !== null &&
    git.tree !== null &&
    git.indexTree !== null &&
    git.dirtyScopedStatus !== null &&
    compilerVersion.ok &&
    lockInputs.every((record) => record.exists) &&
    postbuildArtifacts.every((record) => record.exists) &&
    emittedDependencyGraph?.selfContained === true &&
    emittedPreloadDependencyGraphError === null;
  const blocked = missing.length > 0 || !build.ok || !compilerVersion.ok || !provenanceComplete || launchError !== null;
  const passed =
    !blocked &&
    !timedOut &&
    exitCode === 0 &&
    harnessReport?.status === 'PASS' &&
    processOwnership.verifiedShutdown;
  const status = blocked ? 'BLOCKED' : passed ? 'PASS' : 'FAIL';
  const report = {
    schema: 'preload-compatibility-smoke/v2',
    status,
    classification: status === 'PASS'
      ? 'real sandboxed installed-Electron preload compatibility pass'
      : status === 'BLOCKED'
        ? 'build or runtime provenance unavailable; not a pass'
        : 'real sandboxed installed-Electron preload compatibility failure; not a pass',
    command: 'node scripts/preload-compatibility-smoke.mjs',
    provenance: {
      git,
      build: {
        command: build,
        compilerVersion,
        inputHashes: buildInputs,
        lockInputHashes: lockInputs,
        postbuildArtifactHashes: postbuildArtifacts,
        emittedPreloadDependencyGraph: emittedDependencyGraph,
        emittedPreloadDependencyGraphError,
      },
      complete: provenanceComplete,
    },
    runtimeContract: {
      electronExecutable,
      actualElectron: true,
      mockedElectron: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      forbiddenSandboxDisablingSwitchesAbsent: true,
      passedElectronArguments: ['--headless', '--disable-gpu'],
    },
    isolation: {
      runDirectory,
      retainedProfileDirectory,
      retained: true,
      deletedByProbe: false,
    },
    missing,
    process: {
      electronPid,
      exitCode,
      exitSignal,
      timedOut,
      launchError,
      childClosure,
      ...processOwnership,
    },
    harnessReport,
    logs: { stdoutFile, stderrFile },
  };
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = status === 'PASS' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runProbe();
}
