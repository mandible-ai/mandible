// PURPOSE: A relative module ref is relative to where the deploy runs, not to
// the installed framework. Getting this wrong made every documented colony
// example fail to resolve.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mandible } from '../../src/dsl/mandible.js';
import { FilesystemEnvironment } from '../../src/environments/filesystem/adapter.js';

let root: string;
let cwd: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mandible-moduleref-'));
  cwd = process.cwd();
  // The deploy is run from the user's project, which is not this repository.
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(cwd);
  await rm(root, { recursive: true, force: true });
});

/** A colony module written where a user would actually put one. */
async function writeColony(file: string): Promise<void> {
  await writeFile(
    join(root, file),
    `export function configureWorker() {
       return (c) => c.sense('task:ready').do('process', async () => {});
     }`,
  );
}

describe('module refs resolve from the working directory', () => {
  it('finds a colony next to the deploy that references it', async () => {
    await writeColony('worker.mjs');

    const host = await mandible('demo')
      .environment(new FilesystemEnvironment({ root: join(root, 'signals'), name: 'test' }))
      // Exactly what the getting-started guide tells people to write. This used
      // to resolve inside node_modules/@mandible-ai/mandible/dist/src/dsl.
      .colony('worker', { module: './worker.mjs', export: 'configureWorker' })
      .start();

    expect(host.colonies.map(c => c.name)).toContain('worker');
    await host.stop();
  });

  it('accepts an absolute path too', async () => {
    await writeColony('elsewhere.mjs');

    const host = await mandible('demo')
      .environment(new FilesystemEnvironment({ root: join(root, 'signals'), name: 'test' }))
      .colony('worker', { module: join(root, 'elsewhere.mjs'), export: 'configureWorker' })
      .start();

    expect(host.colonies.map(c => c.name)).toContain('worker');
    await host.stop();
  });

  it('says which export it wanted when the module has no such function', async () => {
    await writeColony('worker.mjs');

    await expect(
      mandible('demo')
        .environment(new FilesystemEnvironment({ root: join(root, 'signals'), name: 'test' }))
        .colony('worker', { module: './worker.mjs', export: 'configureMissing' })
        .start(),
    ).rejects.toThrow(/configureMissing/);
  });
});

// A colony declares the access its work requires — secrets, and the models it
// will spend on — so a host can issue a credential scoped to that and no more.
describe('a colony declares the models it needs', () => {
  it('keeps the declaration on the entry, next to the secrets one', () => {
    const app = mandible('scoped')
      .colony('implementer', {
        module: './implementer.ts',
        export: 'configureImplementer',
        secrets: ['GITHUB_TOKEN'],
        models: ['claude-opus-5'],
      });

    const entry = app.colonyEntries[0];
    expect(entry.moduleRef?.models).toEqual(['claude-opus-5']);
    expect(entry.moduleRef?.secrets).toEqual(['GITHUB_TOKEN']);
  });

  it('is absent when the colony asks for nothing in particular', () => {
    const app = mandible('open')
      .colony('reviewer', { module: './c.ts', export: 'configureReviewer' });

    expect(app.colonyEntries[0].moduleRef?.models).toBeUndefined();
  });
});
