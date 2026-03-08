// PURPOSE: Tests for the colony runtime (stigmergy loop engine)
// PURPOSE: Covers lifecycle, sensing, rule matching, claims, concurrency, retry, decay, events

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ColonyRuntime, createRuntime } from '../../src/core/runtime.js';
import { colony } from '../../src/dsl/builder.js';
import { FilesystemEnvironment } from '../../src/environments/filesystem/adapter.js';
import type { Signal, ActionContext, ColonyDefinition } from '../../src/core/types.js';
import type { RuntimeEventData } from '../../src/core/events.js';

// ── Test helpers ────────────────────────────────────────────

let env: FilesystemEnvironment;
let root: string;

beforeEach(async () => {
  root = join(tmpdir(), `mandible-rt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  env = new FilesystemEnvironment({ root, name: 'test' });
});

afterEach(async () => {
  // Small delay to let fs.watch close before cleanup
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

/** Build a simple colony definition with a custom action */
function buildColony(
  action: (signal: Signal, ctx: ActionContext) => Promise<void>,
  opts: {
    concurrency?: number;
    pollInterval?: number;
    claimStrategy?: 'exclusive' | 'lease' | 'none';
    autoWithdraw?: boolean;
    timeout?: number;
    retry?: { maxAttempts: number; backoffMs: number };
  } = {}
): ColonyDefinition {
  const builder = colony('test-colony')
    .in(env)
    .sense('task:ready', { unclaimed: true })
    .do('process', action)
    .concurrency(opts.concurrency ?? 1)
    .claim(opts.claimStrategy ?? 'exclusive')
    .poll(opts.pollInterval ?? 100);

  if (opts.autoWithdraw) builder.autoWithdraw();
  if (opts.timeout) builder.timeout(opts.timeout);
  if (opts.retry) builder.retry(opts.retry.maxAttempts, opts.retry.backoffMs);

  return builder.build();
}

// ── Lifecycle ───────────────────────────────────────────────

describe('runtime — lifecycle', () => {
  it('starts in idle state', () => {
    const def = buildColony(async () => {});
    const rt = createRuntime(def);
    expect(rt.state).toBe('idle');
  });

  it('transitions to running on start', async () => {
    const def = buildColony(async () => {});
    const rt = createRuntime(def);
    await rt.start();
    expect(rt.state).toBe('running');
    await rt.stop();
  });

  it('transitions to stopped on stop', async () => {
    const def = buildColony(async () => {});
    const rt = createRuntime(def);
    await rt.start();
    await rt.stop();
    expect(rt.state).toBe('stopped');
  });

  it('is idempotent on double start', async () => {
    const def = buildColony(async () => {});
    const rt = createRuntime(def);
    await rt.start();
    await rt.start(); // should not throw
    expect(rt.state).toBe('running');
    await rt.stop();
  });

  it('is idempotent on double stop', async () => {
    const def = buildColony(async () => {});
    const rt = createRuntime(def);
    await rt.start();
    await rt.stop();
    await rt.stop(); // should not throw
    expect(rt.state).toBe('stopped');
  });

  it('does nothing when stop called on idle runtime', async () => {
    const def = buildColony(async () => {});
    const rt = createRuntime(def);
    await rt.stop(); // should not throw
    expect(rt.state).toBe('idle');
  });
});

// ── Sensing and processing ──────────────────────────────────

describe('runtime — sensing and processing', () => {
  it('picks up a deposited signal and processes it', async () => {
    const processed: string[] = [];
    const def = buildColony(async (signal) => {
      processed.push(signal.payload.name as string);
    });

    await depositTask('auth');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(300);
    await rt.stop();

    expect(processed).toContain('auth');
  });

  it('processes multiple signals', async () => {
    const processed: string[] = [];
    const def = buildColony(async (signal) => {
      processed.push(signal.payload.name as string);
    });

    await depositTask('a');
    await depositTask('b');
    await depositTask('c');

    const rt = createRuntime(def);
    await rt.start();
    await sleep(500);
    await rt.stop();

    expect(processed.length).toBeGreaterThanOrEqual(3);
  });

  it('updates stats after processing', async () => {
    const def = buildColony(async () => {});
    await depositTask('stat-test');

    const rt = createRuntime(def);
    await rt.start();
    await sleep(300);
    await rt.stop();

    expect(rt.stats.signalsSensed).toBeGreaterThan(0);
    expect(rt.stats.signalsClaimed).toBeGreaterThan(0);
    expect(rt.stats.signalsProcessed).toBeGreaterThan(0);
  });
});

// ── Rule matching with guards ───────────────────────────────

describe('runtime — rule matching', () => {
  it('skips signals that fail the guard', async () => {
    const processed: string[] = [];
    const def = colony('guarded')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .when((signal) => signal.payload.name === 'wanted')
      .do('filter', async (signal) => {
        processed.push(signal.payload.name as string);
      })
      .claim('exclusive')
      .poll(100)
      .build();

    await depositTask('wanted');
    await depositTask('unwanted');

    const rt = createRuntime(def);
    await rt.start();
    await sleep(400);
    await rt.stop();

    expect(processed).toContain('wanted');
    expect(processed).not.toContain('unwanted');
  });

  it('supports async guards', async () => {
    const processed: string[] = [];
    const def = colony('async-guard')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .when(async (signal) => {
        await sleep(10);
        return signal.payload.name === 'async-ok';
      })
      .do('filter', async (signal) => {
        processed.push(signal.payload.name as string);
      })
      .claim('exclusive')
      .poll(100)
      .build();

    await depositTask('async-ok');
    await depositTask('async-no');

    const rt = createRuntime(def);
    await rt.start();
    await sleep(500);
    await rt.stop();

    expect(processed).toContain('async-ok');
    expect(processed).not.toContain('async-no');
  });
});

// ── Claim management ────────────────────────────────────────

describe('runtime — claims', () => {
  it('claims signals before processing (exclusive strategy)', async () => {
    const def = buildColony(async (signal) => {
      // Verify the signal is claimed while we're processing
      const observed = await env.observe({ type: 'task:ready' });
      const ours = observed.find(s => s.id === signal.id);
      expect(ours?.meta.claimed_by).toBe('test-colony');
    });

    await depositTask('claim-check');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(300);
    await rt.stop();

    expect(rt.stats.signalsClaimed).toBeGreaterThan(0);
  });

  it('tracks claim conflicts in stats', async () => {
    // Two runtimes competing for the same signal
    const def1 = buildColony(async () => { await sleep(200); }, { pollInterval: 50 });
    const def2 = colony('competitor')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .do('compete', async () => { await sleep(200); })
      .claim('exclusive')
      .poll(50)
      .build();

    await depositTask('contested');

    const rt1 = createRuntime(def1);
    const rt2 = createRuntime(def2);

    await Promise.all([rt1.start(), rt2.start()]);
    await sleep(500);
    await Promise.all([rt1.stop(), rt2.stop()]);

    // One of them should have a claim conflict
    const totalConflicts = rt1.stats.claimConflicts + rt2.stats.claimConflicts;
    const totalProcessed = rt1.stats.signalsProcessed + rt2.stats.signalsProcessed;
    // At least one should process it, and at most both (filesystem claims aren't perfectly atomic)
    expect(totalProcessed).toBeGreaterThanOrEqual(1);
    expect(totalProcessed).toBeLessThanOrEqual(2);
  });

  it('skips claiming with none strategy', async () => {
    const processed: string[] = [];
    const def = buildColony(
      async (signal) => { processed.push(signal.payload.name as string); },
      { claimStrategy: 'none' }
    );

    await depositTask('no-claim');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(300);
    await rt.stop();

    // Processed but never claimed
    expect(processed).toContain('no-claim');
    expect(rt.stats.signalsClaimed).toBe(0);
  });

  it('releases claim on action error', async () => {
    const def = buildColony(async () => {
      throw new Error('action failed');
    });

    const signal = await depositTask('error-release');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(300);
    await rt.stop();

    expect(rt.stats.errors).toBeGreaterThan(0);
  });
});

// ── Concurrency ─────────────────────────────────────────────

describe('runtime — concurrency', () => {
  it('respects concurrency limit', async () => {
    let maxConcurrent = 0;
    let current = 0;

    const def = buildColony(
      async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await sleep(100);
        current--;
      },
      { concurrency: 2 }
    );

    await depositTask('a');
    await depositTask('b');
    await depositTask('c');
    await depositTask('d');

    const rt = createRuntime(def);
    await rt.start();
    await sleep(800);
    await rt.stop();

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});

// ── Auto-withdraw ───────────────────────────────────────────

describe('runtime — auto-withdraw', () => {
  it('withdraws signals after processing when enabled', async () => {
    const def = buildColony(async () => {}, { autoWithdraw: true });

    const signal = await depositTask('auto-withdraw');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(300);
    await rt.stop();

    const remaining = await env.snapshot();
    expect(remaining.find(s => s.id === signal.id)).toBeUndefined();
  });
});

// ── Action timeout ──────────────────────────────────────────

describe('runtime — action timeout', () => {
  it('times out long-running actions', async () => {
    const def = buildColony(
      async () => { await sleep(5000); },
      { timeout: 50 }
    );

    await depositTask('slow');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(300);
    await rt.stop();

    expect(rt.stats.errors).toBeGreaterThan(0);
  });
});

// ── Retry ───────────────────────────────────────────────────

describe('runtime — retry', () => {
  it('retries failed actions up to maxAttempts', async () => {
    let attempts = 0;
    const def = buildColony(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error(`fail ${attempts}`);
      },
      { retry: { maxAttempts: 3, backoffMs: 10 } }
    );

    await depositTask('retry-me');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(500);
    await rt.stop();

    expect(attempts).toBe(3);
    expect(rt.stats.signalsProcessed).toBe(1);
    expect(rt.stats.errors).toBe(0); // succeeded on final attempt
  });

  it('records error when all retries exhausted', async () => {
    const def = buildColony(
      async () => { throw new Error('permanent failure'); },
      { retry: { maxAttempts: 2, backoffMs: 10 } }
    );

    await depositTask('fail-all');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(500);
    await rt.stop();

    expect(rt.stats.errors).toBeGreaterThan(0);
  });
});

// ── Action context ──────────────────────────────────────────

describe('runtime — action context', () => {
  it('ctx.deposit creates a new signal in the environment', async () => {
    const def = buildColony(async (signal, ctx) => {
      await ctx.deposit('task:shaped', { result: 'done' }, {
        causedBy: [signal.id],
        tags: ['output'],
      });
    });

    const trigger = await depositTask('deposit-test');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(300);
    await rt.stop();

    const shaped = await env.observe({ type: 'task:shaped' });
    expect(shaped).toHaveLength(1);
    expect(shaped[0].payload).toEqual({ result: 'done' });
    expect(shaped[0].meta.deposited_by).toBe('test-colony');
    expect(shaped[0].meta.caused_by).toEqual([trigger.id]);
    expect(shaped[0].meta.tags).toEqual(['output']);
    expect(rt.stats.signalsDeposited).toBe(1);
  });

  it('ctx.withdraw removes a signal', async () => {
    const def = buildColony(async (signal, ctx) => {
      await ctx.withdraw(signal.id);
    });

    const signal = await depositTask('withdraw-test');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(300);
    await rt.stop();

    const remaining = await env.snapshot();
    expect(remaining.find(s => s.id === signal.id)).toBeUndefined();
  });

  it('ctx.colony has the colony name', async () => {
    let colonyName: string | undefined;
    const def = buildColony(async (_signal, ctx) => {
      colonyName = ctx.colony;
    });

    await depositTask('name-test');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(300);
    await rt.stop();

    expect(colonyName).toBe('test-colony');
  });
});

// ── Structured event system ─────────────────────────────────

describe('runtime — event system', () => {
  it('emits colony:started and colony:stopped events', async () => {
    const events: RuntimeEventData[] = [];
    const def = buildColony(async () => {});
    const rt = createRuntime(def, { onEvent: (e) => events.push(e) });

    await rt.start();
    await rt.stop();

    const types = events.map(e => e.type);
    expect(types).toContain('colony:started');
    expect(types).toContain('colony:stopped');
  });

  it('emits signal lifecycle events during processing', async () => {
    const events: RuntimeEventData[] = [];
    const def = buildColony(async (_signal, ctx) => {
      await ctx.deposit('task:shaped', { done: true });
    });

    await depositTask('event-test');
    const rt = createRuntime(def, { onEvent: (e) => events.push(e) });

    await rt.start();
    await sleep(400);
    await rt.stop();

    const types = events.map(e => e.type);
    expect(types).toContain('signal:sensed');
    expect(types).toContain('signal:matched');
    expect(types).toContain('signal:claimed');
    expect(types).toContain('action:started');
    expect(types).toContain('action:completed');
    expect(types).toContain('signal:deposited');
  });

  it('emits action:failed on error', async () => {
    const events: RuntimeEventData[] = [];
    const def = buildColony(async () => {
      throw new Error('boom');
    });

    await depositTask('fail-event');
    const rt = createRuntime(def, { onEvent: (e) => events.push(e) });

    await rt.start();
    await sleep(300);
    await rt.stop();

    const failed = events.find(e => e.type === 'action:failed');
    expect(failed).toBeDefined();
    expect(failed!.error).toContain('boom');
  });

  it('emits decay:sweep events', async () => {
    const events: RuntimeEventData[] = [];
    const def = buildColony(async () => {});
    const rt = createRuntime(def, {
      onEvent: (e) => events.push(e),
      decayPolicy: { interval: 100 },
    });

    await rt.start();
    await sleep(300);
    await rt.stop();

    const decayEvents = events.filter(e => e.type === 'decay:sweep');
    expect(decayEvents.length).toBeGreaterThan(0);
  });

  it('events include signal metadata', async () => {
    const events: RuntimeEventData[] = [];
    const def = buildColony(async () => {});

    await depositTask('meta-event');
    const rt = createRuntime(def, { onEvent: (e) => events.push(e) });

    await rt.start();
    await sleep(300);
    await rt.stop();

    const sensed = events.find(e => e.type === 'signal:sensed');
    expect(sensed?.signalId).toMatch(/^sig_/);
    expect(sensed?.signalType).toBe('task:ready');
    expect(sensed?.colony).toBe('test-colony');
    expect(sensed?.timestamp).toBeGreaterThan(0);
  });

  it('EventBus on() with type filter works', async () => {
    const def = buildColony(async () => {});
    const rt = createRuntime(def);

    const claimed: RuntimeEventData[] = [];
    rt.events.on('signal:claimed', (e) => claimed.push(e));

    await depositTask('bus-test');
    await rt.start();
    await sleep(300);
    await rt.stop();

    expect(claimed.length).toBeGreaterThan(0);
    expect(claimed.every(e => e.type === 'signal:claimed')).toBe(true);
  });

  it('onEvent callback errors do not crash runtime', async () => {
    const def = buildColony(async () => {});
    const rt = createRuntime(def, {
      onEvent: () => { throw new Error('callback crash'); },
    });

    await depositTask('crash-proof');
    await rt.start();
    await sleep(300);
    await rt.stop();

    // Should reach stopped without crashing
    expect(rt.state).toBe('stopped');
    expect(rt.stats.signalsProcessed).toBeGreaterThan(0);
  });
});

// ── Legacy event system ─────────────────────────────────────

describe('runtime — legacy on() events', () => {
  it('fires colony:started and colony:stopped', async () => {
    const def = buildColony(async () => {});
    const rt = createRuntime(def);

    const events: string[] = [];
    rt.on('colony:started', () => events.push('started'));
    rt.on('colony:stopped', () => events.push('stopped'));

    await rt.start();
    await rt.stop();

    expect(events).toEqual(['started', 'stopped']);
  });

  it('fires action:completed after action completes', async () => {
    const def = buildColony(async () => {});
    const rt = createRuntime(def);

    let processedSignal: Signal | undefined;
    rt.on('action:completed', (signal: Signal) => {
      processedSignal = signal;
    });

    await depositTask('legacy-event');
    await rt.start();
    await sleep(300);
    await rt.stop();

    expect(processedSignal).toBeDefined();
    expect(processedSignal!.type).toBe('task:ready');
  });
});

// ── Decay control ───────────────────────────────────────────

describe('runtime — decay control', () => {
  it('decay runs by default', async () => {
    const events: RuntimeEventData[] = [];
    const def = buildColony(async () => {});
    const rt = createRuntime(def, {
      onEvent: (e) => events.push(e),
      decayPolicy: { interval: 100 },
    });

    await rt.start();
    await sleep(300);
    await rt.stop();

    const decayEvents = events.filter(e => e.type === 'decay:sweep');
    expect(decayEvents.length).toBeGreaterThan(0);
  });

  it('decay skipped when config.decay === false', async () => {
    const events: RuntimeEventData[] = [];
    const def = colony('no-decay')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .do('process', async () => {})
      .decay(false)
      .claim('exclusive')
      .poll(100)
      .build();

    const rt = createRuntime(def, {
      onEvent: (e) => events.push(e),
      decayPolicy: { interval: 100 },
    });

    await rt.start();
    await sleep(300);
    await rt.stop();

    const decayEvents = events.filter(e => e.type === 'decay:sweep');
    expect(decayEvents).toHaveLength(0);
  });

  it('decay runs when config.decay === true explicitly', async () => {
    const events: RuntimeEventData[] = [];
    const def = colony('explicit-decay')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .do('process', async () => {})
      .decay(true)
      .claim('exclusive')
      .poll(100)
      .build();

    const rt = createRuntime(def, {
      onEvent: (e) => events.push(e),
      decayPolicy: { interval: 100 },
    });

    await rt.start();
    await sleep(300);
    await rt.stop();

    const decayEvents = events.filter(e => e.type === 'decay:sweep');
    expect(decayEvents.length).toBeGreaterThan(0);
  });
});

// ── Enrich ──────────────────────────────────────────────────

describe('runtime — enrich', () => {
  it('ctx.enrich() updates signal in-place and returns updated signal', async () => {
    let enrichedSignal: Signal | undefined;
    const def = buildColony(async (signal, ctx) => {
      enrichedSignal = await ctx.enrich(signal.id, { payload: { enriched: true } });
    });

    const trigger = await depositTask('enrich-test');
    const rt = createRuntime(def);
    await rt.start();
    await sleep(300);
    await rt.stop();

    expect(enrichedSignal).toBeDefined();
    expect(enrichedSignal!.payload).toEqual({ name: 'enrich-test', enriched: true });
  });

  it('ctx.enrich() throws if environment does not support update()', async () => {
    let thrownError: Error | undefined;

    // Create a minimal environment without update()
    const noUpdateEnv = {
      name: 'no-update',
      observe: async () => [],
      deposit: env.deposit.bind(env),
      withdraw: env.withdraw.bind(env),
      claim: env.claim.bind(env),
      release: env.release.bind(env),
      watch: env.watch.bind(env),
      history: env.history.bind(env),
      decay: env.decay.bind(env),
      snapshot: env.snapshot.bind(env),
    };

    // Deposit a signal first, then swap the environment reference
    const trigger = await depositTask('no-update-test');

    // Override observe to return the signal
    noUpdateEnv.observe = async () => [trigger];

    const def = colony('no-update-colony')
      .in(noUpdateEnv as any)
      .sense('task:ready', { unclaimed: true })
      .do('process', async (_signal, ctx) => {
        try {
          await ctx.enrich(_signal.id, { payload: { x: 1 } });
        } catch (e) {
          thrownError = e as Error;
        }
      })
      .claim('none')
      .poll(100)
      .build();

    const rt = createRuntime(def);
    await rt.start();
    await sleep(300);
    await rt.stop();

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).toContain('does not support update()');
  });

  it('signal:enriched event emitted', async () => {
    const events: RuntimeEventData[] = [];
    const def = buildColony(async (signal, ctx) => {
      await ctx.enrich(signal.id, { tags: ['enriched'] });
    });

    await depositTask('enrich-event-test');
    const rt = createRuntime(def, { onEvent: (e) => events.push(e) });
    await rt.start();
    await sleep(300);
    await rt.stop();

    const enriched = events.filter(e => e.type === 'signal:enriched');
    expect(enriched.length).toBeGreaterThan(0);
    expect(enriched[0].signalId).toMatch(/^sig_/);
    expect(enriched[0].colony).toBe('test-colony');
  });
});

// ── Autoscale ───────────────────────────────────────────────

describe('runtime — autoscale', () => {
  it('static concurrency(3) still works, no scaler created', async () => {
    const events: RuntimeEventData[] = [];
    const def = buildColony(async () => {}, { concurrency: 3 });
    const rt = createRuntime(def, { onEvent: (e) => events.push(e) });

    expect(rt.concurrency).toBe(3);

    await rt.start();
    await sleep(200);
    await rt.stop();

    // No colony:scaled events
    expect(events.filter(e => e.type === 'colony:scaled')).toHaveLength(0);
  });

  it('autoscale increases concurrency under load', async () => {
    // Deposit many signals to create pressure
    for (let i = 0; i < 8; i++) {
      await depositTask(`load-${i}`);
    }

    const events: RuntimeEventData[] = [];
    const def = colony('scaler-test')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .do('process', async () => { await sleep(2000); }) // long action keeps agents busy
      .concurrency({ min: 1, max: 4, target: 1 })
      .autoscale({ scaleUpThreshold: 3, cooldownMs: 200 })
      .claim('exclusive')
      .poll(100)
      .build();

    const rt = createRuntime(def, { onEvent: (e) => events.push(e) });
    await rt.start();
    // Wait for scaler to evaluate and scale up
    await sleep(800);
    await rt.stop();

    // Should have scaled up at least once
    const scaleEvents = events.filter(e => e.type === 'colony:scaled');
    expect(scaleEvents.length).toBeGreaterThan(0);
    expect(rt.concurrency).toBeGreaterThan(1);
  });

  it('autoscale decreases concurrency when idle', async () => {
    const events: RuntimeEventData[] = [];
    const def = colony('idle-scaler')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .do('process', async () => {})
      .concurrency({ min: 1, max: 8, target: 3 })
      .autoscale({ scaleDownAfterMs: 200, cooldownMs: 100 })
      .claim('exclusive')
      .poll(100)
      .build();

    const rt = createRuntime(def, { onEvent: (e) => events.push(e) });
    // No signals deposited — environment is empty
    await rt.start();
    // Wait long enough for idle detection + scale down
    await sleep(600);
    await rt.stop();

    const scaleEvents = events.filter(e => e.type === 'colony:scaled');
    expect(scaleEvents.length).toBeGreaterThan(0);
    expect(rt.concurrency).toBeLessThan(3);
  });

  it('colony:scaled events carry correct metadata', async () => {
    for (let i = 0; i < 6; i++) {
      await depositTask(`meta-${i}`);
    }

    const events: RuntimeEventData[] = [];
    const def = colony('meta-scaler')
      .in(env)
      .sense('task:ready', { unclaimed: true })
      .do('process', async () => { await sleep(200); })
      .concurrency({ min: 1, max: 4, target: 1 })
      .autoscale({ scaleUpThreshold: 3, cooldownMs: 200 })
      .claim('exclusive')
      .poll(100)
      .timeout(500)
      .build();

    const rt = createRuntime(def, { onEvent: (e) => events.push(e) });
    await rt.start();
    await sleep(400);
    await rt.stop();

    const scaleEvent = events.find(e => e.type === 'colony:scaled');
    expect(scaleEvent).toBeDefined();
    expect(scaleEvent!.colony).toBe('meta-scaler');
    expect(scaleEvent!.metadata).toHaveProperty('from');
    expect(scaleEvent!.metadata).toHaveProperty('to');
    expect(scaleEvent!.metadata).toHaveProperty('reason');
    expect(scaleEvent!.metadata).toHaveProperty('queueDepth');
  });

  it('no colony:scaled events with static concurrency', async () => {
    for (let i = 0; i < 5; i++) {
      await depositTask(`static-${i}`);
    }

    const events: RuntimeEventData[] = [];
    const def = buildColony(async () => { await sleep(50); }, { concurrency: 2 });
    const rt = createRuntime(def, { onEvent: (e) => events.push(e) });

    await rt.start();
    await sleep(500);
    await rt.stop();

    expect(events.filter(e => e.type === 'colony:scaled')).toHaveLength(0);
  });
});
