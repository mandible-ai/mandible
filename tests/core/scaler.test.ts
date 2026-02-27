// PURPOSE: Unit tests for ColonyScaler — dynamic concurrency based on signal pressure
// PURPOSE: Covers scaling up, down, cooldown, idle tracking, error handling, events

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ColonyScaler } from '../../src/core/scaler.js';
import type { Environment, Signal, SensorConfig, SignalQuery } from '../../src/core/types.js';
import type { RuntimeEventData } from '../../src/core/events.js';

// ── Test helpers ────────────────────────────────────────────

function makeSignal(id: string, type = 'task:ready'): Signal {
  return {
    id,
    type,
    payload: {},
    meta: { deposited_at: Date.now(), deposited_by: 'test', concentration: 1.0 },
  };
}

function createMockEnvironment(signals: Signal[] = []): Environment {
  return {
    name: 'mock',
    observe: vi.fn().mockResolvedValue(signals),
    deposit: vi.fn(),
    withdraw: vi.fn(),
    claim: vi.fn(),
    release: vi.fn(),
    watch: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
    history: vi.fn(),
    decay: vi.fn(),
    snapshot: vi.fn(),
  } as unknown as Environment;
}

function defaultSensors(): SensorConfig[] {
  return [{ query: { type: 'task:ready', unclaimed: true } }];
}

// ── Tests ───────────────────────────────────────────────────

describe('ColonyScaler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at target concurrency', () => {
    const onScale = vi.fn();
    const scaler = new ColonyScaler({
      min: 1,
      max: 8,
      target: 3,
      policy: { cooldownMs: 100 },
      environment: createMockEnvironment(),
      sensors: defaultSensors(),
      getActiveCount: () => 0,
      onScale,
      onEvent: vi.fn(),
    });

    // Target is 3 — no scaling should happen before start
    expect(onScale).not.toHaveBeenCalled();
    scaler.stop();
  });

  it('scales up when queue depth exceeds threshold', async () => {
    const signals = Array.from({ length: 6 }, (_, i) => makeSignal(`sig_${i}`));
    const env = createMockEnvironment(signals);
    const onScale = vi.fn();

    const scaler = new ColonyScaler({
      min: 1,
      max: 8,
      target: 2,
      policy: { scaleUpThreshold: 5, cooldownMs: 100 },
      environment: env,
      sensors: defaultSensors(),
      getActiveCount: () => 2, // all slots busy
      onScale,
      onEvent: vi.fn(),
    });

    await scaler.start();

    // The immediate evaluate on start should trigger scale-up
    expect(onScale).toHaveBeenCalledWith(3); // 2 → 3
    scaler.stop();
  });

  it('does not exceed max concurrency', async () => {
    const signals = Array.from({ length: 20 }, (_, i) => makeSignal(`sig_${i}`));
    const env = createMockEnvironment(signals);
    const scaledTo: number[] = [];
    const onScale = vi.fn((n: number) => { scaledTo.push(n); });

    const scaler = new ColonyScaler({
      min: 1,
      max: 4,
      target: 3,
      policy: { scaleUpThreshold: 5, cooldownMs: 50 },
      environment: env,
      sensors: defaultSensors(),
      getActiveCount: () => scaledTo.length > 0 ? scaledTo[scaledTo.length - 1] : 3,
      onScale,
      onEvent: vi.fn(),
    });

    await scaler.start();
    // First evaluate: 3 → 4 (threshold exceeded)
    expect(onScale).toHaveBeenCalledWith(4);

    // Advance past cooldown
    await vi.advanceTimersByTimeAsync(60);
    // Second evaluate: already at max (4), should NOT scale further
    expect(scaledTo.every(n => n <= 4)).toBe(true);

    scaler.stop();
  });

  it('scales down after idle period', async () => {
    const env = createMockEnvironment([]); // no signals = idle
    const onScale = vi.fn();
    let currentConcurrency = 4;

    const scaler = new ColonyScaler({
      min: 1,
      max: 8,
      target: 4,
      policy: { scaleDownAfterMs: 200, cooldownMs: 50 },
      environment: env,
      sensors: defaultSensors(),
      getActiveCount: () => 0, // idle — no active tasks
      onScale: (n: number) => { currentConcurrency = n; onScale(n); },
      onEvent: vi.fn(),
    });

    await scaler.start();
    // Initial evaluate: idle but not long enough yet → no scale
    expect(onScale).not.toHaveBeenCalled();

    // Advance past idle threshold + cooldown
    await vi.advanceTimersByTimeAsync(260);
    expect(onScale).toHaveBeenCalledWith(3); // 4 → 3

    scaler.stop();
  });

  it('does not go below min concurrency', async () => {
    const env = createMockEnvironment([]); // no signals
    const scaledTo: number[] = [];
    let currentConcurrency = 2;

    const scaler = new ColonyScaler({
      min: 2,
      max: 8,
      target: 3,
      policy: { scaleDownAfterMs: 50, cooldownMs: 50 },
      environment: env,
      sensors: defaultSensors(),
      getActiveCount: () => 0,
      onScale: (n: number) => { currentConcurrency = n; scaledTo.push(n); },
      onEvent: vi.fn(),
    });

    await scaler.start();
    // Advance enough for idle threshold + multiple cooldowns
    await vi.advanceTimersByTimeAsync(300);

    // Should scale down to min (2) but not below
    expect(scaledTo.every(n => n >= 2)).toBe(true);
    scaler.stop();
  });

  it('respects cooldown between scaling decisions', async () => {
    const signals = Array.from({ length: 10 }, (_, i) => makeSignal(`sig_${i}`));
    const env = createMockEnvironment(signals);
    const onScale = vi.fn();
    let current = 2;

    const scaler = new ColonyScaler({
      min: 1,
      max: 10,
      target: 2,
      policy: { scaleUpThreshold: 5, cooldownMs: 500 },
      environment: env,
      sensors: defaultSensors(),
      getActiveCount: () => current,
      onScale: (n: number) => { current = n; onScale(n); },
      onEvent: vi.fn(),
    });

    await scaler.start();
    // First scale: 2 → 3
    expect(onScale).toHaveBeenCalledTimes(1);

    // Advance 100ms — well within cooldown
    await vi.advanceTimersByTimeAsync(100);
    // Should still be only 1 scale event
    expect(onScale).toHaveBeenCalledTimes(1);

    // Advance past cooldown
    await vi.advanceTimersByTimeAsync(500);
    // Now second scale should happen: 3 → 4
    expect(onScale).toHaveBeenCalledTimes(2);

    scaler.stop();
  });

  it('resets idle tracking when activity is detected', async () => {
    let signalCount = 0;
    const env = createMockEnvironment([]);
    (env.observe as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      return signalCount > 0
        ? Array.from({ length: signalCount }, (_, i) => makeSignal(`sig_${i}`))
        : [];
    });

    const onScale = vi.fn();

    const scaler = new ColonyScaler({
      min: 1,
      max: 8,
      target: 3,
      policy: { scaleDownAfterMs: 200, cooldownMs: 50 },
      environment: env,
      sensors: defaultSensors(),
      getActiveCount: () => (signalCount > 0 ? 1 : 0),
      onScale,
      onEvent: vi.fn(),
    });

    await scaler.start();
    // Advance 150ms (not yet at idle threshold)
    await vi.advanceTimersByTimeAsync(150);
    expect(onScale).not.toHaveBeenCalled();

    // Activity appears — this should reset idle tracking
    signalCount = 1;
    await vi.advanceTimersByTimeAsync(60);

    // Remove activity
    signalCount = 0;
    // Need another full idle period from the reset point
    await vi.advanceTimersByTimeAsync(150);
    // Not enough time since last activity — should NOT have scaled down yet
    expect(onScale).not.toHaveBeenCalled();

    scaler.stop();
  });

  it('handles observe() errors gracefully', async () => {
    const env = createMockEnvironment([]);
    (env.observe as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network fail'));
    const onScale = vi.fn();

    const scaler = new ColonyScaler({
      min: 1,
      max: 8,
      target: 2,
      policy: { cooldownMs: 50 },
      environment: env,
      sensors: defaultSensors(),
      getActiveCount: () => 0,
      onScale,
      onEvent: vi.fn(),
    });

    // Should not throw
    await scaler.start();
    await vi.advanceTimersByTimeAsync(200);

    // No scaling decisions on error
    expect(onScale).not.toHaveBeenCalled();
    scaler.stop();
  });

  it('emits scale events with correct metadata', async () => {
    const signals = Array.from({ length: 6 }, (_, i) => makeSignal(`sig_${i}`));
    const env = createMockEnvironment(signals);
    const events: RuntimeEventData[] = [];

    const scaler = new ColonyScaler({
      min: 1,
      max: 8,
      target: 2,
      policy: { scaleUpThreshold: 5, cooldownMs: 100 },
      environment: env,
      sensors: defaultSensors(),
      getActiveCount: () => 2,
      onScale: vi.fn(),
      onEvent: (e) => events.push(e),
      colonyName: 'test-colony',
    });

    await scaler.start();

    const scaled = events.find(e => e.type === 'colony:scaled');
    expect(scaled).toBeDefined();
    expect(scaled!.colony).toBe('test-colony');
    expect(scaled!.metadata).toMatchObject({
      from: 2,
      to: 3,
      reason: 'scale_up',
      queueDepth: 6,
    });

    scaler.stop();
  });

  it('runs initial evaluate() immediately on start()', async () => {
    const signals = Array.from({ length: 10 }, (_, i) => makeSignal(`sig_${i}`));
    const env = createMockEnvironment(signals);
    const onScale = vi.fn();

    const scaler = new ColonyScaler({
      min: 1,
      max: 8,
      target: 2,
      policy: { scaleUpThreshold: 5, cooldownMs: 1000 },
      environment: env,
      sensors: defaultSensors(),
      getActiveCount: () => 2,
      onScale,
      onEvent: vi.fn(),
    });

    await scaler.start();

    // Should have scaled immediately without needing to advance timers
    expect(onScale).toHaveBeenCalledTimes(1);
    expect(onScale).toHaveBeenCalledWith(3);

    scaler.stop();
  });
});
