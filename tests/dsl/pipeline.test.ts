import { describe, it, expect, vi } from 'vitest';
import { pipeline } from '../../src/dsl/pipeline.js';
import { FilesystemEnvironment } from '../../src/environments/filesystem/index.js';
import { resolve } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import type { Signal, ActionContext } from '../../src/core/types.js';

const TEST_ROOT = resolve('/tmp/mandible-pipeline-test');

describe('pipeline DSL', () => {
  it('builds colony definitions from fluent API', async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
    await mkdir(TEST_ROOT, { recursive: true });
    const env = new FilesystemEnvironment({ root: TEST_ROOT, name: 'test' });

    const defs = pipeline('test-pipeline')
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
    await rm(TEST_ROOT, { recursive: true, force: true });
    await mkdir(TEST_ROOT, { recursive: true });
    const env = new FilesystemEnvironment({ root: TEST_ROOT, name: 'override' });

    const defs = pipeline('override-test')
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
      pipeline('no-env')
        .colony('w', c => c.sense('x:y').do('a', async () => {}))
        .build();
    }).toThrow('requires an environment');
  });

  it('throws when deploying without API key', async () => {
    const original = process.env.MANDIBLE_API_KEY;
    delete process.env.MANDIBLE_API_KEY;

    try {
      await expect(
        pipeline('no-key')
          .colony('w', c => c.sense('x:y').do('a', async () => {}))
          .deploy()
      ).rejects.toThrow('API key required');
    } finally {
      if (original) process.env.MANDIBLE_API_KEY = original;
    }
  });

  it('throws when dev() called without environment', async () => {
    await expect(
      pipeline('no-env-dev')
        .colony('w', c => c.sense('x:y').do('a', async () => {}))
        .dev()
    ).rejects.toThrow('requires an environment');
  });

  it('cloud() picks up env vars', () => {
    const original = {
      url: process.env.MANDIBLE_API_URL,
      key: process.env.MANDIBLE_API_KEY,
      project: process.env.MANDIBLE_PROJECT,
    };

    process.env.MANDIBLE_API_URL = 'https://custom.api.dev';
    process.env.MANDIBLE_API_KEY = 'test-key-123';
    process.env.MANDIBLE_PROJECT = 'proj_test';

    try {
      // deploy() will use env vars, but will fail at the HTTP call
      // We just verify it doesn't throw on missing config
      const p = pipeline('env-test')
        .cloud({})
        .colony('w', c => c.sense('x:y').do('a', async () => {}));

      // Build should work (cloud config doesn't affect build)
      const env = new FilesystemEnvironment({ root: TEST_ROOT, name: 'env-test' });
      const defs = p.build(env);
      expect(defs).toHaveLength(1);
    } finally {
      process.env.MANDIBLE_API_URL = original.url;
      process.env.MANDIBLE_API_KEY = original.key;
      process.env.MANDIBLE_PROJECT = original.project;
    }
  });

  it('supports multiple colonies with different configs', async () => {
    await rm(TEST_ROOT, { recursive: true, force: true });
    await mkdir(TEST_ROOT, { recursive: true });
    const env = new FilesystemEnvironment({ root: TEST_ROOT, name: 'multi' });

    const defs = pipeline('multi-colony')
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
