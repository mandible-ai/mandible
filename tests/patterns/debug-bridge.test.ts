// PURPOSE: Tests for the DebugBridge pattern
// PURPOSE: Covers auth, subscribe, bridging, dedup, stats, callbacks, reconnect, stop, error handling

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDebugBridge } from '../../src/patterns/debug-bridge.js';
import { FilesystemEnvironment } from '../../src/environments/filesystem/adapter.js';
import type { Environment, Signal } from '../../src/core/types.js';

// ── Helpers ─────────────────────────────────────────────────

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** Create a mock signal server that handles auth and subscribe. */
function createMockServer(): {
  server: WebSocketServer;
  port: number;
  url: string;
  clients: WsWebSocket[];
  receivedMessages: any[];
  pushSignal: (signal: Partial<Signal>) => void;
  ready: Promise<void>;
} {
  const server = new WebSocketServer({ port: 0 });
  const clients: WsWebSocket[] = [];
  const receivedMessages: any[] = [];
  let resolveReady: () => void;
  const ready = new Promise<void>((r) => { resolveReady = r; });

  server.on('listening', () => resolveReady());

  server.on('connection', (ws) => {
    clients.push(ws);

    ws.on('message', (raw: Buffer | string) => {
      const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      receivedMessages.push(msg);

      if (msg.type === 'auth') {
        ws.send(JSON.stringify({ type: 'authenticated' }));
      } else if (msg.type === 'subscribe') {
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true }));
      }
    });
  });

  const addr = server.address() as { port: number };

  function pushSignal(signal: Partial<Signal>) {
    const full: Signal = {
      id: signal.id ?? `sig-${Date.now()}`,
      type: signal.type ?? 'test:signal',
      payload: signal.payload ?? { data: 'hello' },
      meta: {
        deposited_at: Date.now(),
        deposited_by: signal.meta?.deposited_by ?? 'console',
        concentration: 1.0,
        ...signal.meta,
      },
    };
    for (const client of clients) {
      if (client.readyState === WsWebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'signal', signal: full }));
      }
    }
  }

  return {
    server,
    get port() { return (server.address() as { port: number }).port; },
    get url() { return `ws://127.0.0.1:${(server.address() as { port: number }).port}`; },
    clients,
    receivedMessages,
    pushSignal,
    ready,
  };
}

// ── Test state ──────────────────────────────────────────────

let mock: ReturnType<typeof createMockServer>;
let env: FilesystemEnvironment;
let root: string;

beforeEach(async () => {
  root = join(tmpdir(), `mandible-db-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  env = new FilesystemEnvironment({ root, name: 'test-env' });
  mock = createMockServer();
  await mock.ready;
});

afterEach(async () => {
  mock.server.close();
  // Give ws time to clean up
  await sleep(50);
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

// ── Tests ───────────────────────────────────────────────────

describe('DebugBridge', () => {
  it('connects and authenticates', async () => {
    const bridge = createDebugBridge({
      url: mock.url,
      apiKey: 'test-key',
      project: 'test-project',
      environment: env,
    });

    await bridge.start();
    expect(bridge.running).toBe(true);

    const authMsg = mock.receivedMessages.find((m) => m.type === 'auth');
    expect(authMsg).toBeDefined();
    expect(authMsg.apiKey).toBe('test-key');
    expect(authMsg.project).toBe('test-project');

    await bridge.stop();
  });

  it('subscribes to signals after auth', async () => {
    const bridge = createDebugBridge({
      url: mock.url,
      apiKey: 'test-key',
      project: 'test-project',
      environment: env,
      signalTypes: ['task:*', 'review:*'],
    });

    await bridge.start();

    const subMsg = mock.receivedMessages.find((m) => m.type === 'subscribe');
    expect(subMsg).toBeDefined();
    expect(subMsg.query.type).toEqual(['task:*', 'review:*']);

    await bridge.stop();
  });

  it('sends single string when only one signal type', async () => {
    const bridge = createDebugBridge({
      url: mock.url,
      apiKey: 'test-key',
      project: 'test-project',
      environment: env,
      signalTypes: ['task:*'],
    });

    await bridge.start();

    const subMsg = mock.receivedMessages.find((m) => m.type === 'subscribe');
    expect(subMsg.query.type).toBe('task:*');

    await bridge.stop();
  });

  it('bridges inbound signal to environment', async () => {
    const bridge = createDebugBridge({
      url: mock.url,
      apiKey: 'test-key',
      project: 'test-project',
      environment: env,
    });

    await bridge.start();

    mock.pushSignal({
      id: 'sig-001',
      type: 'task:ready',
      payload: { name: 'test-task' },
    });

    // Wait for the deposit to propagate
    await sleep(200);

    const signals = await env.observe({ type: 'task:ready' });
    expect(signals.length).toBe(1);
    expect(signals[0].payload).toEqual({ name: 'test-task' });

    await bridge.stop();
  });

  it('deduplicates signals', async () => {
    const bridge = createDebugBridge({
      url: mock.url,
      apiKey: 'test-key',
      project: 'test-project',
      environment: env,
    });

    await bridge.start();

    // Push same signal ID twice
    mock.pushSignal({ id: 'dup-001', type: 'task:ready', payload: { n: 1 } });
    await sleep(100);
    mock.pushSignal({ id: 'dup-001', type: 'task:ready', payload: { n: 2 } });
    await sleep(200);

    const signals = await env.observe({ type: 'task:ready' });
    expect(signals.length).toBe(1);

    await bridge.stop();
  });

  it('tracks stats', async () => {
    const bridge = createDebugBridge({
      url: mock.url,
      apiKey: 'test-key',
      project: 'test-project',
      environment: env,
    });

    await bridge.start();

    expect(bridge.stats.signalsBridged).toBe(0);
    expect(bridge.stats.lastBridgedAt).toBeUndefined();

    mock.pushSignal({ id: 'stat-001', type: 'task:a' });
    mock.pushSignal({ id: 'stat-002', type: 'task:b' });

    await sleep(300);

    expect(bridge.stats.signalsBridged).toBe(2);
    expect(bridge.stats.lastBridgedAt).toBeGreaterThan(0);
    expect(bridge.stats.errors).toBe(0);

    await bridge.stop();
  });

  it('calls onBridged callback', async () => {
    const bridged: Signal[] = [];

    const bridge = createDebugBridge({
      url: mock.url,
      apiKey: 'test-key',
      project: 'test-project',
      environment: env,
      onBridged: (sig) => bridged.push(sig),
    });

    await bridge.start();

    mock.pushSignal({ id: 'cb-001', type: 'task:ready', payload: { x: 42 } });
    await sleep(200);

    expect(bridged.length).toBe(1);
    expect(bridged[0].type).toBe('task:ready');
    expect(bridged[0].id).toBe('cb-001');

    await bridge.stop();
  });

  it('reconnects on disconnect', async () => {
    const bridge = createDebugBridge({
      url: mock.url,
      apiKey: 'test-key',
      project: 'test-project',
      environment: env,
      reconnect: true,
    });

    await bridge.start();
    expect(bridge.running).toBe(true);

    // Close the server-side connection to trigger reconnect
    for (const client of mock.clients) {
      client.close();
    }
    mock.clients.length = 0;
    mock.receivedMessages.length = 0;

    // Wait for reconnect (1s backoff + connection time)
    await sleep(2000);

    // Should have re-authenticated
    const authMsgs = mock.receivedMessages.filter((m) => m.type === 'auth');
    expect(authMsgs.length).toBeGreaterThanOrEqual(1);

    await bridge.stop();
  });

  it('stop() disconnects cleanly with no reconnect', async () => {
    const bridge = createDebugBridge({
      url: mock.url,
      apiKey: 'test-key',
      project: 'test-project',
      environment: env,
    });

    await bridge.start();
    expect(bridge.running).toBe(true);

    await bridge.stop();
    expect(bridge.running).toBe(false);

    // Clear messages and wait — should NOT see any new auth attempts
    mock.receivedMessages.length = 0;
    await sleep(500);
    const authMsgs = mock.receivedMessages.filter((m) => m.type === 'auth');
    expect(authMsgs.length).toBe(0);
  });

  it('handles deposit errors gracefully', async () => {
    const errors: Error[] = [];

    // Create a mock environment that throws on deposit
    const failEnv: Environment = {
      name: 'fail-env',
      observe: async () => [],
      deposit: async () => { throw new Error('deposit boom'); },
      withdraw: async () => {},
      claim: async () => false,
      release: async () => {},
      watch: () => ({ unsubscribe: () => {} }),
      history: async () => [],
      decay: async () => ({ decayed: 0, evaporated: 0, claimsReleased: 0 }),
      snapshot: async () => [],
    };

    const bridge = createDebugBridge({
      url: mock.url,
      apiKey: 'test-key',
      project: 'test-project',
      environment: failEnv,
      onError: (err) => errors.push(err),
    });

    await bridge.start();

    mock.pushSignal({ id: 'fail-001', type: 'task:ready' });
    await sleep(200);

    expect(bridge.stats.errors).toBeGreaterThanOrEqual(1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toBe('deposit boom');

    // Bridge should still be running
    expect(bridge.running).toBe(true);

    await bridge.stop();
  });

  it('rejects start() on connection timeout', async () => {
    // Use a port that nobody listens on
    const bridge = createDebugBridge({
      url: 'ws://127.0.0.1:1',
      apiKey: 'test-key',
      project: 'test-project',
      environment: env,
      connectTimeout: 500,
    });

    await expect(bridge.start()).rejects.toThrow();
  });
});
