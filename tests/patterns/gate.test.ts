// PURPOSE: Tests for the concentration gate pattern
// PURPOSE: Uses a real FilesystemEnvironment to verify gating behavior

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FilesystemEnvironment } from '../../src/environments/filesystem/adapter.js';
import { createGate } from '../../src/patterns/gate.js';
import type { Signal } from '../../src/core/types.js';

let env: FilesystemEnvironment;
let root: string;

beforeEach(async () => {
  root = join(tmpdir(), `mandible-gate-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  env = new FilesystemEnvironment({ root, name: 'gate-test' });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ── Gate basics ─────────────────────────────────────────────

describe('createGate', () => {
  it('deposits a gated signal at concentration 0', async () => {
    const gate = createGate({ environment: env, pollInterval: 50 });

    const gated = await gate.deposit({
      type: 'phase:review',
      payload: { batch: 'sprint-1' },
      preconditions: ['sig_nonexistent'],
    });

    expect(gated.meta.concentration).toBe(0);
    expect(gated.meta.tags).toContain('gated');
    expect(gate.stats.pending).toBe(1);
  });

  it('gated signals are invisible to normal queries (minConcentration)', async () => {
    const gate = createGate({ environment: env, pollInterval: 50 });

    await gate.deposit({
      type: 'phase:review',
      payload: {},
      preconditions: ['sig_nonexistent'],
    });

    // Normal colony sensor would use minConcentration
    const visible = await env.observe({ type: 'phase:review', minConcentration: 0.1 });
    expect(visible).toHaveLength(0);

    // But discoverable for debugging
    const all = await env.observe({ type: 'phase:review' });
    expect(all).toHaveLength(1);
    expect(all[0].meta.concentration).toBe(0);
  });

  it('activates signal when precondition exists', async () => {
    const gate = createGate({ environment: env, pollInterval: 50 });
    await gate.start();

    // Deposit the precondition signal
    const precond = await env.deposit({
      type: 'artifact:shaped',
      payload: { task: 'auth' },
      meta: { deposited_by: 'shaper' },
    });

    // Deposit a gated signal waiting on that precondition
    await gate.deposit({
      type: 'phase:review',
      payload: { batch: 'sprint-1' },
      preconditions: [precond.id],
    });

    // Wait for gate to check
    await new Promise(r => setTimeout(r, 150));

    // The gated signal should have been activated (withdrawn + re-deposited)
    const active = await env.observe({ type: 'phase:review', minConcentration: 0.1 });
    expect(active).toHaveLength(1);
    expect(active[0].meta.concentration).toBe(1.0);
    expect(active[0].meta.caused_by).toContain(precond.id);

    expect(gate.stats.activated).toBe(1);
    expect(gate.stats.pending).toBe(0);

    await gate.stop();
  });

  it('waits for ALL preconditions before activating', async () => {
    const gate = createGate({ environment: env, pollInterval: 50 });
    await gate.start();

    const precondA = await env.deposit({
      type: 'artifact:shaped',
      payload: { task: 'a' },
      meta: { deposited_by: 'shaper' },
    });

    // Gate needs both A and B
    await gate.deposit({
      type: 'phase:review',
      payload: {},
      preconditions: [precondA.id, 'sig_not_yet'],
    });

    // Wait — should NOT activate (only 1 of 2 preconditions met)
    await new Promise(r => setTimeout(r, 150));
    expect(gate.stats.activated).toBe(0);

    // Now deposit the second precondition
    const precondB = await env.deposit({
      type: 'artifact:shaped',
      payload: { task: 'b' },
      meta: { deposited_by: 'shaper' },
    });

    // Update the pending gate's precondition to use real ID
    // (In real usage, you'd know the IDs upfront or use barriers for dynamic fan-in)
    await gate.stop();

    // Re-create gate with correct preconditions
    const gate2 = createGate({ environment: env, pollInterval: 50 });
    await gate2.deposit({
      type: 'phase:review-2',
      payload: {},
      preconditions: [precondA.id, precondB.id],
    });
    await gate2.start();

    await new Promise(r => setTimeout(r, 150));
    expect(gate2.stats.activated).toBe(1);

    await gate2.stop();
  });

  it('supports withdrawn precondition mode', async () => {
    const gate = createGate({ environment: env, pollInterval: 50 });
    await gate.start();

    const taskSignal = await env.deposit({
      type: 'task:ready',
      payload: { name: 'auth' },
      meta: { deposited_by: 'seed' },
    });

    // Gate waits for task to be withdrawn (completed)
    await gate.deposit({
      type: 'phase:post-processing',
      payload: {},
      preconditions: [taskSignal.id],
      preconditionMode: 'withdrawn',
    });

    // Should NOT activate — task still exists
    await new Promise(r => setTimeout(r, 150));
    expect(gate.stats.activated).toBe(0);

    // Withdraw the task (simulating completion)
    await env.withdraw(taskSignal.id);

    // Now should activate
    await new Promise(r => setTimeout(r, 150));
    expect(gate.stats.activated).toBe(1);

    await gate.stop();
  });

  it('preserves original lineage in activated signal', async () => {
    const gate = createGate({ environment: env, pollInterval: 50 });
    await gate.start();

    const parent = await env.deposit({
      type: 'task:ready',
      payload: {},
      meta: { deposited_by: 'seed' },
    });

    const gated = await gate.deposit({
      type: 'phase:review',
      payload: {},
      preconditions: [parent.id],
      meta: { caused_by: ['sig_original_parent'] },
    });

    await new Promise(r => setTimeout(r, 150));

    const activated = await env.observe({ type: 'phase:review', minConcentration: 0.1 });
    expect(activated).toHaveLength(1);

    // Should include: gated signal ID, original caused_by, and precondition IDs
    expect(activated[0].meta.caused_by).toContain(gated.id);
    expect(activated[0].meta.caused_by).toContain('sig_original_parent');
    expect(activated[0].meta.caused_by).toContain(parent.id);

    await gate.stop();
  });

  it('custom activation concentration', async () => {
    const gate = createGate({ environment: env, pollInterval: 50 });
    await gate.start();

    const precond = await env.deposit({
      type: 'evidence:done',
      payload: {},
      meta: { deposited_by: 'worker' },
    });

    await gate.deposit({
      type: 'phase:next',
      payload: {},
      preconditions: [precond.id],
      activationConcentration: 0.7,
    });

    await new Promise(r => setTimeout(r, 150));

    const active = await env.observe({ type: 'phase:next', minConcentration: 0.1 });
    expect(active).toHaveLength(1);
    expect(active[0].meta.concentration).toBe(0.7);

    await gate.stop();
  });

  it('start/stop lifecycle', async () => {
    const gate = createGate({ environment: env, pollInterval: 50 });

    expect(gate.running).toBe(false);
    await gate.start();
    expect(gate.running).toBe(true);
    await gate.stop();
    expect(gate.running).toBe(false);
  });

  it('stats track correctly', async () => {
    const gate = createGate({ environment: env, pollInterval: 50 });

    expect(gate.stats.pending).toBe(0);
    expect(gate.stats.activated).toBe(0);

    const precond = await env.deposit({
      type: 'x',
      payload: {},
      meta: { deposited_by: 'test' },
    });

    await gate.deposit({
      type: 'y',
      payload: {},
      preconditions: [precond.id],
    });

    expect(gate.stats.pending).toBe(1);

    await gate.start();
    await new Promise(r => setTimeout(r, 150));

    expect(gate.stats.activated).toBe(1);
    expect(gate.stats.pending).toBe(0);

    await gate.stop();
  });
});
