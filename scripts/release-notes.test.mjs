import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

import { buildReleaseNotesPrompt, generateReleaseNotes } from './release-notes.mjs';

const stubFlag = '--release-notes-stdin-stub';

if (process.argv.includes(stubFlag)) {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdin += chunk;
  });
  process.stdin.on('end', () => {
    process.stdout.write(stdin);
  });
} else {
  test('release-note prompt reaches a local child stdin literally without a shell', async () => {
    const commits = [
      'abc123 feat: literal $HOME and `backticks`',
      'def456 fix: "double quotes" and \'single quotes\'',
      'ghi789 docs: first line',
      'second line with $(not-a-command)',
    ].join('\n');
    const expectedPrompt = buildReleaseNotesPrompt(commits, '1.2.3');
    let spawnedCommand;
    let spawnedArgs;

    const notes = await generateReleaseNotes(expectedPrompt, {
      command: process.execPath,
      args: [import.meta.filename, stubFlag],
      spawnImpl: (command, args, options) => {
        spawnedCommand = command;
        spawnedArgs = args;
        return spawn(command, args, options);
      },
    });

    assert.equal(notes, expectedPrompt);
    assert.equal(spawnedCommand, process.execPath);
    assert.deepEqual(spawnedArgs, [import.meta.filename, stubFlag]);
    assert.ok(!spawnedArgs.includes('-c'));
  });
}
