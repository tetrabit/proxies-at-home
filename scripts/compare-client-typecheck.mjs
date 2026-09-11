// Compare current TypeScript diagnostics with committed source in memory.
// No worktree, checkout, or baseline filesystem copy is created.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from '../client/node_modules/typescript/lib/typescript.js';

const root = path.resolve(import.meta.dirname, '..');
const base = process.argv[2] || 'HEAD';
const output = process.argv[3];
if (!output) throw new Error('Usage: node scripts/compare-client-typecheck.mjs BASE OUTPUT.json');
const tracked = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', base], { cwd: root, encoding: 'utf8' }).trim().split('\n'));
const baseline = new Map();
function sourceAtBase(file) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (!tracked.has(relative) || !/\.(?:[cm]?tsx?|json)$/.test(relative)) return undefined;
  if (!baseline.has(relative)) baseline.set(relative, execFileSync('git', ['show', `${base}:${relative}`], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }));
  return baseline.get(relative);
}
function diagnostics(atBase) {
  const configPath = path.join(root, 'client/tsconfig.app.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const host = ts.createCompilerHost(parsed.options);
  if (atBase) {
    const read = host.readFile;
    host.readFile = file => sourceAtBase(file) ?? read(file);
  }
  const names = atBase ? parsed.fileNames.filter(file => tracked.has(path.relative(root, file).split(path.sep).join('/'))) : parsed.fileNames;
  const program = ts.createProgram(names, { ...parsed.options, incremental: false, tsBuildInfoFile: undefined, noEmit: true }, host);
  return ts.getPreEmitDiagnostics(program).map(d => ({
    file: d.file ? path.relative(root, d.file.fileName) : null,
    line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null,
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  }));
}
const current = diagnostics(false);
const committed = diagnostics(true);
const key = d => JSON.stringify([d.file, d.code, d.message]);
const counts = new Map();
for (const d of committed) counts.set(key(d), (counts.get(key(d)) || 0) + 1);
const added = current.filter(d => { const k = key(d); const n = counts.get(k) || 0; if (n) { counts.set(k, n - 1); return false; } return true; });
const report = { base, method: 'TypeScript compiler host uses git-show committed tracked sources in memory; unchanged config and dependencies from existing main checkout', baseline_count: committed.length, current_count: current.length, added, current, baseline: committed };
fs.mkdirSync(path.dirname(path.resolve(root, output)), { recursive: true });
fs.writeFileSync(path.resolve(root, output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ baseline_count: committed.length, current_count: current.length, added }, null, 2));
process.exitCode = added.length ? 1 : 0;
