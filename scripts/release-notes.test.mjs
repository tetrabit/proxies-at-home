import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { buildReleaseNotesPrompt, generateReleaseNotes } from './release-notes.mjs';

const stubFlag = '--release-notes-stdin-stub';

if (process.argv.includes(stubFlag)) {
  if (process.argv.includes('--stub-descendant')) {
    if (process.argv.includes('--stub-ignore-sigterm')) {
      process.on('SIGTERM', () => {});
    }
    setInterval(() => {}, 1_000);
  } else {
    const version = process.argv.find((arg) => arg.startsWith('--stub-version='))?.slice('--stub-version='.length);
    if (process.argv.includes('--version')) {
      process.stdout.write(version ?? 'unconfigured-stub-version');
    } else {
      if (process.argv.includes('--stub-exit-before-input')) {
        process.exit(13);
      }
      const descendantPidFile = process.argv.find((arg) => arg.startsWith('--stub-descendant-pid-file='))?.slice('--stub-descendant-pid-file='.length);
      const parentPidFile = process.argv.find((arg) => arg.startsWith('--stub-parent-pid-file='))?.slice('--stub-parent-pid-file='.length);
      const selfExitAfterMs = Number(process.argv.find((arg) => arg.startsWith('--stub-self-exit-after-ms='))?.slice('--stub-self-exit-after-ms='.length) ?? '0');
      if (parentPidFile) {
        writeFileSync(parentPidFile, String(process.pid));
      }
      if (descendantPidFile) {
        const descendantArgs = [import.meta.filename, stubFlag, '--stub-descendant'];
        if (process.argv.includes('--stub-descendant-ignores-sigterm')) {
          descendantArgs.push('--stub-ignore-sigterm');
        }
        const descendant = spawn(process.execPath, descendantArgs, { stdio: 'ignore' });
        writeFileSync(descendantPidFile, String(descendant.pid));
        if (selfExitAfterMs > 0) {
          setTimeout(() => process.exit(13), selfExitAfterMs);
        }
      }
      if (process.argv.includes('--stub-exit-on-sigterm')) {
        process.on('SIGTERM', () => process.exit(13));
      }
      const stderrBytes = Number(process.argv.find((arg) => arg.startsWith('--stub-stderr-bytes='))?.slice('--stub-stderr-bytes='.length) ?? '0');
      const stdoutBytes = Number(process.argv.find((arg) => arg.startsWith('--stub-stdout-bytes='))?.slice('--stub-stdout-bytes='.length) ?? '0');
    const exitCode = Number(process.argv.find((arg) => arg.startsWith('--stub-exit-code='))?.slice('--stub-exit-code='.length) ?? '0');
    if (stderrBytes > 0) {
      process.stderr.write(Buffer.alloc(stderrBytes, 'x'));
    }
    let stdin = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      stdin += chunk;
    });
    process.stdin.on('end', () => {
      process.exitCode = exitCode;
      if (exitCode === 0) {
        process.stdout.write(stdoutBytes > 0 ? Buffer.alloc(stdoutBytes, 'o') : stdin);
      }
    });
    }
  }
} else {
  test('missing provider configuration disables optional generation without spawning', async () => {
    let spawnCount = 0;

    const notes = await generateReleaseNotes('must remain available for manual entry', {
      spawnImpl: () => {
        spawnCount += 1;
        throw new Error('a missing provider must never be started');
      },
    });

    assert.equal(notes, null);
    assert.equal(spawnCount, 0);
  });

  test('release-note prompt reaches a configured local child stdin literally without a shell', async () => {
    const commits = [
      'abc123 feat: literal $HOME and `backticks`',
      'def456 fix: "double quotes" and \'single quotes\'',
      'ghi789 docs: first line',
      'second line with $(not-a-command)',
    ].join('\n');
    const expectedPrompt = buildReleaseNotesPrompt(commits, '1.2.3');
    const spawned = [];

    const notes = await generateReleaseNotes(expectedPrompt, {
      command: process.execPath,
      args: [import.meta.filename, stubFlag, '--stub-version=provider-v1'],
      expectedVersion: 'provider-v1',
      spawnImpl: (command, args, options) => {
        spawned.push({ command, args });
        return spawn(command, args, options);
      },
    });

    assert.equal(notes, expectedPrompt);
    assert.deepEqual(spawned, [
      { command: process.execPath, args: [import.meta.filename, stubFlag, '--stub-version=provider-v1', '--version'] },
      { command: process.execPath, args: [import.meta.filename, stubFlag, '--stub-version=provider-v1'] },
    ]);
    assert.ok(spawned.every(({ args }) => !args.includes('-c')));
  });

  test('failed provider drains stderr while retaining only bounded diagnostics', async () => {
    const diagnostics = [];
    const notes = await generateReleaseNotes('ignored after provider failure', {
      command: process.execPath,
      args: [
        import.meta.filename,
        stubFlag,
        '--stub-version=provider-v1',
        '--stub-stderr-bytes=32768',
        '--stub-exit-code=12',
      ],
      expectedVersion: 'provider-v1',
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    assert.equal(notes, null);
    assert.equal(diagnostics.length, 1);
    assert.ok(Buffer.byteLength(diagnostics[0]) <= 8192);
    assert.match(diagnostics[0], /^x+/);
  });

  test('provider output above the stdout cap is drained and rejected', async () => {
    const notes = await generateReleaseNotes('ignored oversized provider output', {
      command: process.execPath,
      args: [import.meta.filename, stubFlag, '--stub-version=provider-v1', '--stub-stdout-bytes=1100000'],
      expectedVersion: 'provider-v1',
    });

    assert.equal(notes, null);
  });

  test('provider stdin EPIPE when the provider exits before input completes falls back safely', async () => {
    const notes = await generateReleaseNotes('x'.repeat(8 * 1024 * 1024), {
      command: process.execPath,
      args: [import.meta.filename, stubFlag, '--stub-version=provider-v1', '--stub-exit-before-input'],
      expectedVersion: 'provider-v1',
    });

    assert.equal(notes, null);
  });

  const waitForFile = async (path) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        return Number(await readFile(path, 'utf8'));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error(`stub did not write ${path}`);
  };

  const waitForProcessExit = async (pid) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`descendant ${pid} is still running`);
  };

  const readProcessGroupId = async (pid) => {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ');
    return Number(fields[2]);
  };

  const stopOwnedProcessGroupIfRunning = async (processGroupId, ownedMemberPid) => {
    if (!processGroupId || !ownedMemberPid) return;
    try {
      if (await readProcessGroupId(ownedMemberPid) === processGroupId) {
        process.kill(-processGroupId, 'SIGKILL');
      }
    } catch (error) {
      if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error;
    }
  };

  const stopProcessIfRunning = (pid) => {
    if (!pid) return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };

  test('timeout SIGKILLs the owned Unix process group after its SIGTERM-exiting parent closes', { skip: process.platform === 'win32' }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'release-notes-sigkill-'));
    const parentPidFile = join(directory, 'parent.pid');
    const descendantPidFile = join(directory, 'descendant.pid');
    let parentPid;
    let descendantPid;
    try {
      const notesPromise = generateReleaseNotes('SIGKILL regression', {
        command: process.execPath,
        args: [
          import.meta.filename,
          stubFlag,
          '--stub-version=provider-v1',
          `--stub-parent-pid-file=${parentPidFile}`,
          `--stub-descendant-pid-file=${descendantPidFile}`,
          '--stub-exit-on-sigterm',
          '--stub-descendant-ignores-sigterm',
        ],
        expectedVersion: 'provider-v1',
        timeoutMs: 250,
      });
      parentPid = await waitForFile(parentPidFile);
      descendantPid = await waitForFile(descendantPidFile);
      const parentProcessGroupId = await readProcessGroupId(parentPid);
      const descendantProcessGroupId = await readProcessGroupId(descendantPid);
      t.diagnostic(`provider PID=${parentPid}, PGID=${parentProcessGroupId}; ignored-stdio descendant PID=${descendantPid}, PGID=${descendantProcessGroupId}`);
      assert.equal(parentProcessGroupId, parentPid, 'detached provider must own its process group');
      assert.equal(descendantProcessGroupId, parentPid, 'ignored-stdio descendant must stay in the owned process group');

      assert.equal(await notesPromise, null);
      await waitForProcessExit(parentPid);
      await waitForProcessExit(descendantPid);
    } finally {
      await stopOwnedProcessGroupIfRunning(parentPid, descendantPid);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('timeout terminates the owned Unix descendant process group', { skip: process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'release-notes-timeout-'));
    const pidFile = join(directory, 'descendant.pid');
    let descendantPid;
    try {
      const notes = await generateReleaseNotes('timeout test', {
        command: process.execPath,
        args: [import.meta.filename, stubFlag, '--stub-version=provider-v1', `--stub-descendant-pid-file=${pidFile}`, '--stub-self-exit-after-ms=300'],
        expectedVersion: 'provider-v1',
        timeoutMs: 75,
      });
      descendantPid = await waitForFile(pidFile);

      assert.equal(notes, null);
      await waitForProcessExit(descendantPid);
    } finally {
      stopProcessIfRunning(descendantPid);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('abort signal terminates the owned Unix descendant process group', { skip: process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'release-notes-abort-'));
    const pidFile = join(directory, 'descendant.pid');
    let descendantPid;
    try {
      const controller = new AbortController();
      const notesPromise = generateReleaseNotes('abort test', {
        command: process.execPath,
        args: [import.meta.filename, stubFlag, '--stub-version=provider-v1', `--stub-descendant-pid-file=${pidFile}`, '--stub-self-exit-after-ms=300'],
        expectedVersion: 'provider-v1',
        signal: controller.signal,
      });
      descendantPid = await waitForFile(pidFile);
      controller.abort();
      const notes = await notesPromise;

      assert.equal(notes, null);
      await waitForProcessExit(descendantPid);
    } finally {
      stopProcessIfRunning(descendantPid);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('synchronous provider startup errors settle to the manual fallback', async () => {
    const notes = await generateReleaseNotes('startup error', {
      command: process.execPath,
      args: [],
      expectedVersion: 'provider-v1',
      spawnImpl: () => {
        throw new Error('intentional local stub startup failure');
      },
    });

    assert.equal(notes, null);
  });

  test('Windows timeout invokes taskkill with literal argument vector', async () => {
    const makeChild = (pid, output) => {
      const child = new EventEmitter();
      child.pid = pid;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      if (output !== null) {
        queueMicrotask(() => {
          child.stdout.end(output);
          child.stderr.end();
          child.emit('close', 0);
        });
      }
      return child;
    };
    const spawned = [makeChild(41, 'provider-v1'), makeChild(42, null)];
    const taskkillCalls = [];

    const notes = await generateReleaseNotes('windows timeout', {
      command: process.execPath,
      args: [],
      expectedVersion: 'provider-v1',
      platform: 'win32',
      timeoutMs: 10,
      spawnImpl: () => spawned.shift(),
      cleanupSpawnImpl: (command, args, options) => {
        taskkillCalls.push({ command, args, options });
        return new EventEmitter();
      },
    });

    assert.equal(notes, null);
    assert.deepEqual(taskkillCalls, [{
      command: 'taskkill',
      args: ['/pid', '42', '/t', '/f'],
      options: { shell: false, stdio: 'ignore', windowsHide: true },
    }]);
  });
}
