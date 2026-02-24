// PURPOSE: Tests for DashboardSource, LocalDashboardSource, and startDashboard
// PURPOSE: Verifies snapshot aggregation, colony info, deposit routing, events, and HTTP/WS endpoints

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalDashboardSource, startDashboard } from '../../src/cli/server.js';
import { EventBus, type RuntimeEventData } from '../../src/core/events.js';
import type { Environment, Signal, SignalInput, SignalQuery, Subscription, DecayResult } from '../../src/core/types.js';
import WebSocket from 'ws';

// ── Helpers ──────────────────────────────────────────────────

let sigCounter = 0;

function makeSignal(type: string, payload: Record<string, unknown> = {}): Signal {
  sigCounter++;
  return {
    id: `sig_${sigCounter}`,
    type,
    payload,
    meta: {
      deposited_at: Date.now(),
      deposited_by: 'test',
      concentration: 1.0,
    },
  };
}

function stubEnv(name: string, signals: Signal[] = []): Environment {
  const deposited: Signal[] = [];
  return {
    name,
    async deposit(input: SignalInput): Promise<Signal> {
      const sig = makeSignal(input.type, (input.payload ?? {}) as Record<string, unknown>);
      deposited.push(sig);
      return sig;
    },
    async observe(_query?: SignalQuery): Promise<Signal[]> { return signals; },
    async claim() { return false; },
    async release() {},
    async withdraw() { return undefined; },
    watch(_q: SignalQuery, _cb: (s: Signal) => void): Subscription { return { unsubscribe() {} }; },
    async snapshot(): Promise<Signal[]> { return signals; },
    async decay(): Promise<DecayResult> { return { decayed: 0, removed: 0, details: [] }; },
    async history() { return []; },
  };
}

function makeEvent(colony: string, type: RuntimeEventData['type'] = 'signal:deposited'): RuntimeEventData {
  return { type, colony, timestamp: Date.now() };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── LocalDashboardSource tests ───────────────────────────────

describe('LocalDashboardSource', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  it('snapshot() aggregates signals from multiple environments and tags with _environment', async () => {
    const sig1 = makeSignal('task:ready', { name: 'a' });
    const sig2 = makeSignal('task:done', { name: 'b' });
    const env1 = stubEnv('alpha', [sig1]);
    const env2 = stubEnv('beta', [sig2]);

    const source = new LocalDashboardSource(eventBus, [env1, env2], () => []);
    const result = await source.snapshot();

    expect(result).toHaveLength(2);
    expect((result[0] as any)._environment).toBe('alpha');
    expect((result[1] as any)._environment).toBe('beta');
    expect(result[0].type).toBe('task:ready');
    expect(result[1].type).toBe('task:done');
  });

  it('colonies() returns colony info from the provided function', () => {
    const source = new LocalDashboardSource(eventBus, [], () => [
      {
        name: 'worker', state: 'running', activeCount: 2, concurrency: 5,
        stats: { signalsSensed: 10, signalsClaimed: 8, signalsProcessed: 7, signalsDeposited: 3, claimConflicts: 1, errors: 0, avgProcessingMs: 42 },
      },
    ]);

    const colonies = source.colonies();
    expect(colonies).toHaveLength(1);
    expect(colonies[0].name).toBe('worker');
    expect(colonies[0].stats.signalsSensed).toBe(10);
  });

  it('environments() returns environment names', () => {
    const source = new LocalDashboardSource(eventBus, [stubEnv('one'), stubEnv('two')], () => []);
    expect(source.environments()).toEqual(['one', 'two']);
  });

  it('deposit() routes to named environment', async () => {
    const env1 = stubEnv('alpha');
    const env2 = stubEnv('beta');
    const source = new LocalDashboardSource(eventBus, [env1, env2], () => []);

    const signal = await source.deposit('task:new', { x: 1 }, 'beta');
    expect(signal.type).toBe('task:new');
  });

  it('deposit() defaults to first environment when no name given', async () => {
    const env1 = stubEnv('alpha');
    const env2 = stubEnv('beta');
    const source = new LocalDashboardSource(eventBus, [env1, env2], () => []);

    const signal = await source.deposit('task:new', { x: 1 });
    expect(signal.type).toBe('task:new');
  });

  it('deposit() falls back to first environment when name not found', async () => {
    const env1 = stubEnv('alpha');
    const source = new LocalDashboardSource(eventBus, [env1], () => []);

    const signal = await source.deposit('task:new', {}, 'nonexistent');
    expect(signal.type).toBe('task:new');
  });

  it('onEvent() forwards EventBus events', () => {
    const source = new LocalDashboardSource(eventBus, [], () => []);
    const received: RuntimeEventData[] = [];
    source.onEvent(e => received.push(e));

    const event = makeEvent('test-colony');
    eventBus.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0].colony).toBe('test-colony');
  });

  it('bufferedEvents returns events passed at construction', () => {
    const events = [makeEvent('a'), makeEvent('b')];
    const source = new LocalDashboardSource(eventBus, [], () => [], events);
    expect(source.bufferedEvents).toHaveLength(2);
    expect(source.bufferedEvents[0].colony).toBe('a');
  });

  it('close() is a no-op and does not throw', () => {
    const source = new LocalDashboardSource(eventBus, [], () => []);
    expect(() => source.close()).not.toThrow();
  });
});

// ── startDashboard HTTP endpoint tests ───────────────────────

describe('startDashboard HTTP endpoints', () => {
  let eventBus: EventBus;
  let port: number;
  let baseUrl: string;
  // Store original process handlers so we can clean up
  const originalExit = process.exit;

  beforeEach(async () => {
    eventBus = new EventBus();
    // Use random port to avoid conflicts
    port = 14000 + Math.floor(Math.random() * 1000);
    baseUrl = `http://localhost:${port}`;

    // Prevent process.exit from killing the test runner
    process.exit = (() => {}) as any;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  async function startServer(envs?: Environment[], colonyInfoFn?: () => any[]) {
    const sig = makeSignal('task:ready', { name: 'test' });
    const environments = envs ?? [stubEnv('test-env', [sig])];
    const source = new LocalDashboardSource(
      eventBus,
      environments,
      colonyInfoFn ?? (() => [{
        name: 'test-colony', state: 'running', activeCount: 1, concurrency: 3,
        stats: { signalsSensed: 5, signalsClaimed: 4, signalsProcessed: 3, signalsDeposited: 2, claimConflicts: 0, errors: 0, avgProcessingMs: 10 },
      }]),
    );

    // Start dashboard without opening browser
    const serverPromise = startDashboard(source, { port, open: false });
    // Give server time to start
    await sleep(200);
    return { source, serverPromise };
  }

  it('GET /api/state returns signal snapshot', async () => {
    await startServer();

    const res = await fetch(`${baseUrl}/api/state`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.signals).toBeInstanceOf(Array);
    expect(body.signals.length).toBeGreaterThan(0);
    expect(body.signals[0]._environment).toBe('test-env');
  });

  it('GET /api/colonies returns colony info', async () => {
    await startServer();

    const res = await fetch(`${baseUrl}/api/colonies`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.colonies).toHaveLength(1);
    expect(body.colonies[0].name).toBe('test-colony');
    expect(body.colonies[0].state).toBe('running');
    expect(body.colonies[0].stats.signalsSensed).toBe(5);
  });

  it('GET /api/stats returns stats per colony', async () => {
    await startServer();

    const res = await fetch(`${baseUrl}/api/stats`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.stats).toHaveLength(1);
    expect(body.stats[0].name).toBe('test-colony');
    expect(body.stats[0].signalsProcessed).toBe(3);
  });

  it('GET /api/environments returns environment names', async () => {
    await startServer();

    const res = await fetch(`${baseUrl}/api/environments`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.environments).toEqual([{ name: 'test-env' }]);
  });

  it('GET /api/events returns recent events', async () => {
    await startServer();

    // Emit an event
    eventBus.emit(makeEvent('my-colony', 'colony:started'));
    await sleep(50);

    const res = await fetch(`${baseUrl}/api/events`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.some((e: any) => e.colony === 'my-colony')).toBe(true);
  });

  it('POST /api/signals deposits a signal', async () => {
    await startServer();

    const res = await fetch(`${baseUrl}/api/signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'task:new', payload: { task: 'hello' } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.signal.type).toBe('task:new');
  });

  it('GET / returns HTML dashboard', async () => {
    await startServer();

    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('mandible');
  });

  it('GET /unknown returns 404', async () => {
    await startServer();

    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });

  it('OPTIONS returns 204 (CORS preflight)', async () => {
    await startServer();

    const res = await fetch(`${baseUrl}/api/state`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });
});

// ── startDashboard WebSocket tests ───────────────────────────

describe('startDashboard WebSocket', () => {
  let eventBus: EventBus;
  let port: number;
  const originalExit = process.exit;

  beforeEach(async () => {
    eventBus = new EventBus();
    port = 15000 + Math.floor(Math.random() * 1000);
    process.exit = (() => {}) as any;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it('sends init with buffered events on connect', async () => {
    const buffered = [makeEvent('init-colony', 'colony:started')];
    const source = new LocalDashboardSource(
      eventBus,
      [stubEnv('ws-env')],
      () => [],
      buffered,
    );

    startDashboard(source, { port, open: false });
    await sleep(200);

    const ws = new WebSocket(`ws://localhost:${port}`);
    const initMsg = await new Promise<any>((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'init') resolve(msg);
      });
    });

    expect(initMsg.type).toBe('init');
    expect(initMsg.events).toBeInstanceOf(Array);
    expect(initMsg.events.length).toBeGreaterThanOrEqual(1);
    expect(initMsg.events.some((e: any) => e.colony === 'init-colony')).toBe(true);

    ws.close();
    await sleep(50);
  });

  it('broadcasts events from source to connected clients', async () => {
    const source = new LocalDashboardSource(eventBus, [stubEnv('ws-env')], () => []);

    startDashboard(source, { port, open: false });
    await sleep(200);

    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    // Skip init message
    await new Promise<void>((resolve) => {
      ws.on('message', () => resolve());
    });

    // Emit an event
    const eventPromise = new Promise<any>((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'event') resolve(msg);
      });
    });

    eventBus.emit(makeEvent('live-colony', 'action:started'));
    const eventMsg = await eventPromise;

    expect(eventMsg.type).toBe('event');
    expect(eventMsg.data.colony).toBe('live-colony');
    expect(eventMsg.data.type).toBe('action:started');

    ws.close();
    await sleep(50);
  });
});
