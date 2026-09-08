import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

const RELEASE_NOTES_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 1_048_576;
const MAX_DIAGNOSTIC_BYTES = 8_192;
const TERMINATION_GRACE_MS = 250;

export const buildReleaseNotesPrompt = (commits, version) => `Generate release notes for version ${version}. Output ONLY the formatted notes - no introduction, no "Here are the notes", just the categorized bullet points. Use markdown headers (###) for categories like Features, Fixes, etc. Be concise.\n\nCommits:\n${commits}`;

const readConfiguredProvider = () => {
  const command = process.env.RELEASE_NOTES_PROVIDER_COMMAND;
  const expectedVersion = process.env.RELEASE_NOTES_PROVIDER_EXPECTED_VERSION;
  let args;

  try {
    args = JSON.parse(process.env.RELEASE_NOTES_PROVIDER_ARGS ?? 'null');
  } catch {
    return null;
  }

  return command && isAbsolute(command) && expectedVersion && Array.isArray(args)
    && args.every((arg) => typeof arg === 'string')
    ? { command, args, expectedVersion }
    : null;
};

export const isReleaseNotesProviderConfigured = () => Boolean(readConfiguredProvider());

const terminateProcessTree = (child, { platform, killImpl, cleanupSpawnImpl }) => {
  if (!child?.pid) {
    try {
      child?.kill('SIGTERM');
    } catch {
      // The child has already gone away or could not be started.
    }
    return;
  }

  if (platform === 'win32') {
    try {
      const taskkill = cleanupSpawnImpl('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      taskkill.on?.('error', () => {});
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        // Nothing else can be safely terminated without a shell.
      }
    }
    return;
  }

  try {
    killImpl(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // The child has already gone away.
    }
  }
};

const runProvider = (command, args, input, {
  spawnImpl,
  onDiagnostic,
  timeoutMs,
  signal,
  platform,
  killImpl,
  cleanupSpawnImpl,
}) => new Promise((resolve) => {
  let output = '';
  let outputBytes = 0;
  let outputOverflowed = false;
  let diagnostic = '';
  let diagnosticBytes = 0;
  let settled = false;
  let child;
  let timeout;
  let stopping = false;
  let stopPromise;

  const reportDiagnostic = () => {
    if (diagnostic && onDiagnostic) {
      try {
        onDiagnostic(diagnostic);
      } catch {
        // Optional diagnostics must not affect the manual release-notes fallback.
      }
    }
  };
  const stop = () => {
    if (stopping) return stopPromise;
    stopping = true;
    terminateProcessTree(child, { platform, killImpl, cleanupSpawnImpl });
    if (platform !== 'win32' && child?.pid) {
      stopPromise = new Promise((resolve) => {
        setTimeout(() => {
          try {
            killImpl(-child.pid, 'SIGKILL');
          } catch {
            // The owned process group already exited.
          }
          resolve();
        }, TERMINATION_GRACE_MS);
      });
    } else {
      stopPromise = Promise.resolve();
    }
    return stopPromise;
  };
  const finish = (result, { report = false } = {}) => {
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (report) reportDiagnostic();
      resolve(result);
    }
  };
  const abort = () => {
    stop().then(() => finish(null, { report: true }));
  };

  if (signal?.aborted) {
    finish(null);
    return;
  }

  try {
    child = spawnImpl(command, args, {
      detached: platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    finish(null, { report: true });
    return;
  }

  child.stdout.on('data', (data) => {
    const chunk = Buffer.from(data);
    outputBytes += chunk.byteLength;
    if (outputBytes > MAX_STDOUT_BYTES) {
      outputOverflowed = true;
      return;
    }
    output += chunk.toString();
  });
  child.stderr.on('data', (data) => {
    const chunk = Buffer.from(data);
    const remaining = MAX_DIAGNOSTIC_BYTES - diagnosticBytes;
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining);
      diagnostic += retained.toString();
      diagnosticBytes += retained.byteLength;
    }
  });
  child.on('close', (code) => {
    if (stopping) return;
    const succeeded = code === 0 && !outputOverflowed;
    finish(succeeded ? output.trim() : null, { report: !succeeded });
  });
  child.on('error', abort);
  child.stdin.on('error', abort);
  signal?.addEventListener('abort', abort, { once: true });
  timeout = setTimeout(() => {
    abort();
  }, timeoutMs);
  try {
    child.stdin.end(input ?? '');
  } catch {
    abort();
  }
});

export const generateReleaseNotes = async (promptText, options = {}) => {
  const configured = options.command && options.args && options.expectedVersion
    ? options
    : readConfiguredProvider();

  if (!configured || !isAbsolute(configured.command) || !Array.isArray(configured.args)) {
    return null;
  }

  const executionOptions = {
    cleanupSpawnImpl: configured.cleanupSpawnImpl ?? spawn,
    killImpl: configured.killImpl ?? process.kill,
    onDiagnostic: configured.onDiagnostic,
    platform: configured.platform ?? process.platform,
    signal: configured.signal,
    spawnImpl: configured.spawnImpl ?? spawn,
    timeoutMs: configured.timeoutMs ?? RELEASE_NOTES_TIMEOUT_MS,
  };
  const version = await runProvider(
    configured.command,
    [...configured.args, '--version'],
    '',
    executionOptions,
  );
  if (version !== configured.expectedVersion) {
    return null;
  }

  const notes = await runProvider(configured.command, configured.args, promptText, executionOptions);
  return notes || null;
};

export const startReleaseNotesGeneration = (commits, version) =>
  generateReleaseNotes(buildReleaseNotesPrompt(commits, version));
