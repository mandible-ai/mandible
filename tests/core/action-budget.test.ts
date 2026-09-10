// PURPOSE: An action that never finishes must not hold its concurrency slot
// for the life of the process — a colony whose slots are all held stops
// sensing and says nothing, which is indistinguishable from healthy.
// PURPOSE: Also covers the claim lease reaching the runtime at all.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../../src/core/runtime.js';
import { colony } from '../../src/dsl/builder.js';
import { FilesystemEnvironment } from '../../src/environments/filesystem/adapter.js';

let env: FilesystemEnvironment;
let root: string;

beforeEach(() => {
  root = join(tmpdir(), `mandible-budget-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  env = new FilesystemEnvironment({ root, name: 'test' });
});

afterEach(async () => {
  await sleep(30);
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('the claim lease is a real number', () => {
  it('reaches the definition instead of being dropped by the builder', () => {
    const built = colony('worker')
      .in(env)
      .sense('task:ready')
      .do('work', async () => {})
      .claim('lease', 600_000)
      .build();

    expect(built.claimLease).toBe(600_000);
  });

  it('is what the environment is asked to hold, not a hardcoded minute', async () => {
    const held: number[] = [];
    const spy = Object.create(env) as FilesystemEnvironment;
    spy.claim = async (id: string, by: string, lease: number) => {
      held.push(lease);
      return env.claim(id, by, lease);
    };

    const runtime = createRuntime(
      colony('worker').in(spy).sense('task:ready').do('work', async () => {})
        .claim('lease', 45_000).poll(20).build(),
    );
    await env.deposit({ type: 'task:ready', payload: {}, meta: { deposited_by: 'test' } });
    await runtime.start();
    await sleep(120);
    await runtime.stop();

    expect(held[0]).toBe(45_000);
  });
});

describe('an action is always bounded', () => {
  it('gives up on one that never finishes, bounded by the claim lease', async () => {
    const errors: string[] = [];
    const runtime = createRuntime(
      colony('worker')
        .in(env)
        .sense('task:ready')
        // Never resolves: the shape of a request on a connection that died
        // without closing, which is what wedged a colony in production.
        .do('work', () => new Promise<void>(() => {}))
        .claim('lease', 120)
        .concurrency(1)
        .poll(20)
        .build(),
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(m => { errors.push(String(m)); });

    await env.deposit({ type: 'task:ready', payload: {}, meta: { deposited_by: 'test' } });
    await runtime.start();
    await sleep(500);
    await runtime.stop();
    spy.mockRestore();

    // Without a ceiling this never returns and the slot is gone for good.
    expect(errors.some(e => e.includes('timed out after 120ms'))).toBe(true);
  });

  it('honours an explicit timeout over the lease', async () => {
    const started = Date.now();
    const runtime = createRuntime(
      colony('worker')
        .in(env)
        .sense('task:ready')
        .do('work', () => new Promise<void>(() => {}))
        .claim('lease', 60_000)
        .timeout(120)
        .concurrency(1)
        .poll(20)
        .build(),
    );
    await env.deposit({ type: 'task:ready', payload: {}, meta: { deposited_by: 'test' } });
    await runtime.start();
    await sleep(400);
    await runtime.stop();

    expect(runtime.activeCount).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('a starved colony says so', () => {
  it('warns, naming what is holding the slots', async () => {
    const warnings: string[] = [];
    const runtime = createRuntime(
      colony('worker')
        .in(env)
        .sense('task:ready')
        // Slow, not stuck: the colony is saturated rather than wedged.
        .do('work', () => sleep(800))
        .timeout(10_000)
        .concurrency(1)
        .poll(20)
        .build(),
    );
    const spy = vi.spyOn(console, 'warn').mockImplementation(m => { warnings.push(String(m)); });

    await env.deposit({ type: 'task:ready', payload: {}, meta: { deposited_by: 'test' } });
    await runtime.start();
    await sleep(400);
    await runtime.stop();
    spy.mockRestore();

    const starved = warnings.find(w => w.includes('at capacity'));
    expect(starved, `no starvation warning in: ${JSON.stringify(warnings)}`).toBeTruthy();
    expect(starved).toContain('not sensing');
  });
});
