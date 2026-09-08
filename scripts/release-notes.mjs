import { spawn } from 'node:child_process';

const GEMINI_COMMAND = 'npx';
const GEMINI_ARGS = ['--yes', 'https://github.com/google-gemini/gemini-cli'];
const RELEASE_NOTES_TIMEOUT_MS = 120_000;

export const buildReleaseNotesPrompt = (commits, version) => `Generate release notes for version ${version}. Output ONLY the formatted notes - no introduction, no "Here are the notes", just the categorized bullet points. Use markdown headers (###) for categories like Features, Fixes, etc. Be concise.\n\nCommits:\n${commits}`;

export const generateReleaseNotes = (promptText, {
  command = GEMINI_COMMAND,
  args = GEMINI_ARGS,
  spawnImpl = spawn,
} = {}) => new Promise((resolve) => {
  let output = '';
  let resolved = false;
  const child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  const finish = (notes) => {
    if (!resolved) {
      resolved = true;
      clearTimeout(timeout);
      resolve(notes);
    }
  };

  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
    finish(null);
  }, RELEASE_NOTES_TIMEOUT_MS);

  child.stdout.on('data', (data) => {
    output += data.toString();
  });

  child.on('close', (code) => {
    finish(code === 0 && output.trim() ? output.trim() : null);
  });

  child.on('error', () => {
    finish(null);
  });

  child.stdin.end(promptText);
});

export const startReleaseNotesGeneration = (commits, version) =>
  generateReleaseNotes(buildReleaseNotesPrompt(commits, version));
