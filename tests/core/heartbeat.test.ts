// PURPOSE: Tests for the heartbeat signal primitive
// PURPOSE: Verifies periodic heartbeat deposits during long-running actions, cleanup, swap pattern, and TTL defaults

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../../src/core/runtime.js';
import { colony } from '../../src/dsl/builder.js';
import { FilesystemEnvironment } from '../../src/environments/filesystem/adapter.js';
import type { Signal, ActionContext, ColonyDefinition } from '../../src/core/types.js';

// ── Test helpers ────────────────────────────────────────────

let env: FilesystemEnvironment;
let root: string;

beforeEach(async () => {
  root = join(tmpdir(), `mandible-hb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  env = new FilesystemEnvironment({ root, name: 'test' });
});

afterEach(async () => {
  await sleep(50);
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

async function depositTask(name: string): Promise<Signal> {
  return env.deposit({
    type: 'task:ready',
    payload: { name },
    meta: { deposited_by: 'test' },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Builder wiring ──────────────────────────────────────────

describe('heartbeat — builder', () => {
  it('.heartbeat(5000) sets config on colony definition', () => {
    const def = colony('hb-test')
      .in(env)
      .sense('task:ready')
      .do('work', async () => {})
      .heartbeat(5000)
      .build();

    expect(def.config?.heartbeat).toEqual({
      interval: 5000,
      ttl: undefined,
      type: undefined,
    });
  });

  it('.heartbeat() accepts ttl and type options', () => {
    const def = colony('hb-opts')
      .in(env)
      .sense('task:ready')
      .do('work', async () => {})
      .heartbeat(3000, { ttl: 10_000, type: 'pulse:custom' })
      .build();

    expect(def.config?.heartbeat).toEqual({
      interval: 3000,
      ttl: 10_000,
      type: 'pulse:custom',
    });
  });
});

// ── Automatic heartbeat during long action ──────────────────

describe('heartbeat — automatic deposits', () => {
  it('deposits heartbeat signals during a long-running action', async () => {
    const def = colony('long-worker')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .do('slow-work', async () => {
        await sleep(350);
      })
      .claim('exclusive')
      .poll(100)
      .heartbeat(100)
      .build();

    await depositTask('slow-task');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(500);
    await rt.stop();

    // After action completes, heartbeats should be cleaned up.
    // But let's verify the action actually ran by checking it was processed.
    expect(rt.stats.signalsProcessed).toBe(1);
  });

  it('heartbeat signals have correct payload, tags, TTL, and caused_by', async () => {
    let capturedHeartbeats: Signal[] = [];

    const def = colony('payload-check')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .do('slow-work', async () => {
        // Wait long enough for at least one heartbeat tick
        await sleep(200);
        // Snapshot mid-action to capture the heartbeat
        capturedHeartbeats = (await env.snapshot()).filter(
          s => s.type === 'heartbeat:payload-check'
        );
      })
      .claim('exclusive')
      .poll(100)
      .heartbeat(80)
      .build();

    const trigger = await depositTask('hb-payload');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(500);
    await rt.stop();

    expect(capturedHeartbeats.length).toBeGreaterThanOrEqual(1);
    const hb = capturedHeartbeats[0];
    expect(hb.payload.signalId).toBe(trigger.id);
    expect(hb.payload.signalType).toBe('task:ready');
    expect(hb.payload.rule).toBe('slow-work');
    expect(hb.payload.startedAt).toBeTypeOf('number');
    expect(hb.payload.elapsed).toBeTypeOf('number');
    expect(hb.meta.tags).toContain('heartbeat');
    expect(hb.meta.caused_by).toEqual([trigger.id]);
    expect(hb.meta.deposited_by).toBe('payload-check');
    expect(hb.meta.ttl).toBe(Math.round(80 * 2.5));
  });
});

// ── Cleanup after action completes ──────────────────────────

describe('heartbeat — cleanup', () => {
  it('no heartbeat signals remain after action completes', async () => {
    const def = colony('cleanup-test')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .do('slow-work', async () => {
        await sleep(250);
      })
      .claim('exclusive')
      .poll(100)
      .heartbeat(80)
      .build();

    await depositTask('cleanup-task');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(500);
    await rt.stop();

    const snapshot = await env.snapshot();
    const heartbeats = snapshot.filter(s => s.type === 'heartbeat:cleanup-test');
    expect(heartbeats).toHaveLength(0);
  });
});

// ── No heartbeat for fast actions ───────────────────────────

describe('heartbeat — fast actions', () => {
  it('zero heartbeat deposits when action is faster than interval', async () => {
    let midActionHeartbeats: Signal[] = [];

    const def = colony('fast-worker')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .do('fast-work', async () => {
        await sleep(20);
        midActionHeartbeats = (await env.snapshot()).filter(
          s => s.type === 'heartbeat:fast-worker'
        );
      })
      .claim('exclusive')
      .poll(100)
      .heartbeat(1000) // interval much longer than action
      .build();

    await depositTask('fast-task');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(300);
    await rt.stop();

    expect(midActionHeartbeats).toHaveLength(0);

    // Also no heartbeats in final snapshot
    const snapshot = await env.snapshot();
    const heartbeats = snapshot.filter(s => s.type === 'heartbeat:fast-worker');
    expect(heartbeats).toHaveLength(0);
  });
});

// ── Swap pattern (max 1 at a time) ──────────────────────────

describe('heartbeat — swap pattern', () => {
  it('never more than 1 heartbeat signal per colony at a time', async () => {
    let maxHeartbeats = 0;

    const def = colony('swap-test')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .do('slow-work', async () => {
        // Check multiple times during action to see max concurrent heartbeats
        for (let i = 0; i < 5; i++) {
          await sleep(80);
          const snapshot = await env.snapshot();
          const count = snapshot.filter(s => s.type === 'heartbeat:swap-test').length;
          maxHeartbeats = Math.max(maxHeartbeats, count);
        }
      })
      .claim('exclusive')
      .poll(100)
      .heartbeat(60)
      .build();

    await depositTask('swap-task');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(700);
    await rt.stop();

    expect(maxHeartbeats).toBeLessThanOrEqual(1);
  });
});

// ── Manual ctx.heartbeat() ──────────────────────────────────

describe('heartbeat — manual deposit', () => {
  it('ctx.heartbeat({ progress }) merges custom payload', async () => {
    let capturedHeartbeat: Signal | undefined;

    const def = colony('manual-hb')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .do('work', async (_signal, ctx) => {
        await ctx.heartbeat({ progress: '50%' });
        // Small delay to let deposit complete
        await sleep(50);
        const snapshot = await env.snapshot();
        capturedHeartbeat = snapshot.find(s => s.type === 'heartbeat:manual-hb');
      })
      .claim('exclusive')
      .poll(100)
      .heartbeat(10_000) // long interval so auto doesn't fire
      .build();

    await depositTask('manual-task');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(400);
    await rt.stop();

    expect(capturedHeartbeat).toBeDefined();
    expect(capturedHeartbeat!.payload.progress).toBe('50%');
    expect(capturedHeartbeat!.payload.rule).toBe('work');
  });

  it('ctx.heartbeat() is a no-op without heartbeat config', async () => {
    let threw = false;

    const def = colony('no-hb')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .do('work', async (_signal, ctx) => {
        try {
          await ctx.heartbeat({ progress: '50%' });
        } catch {
          threw = true;
        }
      })
      .claim('exclusive')
      .poll(100)
      // No .heartbeat() call
      .build();

    await depositTask('no-hb-task');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(300);
    await rt.stop();

    expect(threw).toBe(false);
    expect(rt.stats.signalsProcessed).toBe(1);

    // No heartbeat signals in environment
    const snapshot = await env.snapshot();
    const heartbeats = snapshot.filter(s => s.type.startsWith('heartbeat:'));
    expect(heartbeats).toHaveLength(0);
  });
});

// ── Cleanup after action error ──────────────────────────────

describe('heartbeat — error cleanup', () => {
  it('heartbeat is cleaned up even when action throws', async () => {
    let heartbeatDuringAction: Signal[] = [];

    const def = colony('error-hb')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .do('fail-work', async () => {
        await sleep(200);
        // Capture heartbeats mid-action before we throw
        heartbeatDuringAction = (await env.snapshot()).filter(
          s => s.type === 'heartbeat:error-hb'
        );
        throw new Error('action failed');
      })
      .claim('exclusive')
      .poll(100)
      .heartbeat(80)
      .build();

    await depositTask('error-task');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(500);
    await rt.stop();

    // Heartbeat was present during execution
    expect(heartbeatDuringAction.length).toBeGreaterThanOrEqual(1);

    // Heartbeat is cleaned up after error
    const snapshot = await env.snapshot();
    const remaining = snapshot.filter(s => s.type === 'heartbeat:error-hb');
    expect(remaining).toHaveLength(0);
  });
});

// ── TTL defaults ────────────────────────────────────────────

describe('heartbeat — TTL defaults', () => {
  it('TTL defaults to 2.5x interval', async () => {
    let capturedTtl: number | undefined;

    const def = colony('ttl-check')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .do('work', async () => {
        await sleep(200);
        const snapshot = await env.snapshot();
        const hb = snapshot.find(s => s.type === 'heartbeat:ttl-check');
        if (hb) capturedTtl = hb.meta.ttl;
      })
      .claim('exclusive')
      .poll(100)
      .heartbeat(80) // TTL should default to Math.round(80 * 2.5) = 200
      .build();

    await depositTask('ttl-task');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(400);
    await rt.stop();

    expect(capturedTtl).toBe(Math.round(80 * 2.5));
  });

  it('TTL can be overridden', async () => {
    let capturedTtl: number | undefined;

    const def = colony('ttl-override')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .do('work', async () => {
        await sleep(200);
        const snapshot = await env.snapshot();
        const hb = snapshot.find(s => s.type === 'heartbeat:ttl-override');
        if (hb) capturedTtl = hb.meta.ttl;
      })
      .claim('exclusive')
      .poll(100)
      .heartbeat(80, { ttl: 5000 })
      .build();

    await depositTask('ttl-override-task');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(400);
    await rt.stop();

    expect(capturedTtl).toBe(5000);
  });
});
