// PURPOSE: DebugBridge — one-way gate from signal server to a local environment.
// PURPOSE: Enables ad-hoc testing: console deposits a signal → bridge carries it into the colony's real environment.

import type { Signal, Environment } from '../core/types.js';
import type { BridgeStats } from './bridge.js';
import WebSocket from 'ws';

export interface DebugBridgeConfig {
  /** Human-readable name for this bridge instance */
  name?: string;

  /** Signal server WebSocket URL */
  url: string;

  /** API key for signal server authentication */
  apiKey: string;

  /** Project ID for signal isolation */
  project: string;

  /** Target environment — inbound signals are deposited here */
  environment: Environment;

  /** Signal type filter patterns sent to the signal server (default: ['*']) */
  signalTypes?: string[];

  /** Auto-reconnect on disconnect (default: true) */
  reconnect?: boolean;

  /** Callback when a signal is successfully bridged */
  onBridged?: (signal: Signal) => void;

  /** Callback on errors */
  onError?: (error: Error) => void;

  /** Connection timeout in ms (default: 10000) */
  connectTimeout?: number;
}

export interface DebugBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly running: boolean;
  readonly stats: BridgeStats;
}

const PING_INTERVAL = 30_000;
const PONG_TIMEOUT = 10_000;
const MAX_BACKOFF = 30_000;
const MAX_TRACKED = 10_000;
const DEFAULT_CONNECT_TIMEOUT = 10_000;

/**
 * Create a debug bridge that subscribes to signals from a signal server
 * and deposits them into a local environment.
 *
 * This is a one-way gate: signal server → environment. It enables ad-hoc
 * testing from the cloud console's deposit drawer.
 *
 * Usage:
 *   const bridge = createDebugBridge({
 *     url: 'ws://localhost:8080/ws',
 *     apiKey: 'mnd_...',
 *     project: 'my-project',
 *     environment: localEnv,
 *   });
 *   await bridge.start();
 */
export function createDebugBridge(config: DebugBridgeConfig): DebugBridge {
  const name = config.name ?? 'debug-bridge';
  const signalTypes = config.signalTypes ?? ['*'];
  const shouldReconnect = config.reconnect !== false;
  const connectTimeout = config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;

  let running = false;
  let intentionalClose = false;
  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let msgCounter = 0;
  let pendingSubId: string | null = null;

  // Dedup set — prevents re-depositing the same signal on reconnect
  const bridgedIds = new Set<string>();

  const stats: BridgeStats = {
    signalsBridged: 0,
    signalsFiltered: 0,
    errors: 0,
  };

  function trackBridged(id: string) {
    bridgedIds.add(id);
    if (bridgedIds.size > MAX_TRACKED) {
      const iter = bridgedIds.values();
      for (let i = 0; i < MAX_TRACKED / 2; i++) {
        bridgedIds.delete(iter.next().value!);
      }
    }
  }

  function clearTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function scheduleReconnect() {
    if (intentionalClose || !shouldReconnect) return;
    const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF);
    attempt++;
    reconnectTimer = setTimeout(() => {
      if (!intentionalClose && running) {
        connectWs();
      }
    }, delay);
  }

  function connectWs(onAuthenticated?: () => void, onFailed?: (err: Error) => void) {
    const socket = new WebSocket(config.url);
    ws = socket;

    socket.on('open', () => {
      attempt = 0;
      socket.send(JSON.stringify({ type: 'auth', apiKey: config.apiKey, project: config.project }));
    });

    socket.on('message', (raw: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch { return; }

      if (msg.type === 'authenticated') {
        // Start keepalive pings
        pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.ping();
            pongTimer = setTimeout(() => {
              socket.terminate();
            }, PONG_TIMEOUT);
          }
        }, PING_INTERVAL);

        // Subscribe to inbound signals — wait for server ack before resolving
        const subId = `debug_bridge_${++msgCounter}`;
        pendingSubId = subId;
        socket.send(JSON.stringify({
          type: 'subscribe',
          id: subId,
          query: { type: signalTypes.length === 1 ? signalTypes[0] : signalTypes },
        }));
      } else if (msg.type === 'result' && msg.id === pendingSubId) {
        pendingSubId = null;
        onAuthenticated?.();
      } else if (msg.type === 'signal' && msg.signal) {
        const sig = msg.signal as Signal;
        if (bridgedIds.has(sig.id)) return;

        trackBridged(sig.id);

        config.environment.deposit({
          type: sig.type,
          payload: sig.payload,
          meta: {
            deposited_by: sig.meta?.deposited_by ?? 'console',
            tags: sig.meta?.tags,
            caused_by: sig.meta?.caused_by,
            ...(sig.meta?.ttl != null && { ttl: sig.meta.ttl }),
          },
        }).then(() => {
          stats.signalsBridged++;
          stats.lastBridgedAt = Date.now();
          config.onBridged?.(sig);
        }).catch((err: any) => {
          stats.errors++;
          config.onError?.(err instanceof Error ? err : new Error(String(err)));
        });
      } else if (msg.type === 'error') {
        const err = new Error(`signal server error: ${msg.code} — ${msg.message}`);
        stats.errors++;
        config.onError?.(err);
      }
    });

    socket.on('pong', () => {
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    });

    socket.on('error', (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      stats.errors++;
      config.onError?.(error);
      onFailed?.(error);
    });

    socket.on('close', () => {
      clearTimers();
      ws = null;
      if (!intentionalClose && running) {
        scheduleReconnect();
      }
    });
  }

  return {
    start(): Promise<void> {
      if (running) return Promise.resolve();
      running = true;
      intentionalClose = false;
      attempt = 0;

      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`[debug-bridge:${name}] connection timeout after ${connectTimeout}ms`));
          }
        }, connectTimeout);

        connectWs(
          () => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve();
            }
          },
          (err) => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(err);
            }
          },
        );
      });
    },

    async stop(): Promise<void> {
      if (!running) return;
      running = false;
      intentionalClose = true;
      clearTimers();
      if (ws) {
        ws.close();
        ws = null;
      }
    },

    get running() {
      return running;
    },

    get stats() {
      return { ...stats };
    },
  };
}
