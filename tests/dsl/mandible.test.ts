import { describe, it, expect } from 'vitest';
import { mandible } from '../../src/dsl/mandible.js';
import { FilesystemEnvironment } from '../../src/environments/filesystem/index.js';
import { isHost } from '../../src/core/types.js';
import { LocalHost } from '../../src/hosts/local.js';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Signal, ActionContext } from '../../src/core/types.js';

let testN = 0;
function freshRoot() { return resolve(`/tmp/mandible-dsl-test-${process.pid}-${++testN}`); }

describe('mandible DSL', () => {
  it('builds colony definitions from fluent API', async () => {
    const root = freshRoot();
    await mkdir(root, { recursive: true });
    const env = new FilesystemEnvironment({ root, name: 'test' });

    const defs = mandible('test')
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

    const defs = mandible('override-test')
      .colony('w', c => c
        .sense('x:y')
        .do('action', async () => {})
      )
      .build(env);

    expect(defs).toHaveLength(1);
    expect(defs[0].environment).toBe(env);
  });

  it('throws when building without environment', () => {
    expect(() => {
      mandible('no-env')
        .colony('w', c => c.sense('x:y').do('a', async () => {}))
        .build();
    }).toThrow('requires an environment');
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

    const defs = mandible('multi-colony')
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
});
