// PURPOSE: Tests for the barrier signal pattern
// PURPOSE: Uses a real FilesystemEnvironment to verify fan-in convergence

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FilesystemEnvironment } from '../../src/environments/filesystem/adapter.js';
import { createBarrier } from '../../src/patterns/barrier.js';
import type { Signal } from '../../src/core/types.js';

let env: FilesystemEnvironment;
let root: string;

beforeEach(async () => {
  root = join(tmpdir(), `mandible-barrier-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  env = new FilesystemEnvironment({ root, name: 'barrier-test' });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ── Barrier basics ──────────────────────────────────────────

describe('createBarrier', () => {
  it('fires when threshold is reached', async () => {
    const barrier = createBarrier({
      environment: env,
      name: 'review-quorum',
      trigger: 'review:approved',
      threshold: 2,
      then: {
        type: 'phase:merge-ready',
        payload: { ready: true },
      },
      pollInterval: 50,
    });

    await barrier.start();

    // Deposit trigger signals
    await env.deposit({
      type: 'review:approved',
      payload: { reviewer: 'alice' },
      meta: { deposited_by: 'critic-1' },
    });

    // Wait — not enough yet
    await new Promise(r => setTimeout(r, 150));
    expect(barrier.stats.fired).toBe(0);
    expect(barrier.stats.accumulated).toBe(1);

    await env.deposit({
      type: 'review:approved',
      payload: { reviewer: 'bob' },
      meta: { deposited_by: 'critic-2' },
    });

    // Wait for barrier to check
    await new Promise(r => setTimeout(r, 150));

    expect(barrier.stats.fired).toBe(1);

    // Check downstream signal was deposited
    const downstream = await env.observe({ type: 'phase:merge-ready' });
    expect(downstream).toHaveLength(1);
    expect(downstream[0].payload).toEqual({ ready: true });
    expect(downstream[0].meta.deposited_by).toBe('barrier:review-quorum');
    expect(downstream[0].meta.caused_by).toHaveLength(2);

    await barrier.stop();
  });

  it('supports dynamic payload from accumulated signals', async () => {
    const barrier = createBarrier({
      environment: env,
      name: 'gather-results',
      trigger: 'result:ready',
      threshold: 2,
      then: {
        type: 'batch:complete',
        payload: (signals) => ({
          count: signals.length,
          ids: signals.map(s => s.id),
        }),
      },
      pollInterval: 50,
    });

    await barrier.start();

    const s1 = await env.deposit({
      type: 'result:ready',
      payload: { value: 1 },
      meta: { deposited_by: 'worker-1' },
    });
    const s2 = await env.deposit({
      type: 'result:ready',
      payload: { value: 2 },
      meta: { deposited_by: 'worker-2' },
    });

    await new Promise(r => setTimeout(r, 150));

    const batch = await env.observe({ type: 'batch:complete' });
    expect(batch).toHaveLength(1);
    expect(batch[0].payload.count).toBe(2);
    expect(batch[0].payload.ids).toContain(s1.id);
    expect(batch[0].payload.ids).toContain(s2.id);

    await barrier.stop();
  });

  it('one-shot barrier stops after firing', async () => {
    const barrier = createBarrier({
      environment: env,
      name: 'one-shot',
      trigger: 'ping',
      threshold: 1,
      then: { type: 'pong', payload: {} },
      repeatable: false,
      pollInterval: 50,
    });

    await barrier.start();

    await env.deposit({
      type: 'ping',
      payload: {},
      meta: { deposited_by: 'test' },
    });

    await new Promise(r => setTimeout(r, 150));

    expect(barrier.stats.fired).toBe(1);
    expect(barrier.running).toBe(false); // auto-stopped
  });

  it('repeatable barrier resets after firing', async () => {
    const barrier = createBarrier({
      environment: env,
      name: 'repeatable',
      trigger: 'tick',
      threshold: 1,
      then: { type: 'tock', payload: {} },
      repeatable: true,
      pollInterval: 50,
      withdrawTriggers: true,
    });

    await barrier.start();

    // First trigger
    await env.deposit({
      type: 'tick',
      payload: {},
      meta: { deposited_by: 'clock' },
    });

    await new Promise(r => setTimeout(r, 150));
    expect(barrier.stats.fired).toBe(1);
    expect(barrier.running).toBe(true); // still running

    // Second trigger
    await env.deposit({
      type: 'tick',
      payload: {},
      meta: { deposited_by: 'clock' },
    });

    await new Promise(r => setTimeout(r, 150));
    expect(barrier.stats.fired).toBe(2);

    await barrier.stop();
  });

  it('withdraws trigger signals when configured', async () => {
    const barrier = createBarrier({
      environment: env,
      name: 'withdraw-test',
      trigger: 'evidence',
      threshold: 1,
      then: { type: 'verdict', payload: {} },
      withdrawTriggers: true,
      pollInterval: 50,
    });

    await barrier.start();

    const trigger = await env.deposit({
      type: 'evidence',
      payload: {},
      meta: { deposited_by: 'witness' },
    });

    await new Promise(r => setTimeout(r, 150));

    // Trigger signal should have been withdrawn
    const remaining = await env.observe({ type: 'evidence' });
    expect(remaining).toHaveLength(0);

    // But downstream was deposited
    const downstream = await env.observe({ type: 'verdict' });
    expect(downstream).toHaveLength(1);

    await barrier.stop();
  });

  it('fires timeout signal when TTL expires', async () => {
    const barrier = createBarrier({
      environment: env,
      name: 'timeout-test',
      trigger: 'slow:result',
      threshold: 3,
      then: { type: 'success', payload: {} },
      ttl: 100, // 100ms TTL
      onTimeout: {
        type: 'timeout:escalation',
        payload: (signals) => ({
          received: signals.length,
          needed: 3,
        }),
      },
      pollInterval: 50,
    });

    await barrier.start();

    // Only deposit 1 of 3 needed
    await env.deposit({
      type: 'slow:result',
      payload: {},
      meta: { deposited_by: 'worker' },
    });

    // Wait for TTL to expire
    await new Promise(r => setTimeout(r, 250));

    expect(barrier.stats.expired).toBe(1);
    expect(barrier.stats.fired).toBe(0);

    // Timeout signal should exist
    const timeout = await env.observe({ type: 'timeout:escalation' });
    expect(timeout).toHaveLength(1);
    expect(timeout[0].payload.received).toBe(1);
    expect(timeout[0].payload.needed).toBe(3);

    await barrier.stop();
  });

  it('uses SignalQuery for complex trigger matching', async () => {
    const barrier = createBarrier({
      environment: env,
      name: 'query-test',
      trigger: {
        type: 'review:*',
        tags: ['approved'],
      },
      threshold: 2,
      then: { type: 'all-approved', payload: {} },
      pollInterval: 50,
    });

    await barrier.start();

    // This shouldn't match (wrong tag)
    await env.deposit({
      type: 'review:done',
      payload: {},
      meta: { deposited_by: 'critic', tags: ['rejected'] },
    });

    // These should match
    await env.deposit({
      type: 'review:complete',
      payload: {},
      meta: { deposited_by: 'critic-1', tags: ['approved'] },
    });
    await env.deposit({
      type: 'review:final',
      payload: {},
      meta: { deposited_by: 'critic-2', tags: ['approved'] },
    });

    await new Promise(r => setTimeout(r, 150));

    expect(barrier.stats.fired).toBe(1);

    await barrier.stop();
  });

  it('exposes accumulated signals', async () => {
    const barrier = createBarrier({
      environment: env,
      name: 'accumulate-test',
      trigger: 'item',
      threshold: 3,
      then: { type: 'batch', payload: {} },
      pollInterval: 50,
    });

    await barrier.start();

    await env.deposit({ type: 'item', payload: { n: 1 }, meta: { deposited_by: 'test' } });
    await env.deposit({ type: 'item', payload: { n: 2 }, meta: { deposited_by: 'test' } });

    await new Promise(r => setTimeout(r, 150));

    expect(barrier.accumulated).toHaveLength(2);
    expect(barrier.accumulated[0].payload.n).toBe(1);

    await barrier.stop();
  });

  it('start/stop lifecycle', async () => {
    const barrier = createBarrier({
      environment: env,
      name: 'lifecycle',
      trigger: 'x',
      threshold: 1,
      then: { type: 'y', payload: {} },
      pollInterval: 50,
    });

    expect(barrier.running).toBe(false);
    await barrier.start();
    expect(barrier.running).toBe(true);
    await barrier.stop();
    expect(barrier.running).toBe(false);
  });

  it('does not double-count the same signal', async () => {
    const barrier = createBarrier({
      environment: env,
      name: 'dedup-test',
      trigger: 'item',
      threshold: 2,
      then: { type: 'done', payload: {} },
      pollInterval: 50,
    });

    await barrier.start();

    // Deposit just 1 signal
    await env.deposit({ type: 'item', payload: {}, meta: { deposited_by: 'test' } });

    // Wait multiple poll cycles
    await new Promise(r => setTimeout(r, 200));

    // Should not fire — only 1 unique signal
    expect(barrier.stats.fired).toBe(0);
    expect(barrier.stats.accumulated).toBe(1);

    await barrier.stop();
  });

  it('fires immediately if signals already exist', async () => {
    // Deposit before creating barrier
    await env.deposit({ type: 'pre-existing', payload: {}, meta: { deposited_by: 'test' } });
    await env.deposit({ type: 'pre-existing', payload: {}, meta: { deposited_by: 'test' } });

    const barrier = createBarrier({
      environment: env,
      name: 'pre-existing',
      trigger: 'pre-existing',
      threshold: 2,
      then: { type: 'caught-up', payload: {} },
      pollInterval: 50,
    });

    await barrier.start();
    await new Promise(r => setTimeout(r, 100));

    expect(barrier.stats.fired).toBe(1);

    await barrier.stop();
  });
});
