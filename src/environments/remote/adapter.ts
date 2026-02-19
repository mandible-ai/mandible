// ============================================================
// Remote Environment Adapter
// ============================================================
// Implements the Environment interface over WebSocket.
// Connects to any compatible signal server (hosted or self-hosted).
//
// From a colony's perspective, this is identical to
// FilesystemEnvironment — it deposits, observes, claims.
// The network transport is invisible.
// ============================================================

import { WebSocket } from 'ws';
import type {
  Environment,
  Signal,
  SignalQuery,
  Subscription,
  DecayResult,
  SignalMeta,
} from '../../core/types.js';
import type { RuntimeEventData } from '../../core/events.js';
import type {
  ClientMessage,
  ServerMessage,
  ResultMessage,
  ErrorMessage,
  SignalPush,
  SerializableSignalQuery,
} from './protocol.js';

export interface RemoteEnvConfig {
  url: string;
  apiKey: string;
  project: string;
  colony?: string;
  publicKey?: string;
  name?: string;
  /** Connection timeout in ms. Default: 10_000 */
  connectTimeout?: number;
  /** Request timeout in ms. Default: 30_000 */
  requestTimeout?: number;
  /** Whether to auto-reconnect on disconnect. Default: true */
  autoReconnect?: boolean;
  /** Max reconnect attempts. Default: Infinity */
  maxReconnectAttempts?: number;
}

type PendingRequest = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type SubscriptionEntry = {
  query: SerializableSignalQuery;
  callback: (signal: Signal) => void;
  serverSubId?: string;
};

export class RemoteEnvironment implements Environment {
  readonly name: string;
  private config: Required<
    Pick<RemoteEnvConfig, 'url' | 'apiKey' | 'project' | 'connectTimeout' | 'requestTimeout' | 'autoReconnect' | 'maxReconnectAttempts'>
  > & Pick<RemoteEnvConfig, 'colony' | 'publicKey'>;

  private ws: WebSocket | null = null;
  private authenticated = false;
  private pending = new Map<string, PendingRequest>();
  private subscriptions = new Map<string, SubscriptionEntry>();
  private idCounter = 0;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connectPromise: Promise<void> | null = null;
  private closed = false;

  constructor(config: RemoteEnvConfig) {
    this.name = config.name ?? `remote:${config.project}`;
    this.config = {
      url: config.url,
      apiKey: config.apiKey,
      project: config.project,
      colony: config.colony,
      publicKey: config.publicKey,
      connectTimeout: config.connectTimeout ?? 10_000,
      requestTimeout: config.requestTimeout ?? 30_000,
      autoReconnect: config.autoReconnect ?? true,
      maxReconnectAttempts: config.maxReconnectAttempts ?? Infinity,
    };
  }

  // ----------------------------------------------------------
  // Connection management
  // ----------------------------------------------------------

  private nextId(): string {
    return `req_${++this.idCounter}_${Date.now().toString(36)}`;
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.authenticated) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection to ${this.config.url} timed out`));
        this.ws?.close();
      }, this.config.connectTimeout);

      this.ws = new WebSocket(this.config.url);

      this.ws.on('open', async () => {
        clearTimeout(timeout);
        try {
          await this.authenticate();
          this.reconnectAttempts = 0;
          await this.resubscribeAll();
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('close', () => {
        this.authenticated = false;
        this.rejectAllPending('Connection closed');
        if (this.config.autoReconnect && !this.closed) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        if (!this.authenticated) {
          reject(err);
        }
      });
    });
  }

  private async authenticate(): Promise<void> {
    const msg: ClientMessage = {
      type: 'auth',
      apiKey: this.config.apiKey,
      project: this.config.project,
      colony: this.config.colony,
      publicKey: this.config.publicKey,
    };
    this.send(msg);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Auth timeout')), 5_000);
      const handler = (data: Buffer) => {
        const parsed = JSON.parse(data.toString()) as ServerMessage;
        if (parsed.type === 'authenticated') {
          clearTimeout(timeout);
          this.authenticated = true;
          this.ws?.removeListener('message', handler);
          resolve();
        } else if (parsed.type === 'error' && (parsed as ErrorMessage).code === 'AUTH_FAILED') {
          clearTimeout(timeout);
          this.ws?.removeListener('message', handler);
          reject(new Error(`Authentication failed: ${(parsed as ErrorMessage).message}`));
        }
      };
      this.ws!.on('message', handler);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {});
    }, delay);
  }

  private async resubscribeAll(): Promise<void> {
    for (const [clientSubId, entry] of this.subscriptions) {
      try {
        const result = await this.request<{ subscriptionId: string }>({
          type: 'subscribe',
          id: this.nextId(),
          query: entry.query,
        });
        entry.serverSubId = result.subscriptionId;
      } catch {
        // Subscription will be retried on next reconnect
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.rejectAllPending('Environment closed');
    this.subscriptions.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ----------------------------------------------------------
  // Message handling
  // ----------------------------------------------------------

  private send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to signal server');
    }
    this.ws.send(JSON.stringify(msg));
  }

  private handleMessage(data: Buffer): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'result' || msg.type === 'error') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);

      if (msg.type === 'error') {
        pending.reject(new Error(`[${msg.code}] ${msg.message}`));
      } else {
        pending.resolve(msg.data);
      }
    } else if (msg.type === 'signal') {
      const push = msg as SignalPush;
      for (const entry of this.subscriptions.values()) {
        if (entry.serverSubId === push.subscriptionId) {
          try { entry.callback(push.signal); } catch { /* don't crash */ }
        }
      }
    }
  }

  private request<T>(msg: ClientMessage & { id: string }): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error(`Request ${msg.type} timed out after ${this.config.requestTimeout}ms`));
      }, this.config.requestTimeout);

      this.pending.set(msg.id, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      });

      try {
        this.send(msg);
      } catch (err) {
        this.pending.delete(msg.id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.authenticated) return;
    await this.connect();
  }

  // ----------------------------------------------------------
  // Environment interface
  // ----------------------------------------------------------

  async observe(query: SignalQuery): Promise<Signal[]> {
    await this.ensureConnected();
    const result = await this.request<Signal[] | null>({
      type: 'observe',
      id: this.nextId(),
      query: toSerializableQuery(query),
    });
    return result ?? [];
  }

  async deposit(
    input: Omit<Signal, 'id' | 'meta'> & { meta?: Partial<SignalMeta> }
  ): Promise<Signal> {
    await this.ensureConnected();
    return this.request<Signal>({
      type: 'deposit',
      id: this.nextId(),
      signal: {
        type: input.type,
        payload: input.payload as Record<string, unknown>,
        meta: input.meta ? {
          deposited_by: input.meta.deposited_by,
          concentration: input.meta.concentration,
          ttl: input.meta.ttl,
          tags: input.meta.tags,
          caused_by: input.meta.caused_by,
          signature: input.meta.signature,
          signer: input.meta.signer,
        } : undefined,
      },
    });
  }

  async withdraw(signalId: string): Promise<void> {
    await this.ensureConnected();
    await this.request<void>({
      type: 'withdraw',
      id: this.nextId(),
      signalId,
    });
  }

  async claim(
    signalId: string,
    claimant: string,
    leaseDuration?: number
  ): Promise<boolean> {
    await this.ensureConnected();
    return this.request<boolean>({
      type: 'claim',
      id: this.nextId(),
      signalId,
      claimant,
      leaseDuration,
    });
  }

  async release(signalId: string): Promise<void> {
    await this.ensureConnected();
    await this.request<void>({
      type: 'release',
      id: this.nextId(),
      signalId,
    });
  }

  watch(query: SignalQuery, callback: (signal: Signal) => void): Subscription {
    const clientSubId = `sub_${++this.idCounter}`;
    const entry: SubscriptionEntry = {
      query: toSerializableQuery(query),
      callback,
    };
    this.subscriptions.set(clientSubId, entry);

    // Send subscribe request (async, fire-and-forget from caller's perspective)
    this.ensureConnected().then(() => {
      return this.request<{ subscriptionId: string }>({
        type: 'subscribe',
        id: this.nextId(),
        query: entry.query,
      });
    }).then((result) => {
      entry.serverSubId = result.subscriptionId;
    }).catch(() => {
      // Will be retried on reconnect
    });

    return {
      unsubscribe: () => {
        const sub = this.subscriptions.get(clientSubId);
        this.subscriptions.delete(clientSubId);
        if (sub?.serverSubId && this.ws?.readyState === WebSocket.OPEN) {
          this.send({
            type: 'unsubscribe',
            id: this.nextId(),
            subscriptionId: sub.serverSubId,
          });
        }
      },
    };
  }

  async history(
    query: SignalQuery & { includeWithdrawn?: boolean }
  ): Promise<Signal[]> {
    await this.ensureConnected();
    const result = await this.request<Signal[] | null>({
      type: 'history',
      id: this.nextId(),
      query: {
        ...toSerializableQuery(query),
        includeWithdrawn: query.includeWithdrawn,
      },
    });
    return result ?? [];
  }

  async decay(): Promise<DecayResult> {
    await this.ensureConnected();
    return this.request<DecayResult>({
      type: 'decay',
      id: this.nextId(),
    });
  }

  async snapshot(): Promise<Signal[]> {
    await this.ensureConnected();
    const result = await this.request<Signal[] | null>({
      type: 'snapshot',
      id: this.nextId(),
    });
    return result ?? [];
  }

  // ----------------------------------------------------------
  // Event forwarding (colony → signal server → dashboard)
  // ----------------------------------------------------------

  emitEvent(event: RuntimeEventData): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.send({ type: 'event', data: event });
    } catch { /* best effort */ }
  }
}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

function toSerializableQuery(query: SignalQuery): SerializableSignalQuery {
  return {
    type: query.type,
    minConcentration: query.minConcentration,
    unclaimed: query.unclaimed,
    tags: query.tags,
    after: query.after,
    limit: query.limit,
    // Note: query.filter (function) is dropped — cannot serialize
  };
}
