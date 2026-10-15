// PURPOSE: Typecheck and load generated configs against the packed public SDK.
// PURPOSE: Run after npm run build; no Docker daemon or external credentials needed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { generateConfig } from '../dist/src/cli/init.js';
import { generateRunnerScript } from '../dist/src/hosts/docker.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'mandible-consumer-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

try {
  const [{ filename }] = JSON.parse(execFileSync(npm, [
    'pack', '--json', '--ignore-scripts', '--pack-destination', temp,
  ], { cwd: root, encoding: 'utf8' }));
  execFileSync('tar', ['-xzf', join(temp, filename), '-C', temp]);
  const packed = join(temp, 'package');
  const consumer = join(temp, 'consumer');
  await mkdir(join(consumer, 'node_modules', '@mandible-ai'), { recursive: true });
  await writeFile(join(consumer, 'package.json'), '{"type":"module"}\n');
  // Resolve from the package that npm would publish, not source-only TS aliases.
  await symlink(packed, join(consumer, 'node_modules', '@mandible-ai', 'mandible'), 'dir');
  await symlink(join(root, 'node_modules'), join(packed, 'node_modules'), 'dir');

  const files = [];
  for (const env of ['filesystem', 'dolt', 'github']) {
    const file = join(consumer, `${env}.ts`);
    const source = generateConfig({
      name: `test-${env}`, env,
      envOptions: env === 'filesystem' ? { root: join(temp, 'signals') }
        : env === 'dolt' ? { owner: 'example', database: 'signals' } : { repo: 'example/signals' },
    });
    await writeFile(file, source);
    files.push(file);
  }

  const readme = await readFile(join(root, 'README.md'), 'utf8');
  for (const [heading, file] of [
    ['### Colony builder', 'colonies/worker.ts'],
    ['#### Local (default)', 'local.ts'],
    ['#### Docker', 'docker.ts'],
  ]) {
    const section = readme.split(heading)[1];
    const source = section?.match(/```typescript\n([\s\S]*?)```/)?.[1];
    assert.ok(source, `Missing README sample: ${heading}`);
    const destination = join(consumer, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, source);
    files.push(destination);
  }

  const options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true,
    skipLibCheck: true, noEmitOnError: true, types: ['node'],
    typeRoots: [join(root, 'node_modules', '@types')], outDir: join(consumer, 'out'),
  };
  const program = ts.createProgram(files, options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n',
  }));
  assert.equal(program.emit().emitSkipped, false);

  // Load definitions only: no cloud/database access and no running colonies.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    for (const env of ['filesystem', 'dolt', 'github']) {
      const { default: config } = await import('./out/' + env + '.js');
      assert.deepEqual(config.colonies.map(c => c.name), ['pinger', 'ponger']);
      assert.ok(config.colonies.every(c => c.environment === config.environment));
    }
  `], { cwd: consumer, stdio: 'inherit' });

  const runner = generateRunnerScript({
    colonyName: 'worker', modulePath: 'worker.ts', exportName: 'configureWorker',
  });
  // Execute the generated runner's imports against the tarball and prove all
  // bundled environments register. Do not launch the actual worker.
  const bootstrap = runner.slice(0, runner.indexOf('const envConfig'));
  execFileSync(process.execPath, ['--input-type=module', '-e', `${bootstrap}
    import assert from 'node:assert/strict';
    for (const config of [
      { type: 'filesystem', name: 'fs', root: ${JSON.stringify(join(temp, 'signals'))} },
      { type: 'github', owner: 'example', repo: 'signals' },
      { type: 'dolt', owner: 'example', database: 'signals' },
    ]) {
      assert.ok(deserializeEnvironment(config));
    }
  `], { cwd: consumer, stdio: 'inherit' });

  const configFile = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(configFile.error, undefined);
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
  const examples = ['colonies.ts', 'index.ts', 'docker.ts'].map(file => join(root, 'examples/code-pipeline', file));
  const exampleProgram = ts.createProgram([...config.fileNames, ...examples], { ...config.options, noEmit: true });
  const exampleDiagnostics = ts.getPreEmitDiagnostics(exampleProgram);
  assert.equal(exampleDiagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(exampleDiagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n',
  }));
  console.log('Generated configs, README samples, packed runner imports, and code-pipeline examples passed.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
