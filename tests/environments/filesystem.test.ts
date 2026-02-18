// PURPOSE: Tests for the filesystem environment adapter
// PURPOSE: Covers deposit, observe, withdraw, claim, release, watch, history, decay, snapshot

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FilesystemEnvironment } from '../../src/environments/filesystem/adapter.js';
import type { Signal } from '../../src/core/types.js';

// ── Test environment helper ─────────────────────────────────

let env: FilesystemEnvironment;
let root: string;

beforeEach(async () => {
  root = join(tmpdir(), `mandible-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  env = new FilesystemEnvironment({ root, name: 'test-env' });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function depositTask(name: string, opts: Record<string, unknown> = {}): Promise<Signal> {
  return env.deposit({
    type: 'task:ready',
    payload: { name, ...opts },
    meta: { deposited_by: 'test' },
  });
}

// ── Constructor ─────────────────────────────────────────────

describe('FilesystemEnvironment — constructor', () => {
  it('uses provided name', () => {
    expect(env.name).toBe('test-env');
  });

  it('falls back to fs:{root} when name not provided', () => {
    const e = new FilesystemEnvironment({ root: '/tmp/foo' });
    expect(e.name).toBe('fs:/tmp/foo');
  });
});

// ── deposit ─────────────────────────────────────────────────

describe('deposit', () => {
  it('returns a signal with generated id and meta', async () => {
    const signal = await depositTask('auth');

    expect(signal.id).toMatch(/^sig_/);
    expect(signal.type).toBe('task:ready');
    expect(signal.payload).toEqual({ name: 'auth' });
    expect(signal.meta.deposited_by).toBe('test');
    expect(signal.meta.concentration).toBe(1.0);
  });

  it('writes a JSON file to the signals directory', async () => {
    const signal = await depositTask('auth');
    const filePath = join(root, 'signals', `${signal.id}.json`);
    const raw = JSON.parse(await readFile(filePath, 'utf-8'));

    expect(raw.id).toBe(signal.id);
    expect(raw.type).toBe('task:ready');
  });

  it('creates directories on first deposit', async () => {
    await depositTask('first');
    const dirs = await readdir(root);
    expect(dirs).toContain('signals');
    expect(dirs).toContain('withdrawn');
    expect(dirs).toContain('claims');
  });

  it('applies optional meta fields', async () => {
    const signal = await env.deposit({
      type: 'task:ready',
      payload: { name: 'tagged' },
      meta: {
        deposited_by: 'shaper',
        ttl: 5000,
        tags: ['urgent'],
        caused_by: ['sig_parent'],
        concentration: 0.8,
      },
    });

    expect(signal.meta.deposited_by).toBe('shaper');
    expect(signal.meta.ttl).toBe(5000);
    expect(signal.meta.tags).toEqual(['urgent']);
    expect(signal.meta.caused_by).toEqual(['sig_parent']);
    expect(signal.meta.concentration).toBe(0.8);
  });

  it('rejects invalid signal type', async () => {
    await expect(
      env.deposit({ type: '', payload: {}, meta: { deposited_by: 'test' } })
    ).rejects.toThrow('non-empty string');
  });

  it('rejects null payload', async () => {
    await expect(
      env.deposit({ type: 'x', payload: null as any, meta: { deposited_by: 'test' } })
    ).rejects.toThrow('plain object');
  });

  it('rejects array payload', async () => {
    await expect(
      env.deposit({ type: 'x', payload: [] as any, meta: { deposited_by: 'test' } })
    ).rejects.toThrow('plain object');
  });

  it('rejects concentration outside 0-1 range', async () => {
    await expect(
      env.deposit({ type: 'x', payload: {}, meta: { deposited_by: 'test', concentration: 1.5 } })
    ).rejects.toThrow('concentration');
  });

  it('rejects negative ttl', async () => {
    await expect(
      env.deposit({ type: 'x', payload: {}, meta: { deposited_by: 'test', ttl: -1 } })
    ).rejects.toThrow('ttl');
  });
});

// ── observe ─────────────────────────────────────────────────

describe('observe', () => {
  it('returns signals matching type query', async () => {
    await depositTask('a');
    await depositTask('b');
    await env.deposit({ type: 'review:done', payload: {}, meta: { deposited_by: 'test' } });

    const tasks = await env.observe({ type: 'task:ready' });
    expect(tasks).toHaveLength(2);
    expect(tasks.every(s => s.type === 'task:ready')).toBe(true);
  });

  it('supports glob patterns', async () => {
    await depositTask('a');
    await env.deposit({ type: 'task:done', payload: {}, meta: { deposited_by: 'test' } });
    await env.deposit({ type: 'review:done', payload: {}, meta: { deposited_by: 'test' } });

    const allTasks = await env.observe({ type: 'task:*' });
    expect(allTasks).toHaveLength(2);
  });

  it('returns all signals when no query filter', async () => {
    await depositTask('a');
    await depositTask('b');
    const all = await env.observe({});
    expect(all).toHaveLength(2);
  });

  it('respects limit', async () => {
    await depositTask('a');
    await depositTask('b');
    await depositTask('c');

    const limited = await env.observe({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('filters by unclaimed', async () => {
    const s1 = await depositTask('unclaimed');
    const s2 = await depositTask('claimed');
    await env.claim(s2.id, 'shaper');

    const unclaimed = await env.observe({ type: 'task:ready', unclaimed: true });
    expect(unclaimed).toHaveLength(1);
    expect(unclaimed[0].id).toBe(s1.id);
  });

  it('returns empty for no matches', async () => {
    await depositTask('a');
    const none = await env.observe({ type: 'review:*' });
    expect(none).toEqual([]);
  });
});

// ── withdraw ────────────────────────────────────────────────

describe('withdraw', () => {
  it('moves signal from signals/ to withdrawn/', async () => {
    const signal = await depositTask('to-withdraw');
    await env.withdraw(signal.id);

    const active = await env.snapshot();
    expect(active.find(s => s.id === signal.id)).toBeUndefined();

    const withdrawnFiles = await readdir(join(root, 'withdrawn'));
    expect(withdrawnFiles).toContain(`${signal.id}.json`);
  });

  it('cleans up associated claim lock', async () => {
    const signal = await depositTask('claimed');
    await env.claim(signal.id, 'shaper');
    await env.withdraw(signal.id);

    const claimFiles = await readdir(join(root, 'claims'));
    expect(claimFiles.find(f => f.includes(signal.id))).toBeUndefined();
  });

  it('does not throw for already-withdrawn signal', async () => {
    const signal = await depositTask('double-withdraw');
    await env.withdraw(signal.id);
    await expect(env.withdraw(signal.id)).resolves.toBeUndefined();
  });

  it('does not throw for nonexistent signal', async () => {
    await expect(env.withdraw('sig_nonexistent')).resolves.toBeUndefined();
  });
});

// ── claim / release ─────────────────────────────────────────

describe('claim', () => {
  it('successfully claims an unclaimed signal', async () => {
    const signal = await depositTask('claimable');
    const result = await env.claim(signal.id, 'shaper');
    expect(result).toBe(true);
  });

  it('creates a lock file in claims/', async () => {
    const signal = await depositTask('lockfile');
    await env.claim(signal.id, 'shaper');

    const claimFiles = await readdir(join(root, 'claims'));
    expect(claimFiles).toContain(`${signal.id}.lock`);
  });

  it('updates signal meta with claim info', async () => {
    const signal = await depositTask('meta-update');
    await env.claim(signal.id, 'shaper', 30_000);

    const signals = await env.observe({ type: 'task:ready' });
    const claimed = signals.find(s => s.id === signal.id)!;
    expect(claimed.meta.claimed_by).toBe('shaper');
    expect(claimed.meta.claimed_at).toBeGreaterThan(0);
    expect(claimed.meta.claim_lease).toBe(30_000);
  });

  it('rejects second claim on same signal', async () => {
    const signal = await depositTask('contested');
    await env.claim(signal.id, 'shaper');
    const second = await env.claim(signal.id, 'critic');
    expect(second).toBe(false);
  });

  it('allows claim takeover when lease has expired', async () => {
    const signal = await depositTask('expiring');
    // Claim with a 1ms lease (will expire immediately)
    await env.claim(signal.id, 'shaper', 1);

    // Small delay to ensure lease expires
    await new Promise(r => setTimeout(r, 10));

    const takeover = await env.claim(signal.id, 'critic', 30_000);
    expect(takeover).toBe(true);
  });
});

describe('release', () => {
  it('removes the lock file', async () => {
    const signal = await depositTask('releasable');
    await env.claim(signal.id, 'shaper');
    await env.release(signal.id);

    const claimFiles = await readdir(join(root, 'claims'));
    expect(claimFiles.find(f => f.includes(signal.id))).toBeUndefined();
  });

  it('clears claim meta on the signal', async () => {
    const signal = await depositTask('clear-meta');
    await env.claim(signal.id, 'shaper');
    await env.release(signal.id);

    const signals = await env.observe({ type: 'task:ready' });
    const released = signals.find(s => s.id === signal.id)!;
    expect(released.meta.claimed_by).toBeUndefined();
    expect(released.meta.claimed_at).toBeUndefined();
    expect(released.meta.claim_lease).toBeUndefined();
  });

  it('does not throw for unclaimed signal', async () => {
    const signal = await depositTask('never-claimed');
    await expect(env.release(signal.id)).resolves.toBeUndefined();
  });

  it('does not throw for nonexistent signal', async () => {
    await expect(env.release('sig_ghost')).resolves.toBeUndefined();
  });
});

// ── watch ───────────────────────────────────────────────────

describe('watch', () => {
  it('emits existing signals on subscribe', async () => {
    const s1 = await depositTask('existing');

    const received: Signal[] = [];
    const sub = env.watch({ type: 'task:ready' }, (signal) => {
      received.push(signal);
    });

    // Give the initial async scan time to run
    await new Promise(r => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(s1.id);

    sub.unsubscribe();
  });

  it('emits new signals deposited after subscribe', async () => {
    // Trigger directory init before watch
    await env.snapshot();

    const received: Signal[] = [];
    const sub = env.watch({ type: 'task:ready' }, (signal) => {
      received.push(signal);
    });

    // Wait for initial scan
    await new Promise(r => setTimeout(r, 100));
    const beforeCount = received.length;

    // Deposit a new signal
    await depositTask('new-signal');

    // Give fs.watch time to fire
    await new Promise(r => setTimeout(r, 200));

    expect(received.length).toBeGreaterThan(beforeCount);

    sub.unsubscribe();
  });

  it('stops emitting after unsubscribe', async () => {
    await env.snapshot();

    const received: Signal[] = [];
    const sub = env.watch({ type: 'task:ready' }, (signal) => {
      received.push(signal);
    });

    await new Promise(r => setTimeout(r, 100));
    sub.unsubscribe();

    const countAfterUnsub = received.length;
    await depositTask('after-unsub');
    await new Promise(r => setTimeout(r, 200));

    expect(received.length).toBe(countAfterUnsub);
  });

  it('only emits signals matching the query', async () => {
    await env.snapshot();

    const received: Signal[] = [];
    const sub = env.watch({ type: 'review:*' }, (signal) => {
      received.push(signal);
    });

    await new Promise(r => setTimeout(r, 100));

    // Deposit a non-matching signal
    await depositTask('not-review');
    await new Promise(r => setTimeout(r, 200));

    expect(received).toHaveLength(0);

    sub.unsubscribe();
  });
});

// ── history ─────────────────────────────────────────────────

describe('history', () => {
  it('returns active signals by default', async () => {
    await depositTask('active');

    const result = await env.history({ type: 'task:ready' });
    expect(result).toHaveLength(1);
  });

  it('includes withdrawn signals when includeWithdrawn is true', async () => {
    const signal = await depositTask('will-withdraw');
    await env.withdraw(signal.id);

    const activeOnly = await env.history({ type: 'task:ready' });
    expect(activeOnly).toHaveLength(0);

    const withWithdrawn = await env.history({ type: 'task:ready', includeWithdrawn: true });
    expect(withWithdrawn).toHaveLength(1);
    expect(withWithdrawn[0].id).toBe(signal.id);
  });

  it('respects limit', async () => {
    await depositTask('a');
    await depositTask('b');
    await depositTask('c');

    const limited = await env.history({ limit: 2 });
    expect(limited).toHaveLength(2);
  });
});

// ── decay ───────────────────────────────────────────────────

describe('decay', () => {
  it('evaporates expired signals (TTL)', async () => {
    await env.deposit({
      type: 'task:ready',
      payload: { name: 'expiring' },
      meta: { deposited_by: 'test', ttl: 1 }, // 1ms TTL
    });

    // Wait for TTL to pass
    await new Promise(r => setTimeout(r, 10));

    const result = await env.decay();
    expect(result.evaporated).toBeGreaterThanOrEqual(1);

    const remaining = await env.snapshot();
    expect(remaining).toHaveLength(0);
  });

  it('releases expired claims', async () => {
    const signal = await depositTask('claimed-expiring');
    await env.claim(signal.id, 'shaper', 1); // 1ms lease

    await new Promise(r => setTimeout(r, 10));

    const result = await env.decay();
    expect(result.claimsReleased).toBeGreaterThanOrEqual(1);

    const signals = await env.observe({ type: 'task:ready' });
    const updated = signals.find(s => s.id === signal.id);
    expect(updated?.meta.claimed_by).toBeUndefined();
  });

  it('returns zero counts when nothing to decay', async () => {
    const result = await env.decay();
    expect(result.decayed).toBe(0);
    expect(result.evaporated).toBe(0);
    expect(result.claimsReleased).toBe(0);
  });
});

// ── snapshot ────────────────────────────────────────────────

describe('snapshot', () => {
  it('returns all active signals', async () => {
    await depositTask('a');
    await depositTask('b');
    await depositTask('c');

    const snap = await env.snapshot();
    expect(snap).toHaveLength(3);
  });

  it('does not include withdrawn signals', async () => {
    const signal = await depositTask('will-go');
    await env.withdraw(signal.id);

    const snap = await env.snapshot();
    expect(snap.find(s => s.id === signal.id)).toBeUndefined();
  });

  it('returns empty array for fresh environment', async () => {
    const snap = await env.snapshot();
    expect(snap).toEqual([]);
  });
});
