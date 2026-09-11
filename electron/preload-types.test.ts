import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('lets renderer subscribers retain typed disposer functions', () => {
  const client = path.resolve(import.meta.dirname, '../client');
  const probePath = path.join(client, 'src/__preload_disposer_type_probe.ts');
  const source = `
    export function subscribe(api: NonNullable<Window['electronAPI']>) {
      const updateDisposer: () => void = api.onUpdateStatus(() => {});
      const aboutDisposer: () => void = api.onShowAbout(() => {});
      const execute = api.calibrationHarnessExecute;
      if (execute) {
        void execute({ kind: 'getSession' }).then(result => result.ok ? result.value : result.error.code);
      }
      return [updateDisposer, aboutDisposer];
    }
  `;
  const config = ts.readConfigFile(path.join(client, 'tsconfig.app.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, client);
  const options = { ...parsed.options, noEmit: true, incremental: false, tsBuildInfoFile: undefined };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
    file === probePath
      ? ts.createSourceFile(file, source, languageVersion, true)
      : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([probePath, path.join(client, 'src/vite-env.d.ts')], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program)
    .filter(diagnostic => diagnostic.file?.fileName === probePath)
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  expect(diagnostics).toEqual([]);
});

it('lets renderer code receive a typed private API bootstrap', () => {
  const client = path.resolve(import.meta.dirname, '../client');
  const probePath = path.join(client, 'src/__preload_bootstrap_type_probe.ts');
  const source = `
    export async function bootstrap(api: NonNullable<Window['electronAPI']>) {
      if (!api.getPrivateApiBootstrap) return [];
      const { baseUrl, bearer } = await api.getPrivateApiBootstrap();
      const exactBaseUrl: string = baseUrl;
      const exactBearer: string = bearer;
      return [exactBaseUrl, exactBearer];
    }
  `;
  const config = ts.readConfigFile(path.join(client, 'tsconfig.app.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, client);
  const options = { ...parsed.options, noEmit: true, incremental: false, tsBuildInfoFile: undefined };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
    file === probePath
      ? ts.createSourceFile(file, source, languageVersion, true)
      : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([probePath, path.join(client, 'src/vite-env.d.ts')], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program)
    .filter(diagnostic => diagnostic.file?.fileName === probePath)
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  expect(diagnostics).toEqual([]);
});
