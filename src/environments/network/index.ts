// PURPOSE: NetworkEnvironment — Environment backed by the signal server over WebSocket.
// PURPOSE: Enables colonies in separate zones to share signals through a common signal server substrate.

import type {
  Environment, Signal, SignalQuery, SignalMeta, Subscription, DecayResult,
} from '../../core/types.js';
import WebSocket from 'ws';

export interface NetworkEnvironmentConfig {
  /** Signal server WebSocket URL */
  url: string;
  /** API key for authentication */
  apiKey: string;
  /** Project ID for signal isolation */
  project: string;
  /** Human-readable environment name (default: 'network') */
  name?: string;
  /** Auto-reconnect on disconnect (default: true) */
  reconnect?: boolean;
  /** Connection timeout in ms (default: 10000) */
  connectTimeout?: number;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PING_INTERVAL = 30_000;
const PONG_TIMEOUT = 10_000;
const MAX_BACKOFF = 30_000;
const REQUEST_TIMEOUT = 30_000;
const DEFAULT_CONNECT_TIMEOUT = 10_000;

export class NetworkEnvironment implements Environment {
  readonly name: string;
  readonly url: string;
  readonly apiKey: string;
  readonly project: string;

  private shouldReconnect: boolean;
  private connectTimeout: number;
  private ws: WebSocket | null = null;
  private connected = false;
  private intentionalClose = false;
  private attempt = 0;
  private msgCounter = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private subscriptions = new Map<string, (signal: Signal) => void>();
  private connectPromise: Promise<void> | null = null;

  constructor(config: NetworkEnvironmentConfig) {
    this.name = config.name ?? 'network';
    this.url = config.url;
    this.apiKey = config.apiKey;
    this.project = config.project;
    this.shouldReconnect = config.reconnect !== false;
    this.connectTimeout = config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
  }

  // ----------------------------------------------------------
  // Connection lifecycle
  // ----------------------------------------------------------

  private ensureConnected(): Promise<void> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect();
    return this.connectPromise;
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          reject(new Error(`[NetworkEnvironment:${this.name}] connection timeout after ${this.connectTimeout}ms`));
        }
      }, this.connectTimeout);

      this.connectWs(
        () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            this.connectPromise = null;
            resolve();
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            this.connectPromise = null;
            reject(err);
          }
        },
      );
    });
  }

  private connectWs(onAuthenticated?: () => void, onFailed?: (err: Error) => void) {
    this.intentionalClose = false;
    const socket = new WebSocket(this.url);
    this.ws = socket;

    socket.on('open', () => {
      this.attempt = 0;
      socket.send(JSON.stringify({ type: 'auth', apiKey: this.apiKey, project: this.project }));
    });

    socket.on('message', (raw: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch { return; }

      if (msg.type === 'authenticated') {
        this.connected = true;
        this.startKeepalive(socket);
        onAuthenticated?.();
      } else if (msg.type === 'result' && msg.id) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);
          clearTimeout(pending.timer);
          pending.resolve(msg.data);
        }
      } else if (msg.type === 'error' && msg.id) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          this.pendingRequests.delete(msg.id);
          clearTimeout(pending.timer);
          pending.reject(new Error(`${msg.code ?? 'UNKNOWN'}: ${msg.message ?? 'Unknown error'}`));
        }
      } else if (msg.type === 'error' && !msg.id) {
        // Broadcast error (e.g. AUTH_FAILED)
        const err = new Error(`${msg.code ?? 'UNKNOWN'}: ${msg.message ?? 'Unknown error'}`);
        onFailed?.(err);
      } else if (msg.type === 'signal' && msg.signal) {
        // Push notification from a subscription
        const signal = msg.signal as Signal;
        const subId = msg.subscriptionId as string | undefined;
        if (subId && this.subscriptions.has(subId)) {
          this.subscriptions.get(subId)!(signal);
        } else {
          // Broadcast to all subscriptions (server may not include subscriptionId)
          for (const cb of this.subscriptions.values()) {
            cb(signal);
          }
        }
      }
    });

    socket.on('pong', () => {
      if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    });

    socket.on('error', (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      onFailed?.(error);
    });

    socket.on('close', () => {
      this.clearTimers();
      this.connected = false;
      this.ws = null;
      this.rejectAllPending('WebSocket closed');
      if (!this.intentionalClose && this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });
  }

  private startKeepalive(socket: WebSocket) {
    this.pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.ping();
        this.pongTimer = setTimeout(() => {
          socket.terminate();
        }, PONG_TIMEOUT);
      }
    }, PING_INTERVAL);
  }

  private clearTimers() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** this.attempt, MAX_BACKOFF);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      if (!this.intentionalClose) {
        this.connectPromise = this.connect();
      }
    }, delay);
  }

  private rejectAllPending(reason: string) {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  // ----------------------------------------------------------
  // RPC helpers
  // ----------------------------------------------------------

  private nextId(): string {
    return `net_${++this.msgCounter}`;
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private request<T>(msg: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextId();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out: ${msg.type}`));
      }, REQUEST_TIMEOUT);
      this.pendingRequests.set(id, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      });
      this.send({ ...msg, id });
    });
  }

  // ----------------------------------------------------------
  // Environment interface
  // ----------------------------------------------------------

  async deposit(
    input: Omit<Signal, 'id' | 'meta'> & { meta?: Partial<SignalMeta> },
  ): Promise<Signal> {
    await this.ensureConnected();
    return this.request<Signal>({
      type: 'deposit',
      signal: {
        type: input.type,
        payload: input.payload,
        meta: input.meta,
      },
    });
  }

  async observe(query: SignalQuery): Promise<Signal[]> {
    await this.ensureConnected();
    // Strip function predicates — can't serialize to server
    const { filter, ...serializableQuery } = query;
    const signals = await this.request<Signal[]>({ type: 'observe', query: serializableQuery });
    // Apply local filter if provided
    return filter ? signals.filter(filter) : signals;
  }

  async withdraw(signalId: string): Promise<void> {
    await this.ensureConnected();
    await this.request<void>({ type: 'withdraw', signalId });
  }

  async claim(signalId: string, claimant: string, leaseDuration?: number): Promise<boolean> {
    await this.ensureConnected();
    return this.request<boolean>({ type: 'claim', signalId, claimant, leaseDuration });
  }

  async release(signalId: string): Promise<void> {
    await this.ensureConnected();
    await this.request<void>({ type: 'release', signalId });
  }

  watch(query: SignalQuery, callback: (signal: Signal) => void): Subscription {
    let subId: string | null = null;
    let active = true;

    const { filter, ...serializableQuery } = query;
    const wrappedCb = filter
      ? (signal: Signal) => { if (filter(signal)) callback(signal); }
      : callback;

    const setup = async () => {
      await this.ensureConnected();
      const result = await this.request<{ subscriptionId: string }>({
        type: 'subscribe',
        query: serializableQuery,
      });
      if (!active) {
        // Unsubscribed before subscribe completed
        this.request({ type: 'unsubscribe', subscriptionId: result.subscriptionId }).catch(() => {});
        return;
      }
      subId = result.subscriptionId;
      this.subscriptions.set(subId, wrappedCb);
    };

    setup().catch(() => {
      // Connection failed — watch silently fails, will work on reconnect
    });

    return {
      unsubscribe: () => {
        active = false;
        if (subId) {
          this.subscriptions.delete(subId);
          this.request({ type: 'unsubscribe', subscriptionId: subId }).catch(() => {});
        }
      },
    };
  }

  async history(query: SignalQuery & { includeWithdrawn?: boolean }): Promise<Signal[]> {
    await this.ensureConnected();
    const { filter, ...serializableQuery } = query;
    const signals = await this.request<Signal[]>({ type: 'history', query: serializableQuery });
    return filter ? signals.filter(filter) : signals;
  }

  async decay(): Promise<DecayResult> {
    await this.ensureConnected();
    return this.request<DecayResult>({ type: 'decay' });
  }

  async snapshot(): Promise<Signal[]> {
    await this.ensureConnected();
    return this.request<Signal[]>({ type: 'snapshot' });
  }

  // ----------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------

  /** Disconnect from the signal server and clean up. */
  close(): void {
    this.intentionalClose = true;
    this.clearTimers();
    this.rejectAllPending('NetworkEnvironment closed');
    this.subscriptions.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.connectPromise = null;
  }
}
