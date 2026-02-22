import { describe, it, expect } from 'vitest';
import { mandible, MandibleBuilder } from '../../src/dsl/mandible.js';
import { FilesystemEnvironment } from '../../src/environments/filesystem/index.js';
import { isHost } from '../../src/core/types.js';
import { LocalHost } from '../../src/hosts/local.js';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Signal, ActionContext } from '../../src/core/types.js';
import type { ColonyModuleRef } from '../../src/cloud/types.js';

let testN = 0;
function freshRoot() { return resolve(`/tmp/mandible-dsl-test-${process.pid}-${++testN}`); }

describe('mandible DSL', () => {
  it('builds colony definitions from fluent API', async () => {
    const root = freshRoot();
    await mkdir(root, { recursive: true });
    const env = new FilesystemEnvironment({ root, name: 'test' });

    const defs = await mandible('test')
      .environment(env)
      .colony('worker-a', c => c
        .sense('task:new', { unclaimed: true })
        .do('process', async (_signal: Signal, ctx: ActionContext) => {
          await ctx.withdraw(_signal.id);
        })
        .concurrency(3)
      )
      .colony('worker-b', c => c
        .sense('task:done')
        .do('archive', async (_signal: Signal, ctx: ActionContext) => {
          await ctx.withdraw(_signal.id);
        })
      )
      .build();

    expect(defs).toHaveLength(2);
    expect(defs[0].name).toBe('worker-a');
    expect(defs[0].concurrency).toBe(3);
    expect(defs[0].sensors[0].query.type).toBe('task:new');
    expect(defs[1].name).toBe('worker-b');
    expect(defs[1].sensors[0].query.type).toBe('task:done');
  });

  it('build() accepts env override', async () => {
    const root = freshRoot();
    await mkdir(root, { recursive: true });
    const env = new FilesystemEnvironment({ root, name: 'override' });

    const defs = await mandible('override-test')
      .colony('w', c => c
        .sense('x:y')
        .do('action', async () => {})
      )
      .build(env);

    expect(defs).toHaveLength(1);
    expect(defs[0].environment).toBe(env);
  });

  it('throws when building without environment', async () => {
    await expect(
      mandible('no-env')
        .colony('w', c => c.sense('x:y').do('a', async () => {}))
        .build()
    ).rejects.toThrow('requires an environment');
  });

  it('throws when starting without environment', async () => {
    await expect(
      mandible('no-env')
        .colony('w', c => c.sense('x:y').do('a', async () => {}))
        .start()
    ).rejects.toThrow('requires an environment');
  });

  it('LocalHost is a valid Host', () => {
    const host = new LocalHost();
    expect(isHost(host)).toBe(true);
  });

  it('start() returns the host with metadata', async () => {
    const root = freshRoot();
    await mkdir(root, { recursive: true });
    const env = new FilesystemEnvironment({ root, name: 'start-test' });

    const host = await mandible('start-test')
      .environment(env)
      .colony('w', c => c
        .sense('task:new')
        .do('process', async () => {})
      )
      .start();

    expect(isHost(host)).toBe(true);
    expect(host.colonies).toHaveLength(1);
    expect(host.colonies[0].name).toBe('w');
    expect(host.colonies[0].state).toBe('running');
    expect(host.environments).toContain(env);
    expect(typeof host.dashboard).toBe('function');

    // Metadata populated after start
    expect(host.metadata.id).toBeTruthy();
    expect(host.metadata.startedAt).toBeInstanceOf(Date);
    expect(host.metadata.startedAt.getTime()).toBeGreaterThan(0);

    await host.stop();
  });

  it('supports multiple colonies with different configs', async () => {
    const root = freshRoot();
    await mkdir(root, { recursive: true });
    const env = new FilesystemEnvironment({ root, name: 'multi' });

    const defs = await mandible('multi-colony')
      .environment(env)
      .colony('fast', c => c
        .sense('task:quick')
        .do('run', async () => {})
        .concurrency(5)
        .claim('none')
        .poll(500)
      )
      .colony('slow', c => c
        .sense('task:heavy')
        .do('run', async () => {})
        .concurrency(1)
        .claim('exclusive')
        .timeout(60_000)
      )
      .build();

    expect(defs).toHaveLength(2);
    expect(defs[0].concurrency).toBe(5);
    expect(defs[0].claimStrategy).toBe('none');
    expect(defs[1].concurrency).toBe(1);
    expect(defs[1].claimStrategy).toBe('exclusive');
  });

  describe('module refs', () => {
    it('accepts a ColonyModuleRef and resolves it via dynamic import', async () => {
      const root = freshRoot();
      await mkdir(root, { recursive: true });
      const env = new FilesystemEnvironment({ root, name: 'modref' });

      const moduleRef: ColonyModuleRef = {
        module: resolve(__dirname, 'fixtures/test-configurator.ts'),
        export: 'configureTestColony',
        args: ['hello'],
      };

      const defs = await mandible('modref-test')
        .environment(env)
        .colony('test-colony', moduleRef)
        .build();

      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe('test-colony');
      expect(defs[0].concurrency).toBe(2);
      expect(defs[0].sensors[0].query.type).toBe('test:signal');
      expect(defs[0].rules[0].name).toBe('test-action');
    });

    it('can mix closures and module refs', async () => {
      const root = freshRoot();
      await mkdir(root, { recursive: true });
      const env = new FilesystemEnvironment({ root, name: 'mixed' });

      const moduleRef: ColonyModuleRef = {
        module: resolve(__dirname, 'fixtures/test-configurator.ts'),
        export: 'configureTestColony',
        args: ['world'],
      };

      const defs = await mandible('mixed-test')
        .environment(env)
        .colony('closure-colony', c => c
          .sense('task:new')
          .do('work', async () => {})
        )
        .colony('modref-colony', moduleRef)
        .build();

      expect(defs).toHaveLength(2);
      expect(defs[0].name).toBe('closure-colony');
      expect(defs[1].name).toBe('modref-colony');
      expect(defs[1].concurrency).toBe(2);
    });

    it('throws when module export does not exist', async () => {
      const root = freshRoot();
      await mkdir(root, { recursive: true });
      const env = new FilesystemEnvironment({ root, name: 'bad-export' });

      const moduleRef: ColonyModuleRef = {
        module: resolve(__dirname, 'fixtures/test-configurator.ts'),
        export: 'nonExistentFunction',
        args: [],
      };

      await expect(
        mandible('bad-export')
          .environment(env)
          .colony('bad', moduleRef)
          .build()
      ).rejects.toThrow('does not export a function named "nonExistentFunction"');
    });

    it('exposes colonyEntries for CloudHost', () => {
      const moduleRef: ColonyModuleRef = {
        module: './scout.js',
        export: 'configureScout',
        args: ['/tmp/repo'],
      };

      const builder = mandible('entries-test')
        .colony('closure', c => c.sense('x:y').do('a', async () => {}))
        .colony('modref', moduleRef);

      const entries = builder.colonyEntries;
      expect(entries).toHaveLength(2);
      expect(entries[0].name).toBe('closure');
      expect(entries[0].configurator).toBeDefined();
      expect(entries[0].moduleRef).toBeUndefined();
      expect(entries[1].name).toBe('modref');
      expect(entries[1].configurator).toBeUndefined();
      expect(entries[1].moduleRef).toEqual(moduleRef);
    });
  });
});
