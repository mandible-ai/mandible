// ============================================================
// Colony Runtime — The Stigmergy Loop Engine
// ============================================================
// Implements the core loop:
//   sense → match rules → claim → execute action → deposit
//
// Each runtime manages one colony definition and handles:
//   - Sensor polling / watch subscriptions
//   - Rule evaluation and priority ordering
//   - Claim management (prevents duplicate work)
//   - Concurrent action execution (bounded by concurrency limit)
//   - Periodic decay sweeps
//   - Error handling and retries
// ============================================================

import type {
  ColonyDefinition,
  ColonyRuntime as IColonyRuntime,
  RuntimeState,
  RuntimeStats,
  RuntimeEvent,
  Signal,
  ActionContext,
  Rule,
  Subscription,
  DecayPolicy,
  HeartbeatConfig,
  ConcurrencyConfig,
} from './types.js';
import { prioritize } from './signal.js';
import { DEFAULT_DECAY_POLICY } from './types.js';
import { EventBus, type RuntimeEventData, type RuntimeEventCallback } from './events.js';
import { ColonyScaler } from './scaler.js';

type EventHandler = (...args: any[]) => void;

export class ColonyRuntime implements IColonyRuntime {
  private definition: ColonyDefinition;
  private _state: RuntimeState = 'idle';
  private _activeCount = 0;
  private _stats: RuntimeStats = {
    signalsSensed: 0,
    signalsClaimed: 0,
    signalsProcessed: 0,
    signalsDeposited: 0,
    claimConflicts: 0,
    errors: 0,
    avgProcessingMs: 0,
  };

  private _effectiveConcurrency: number;
  private pollTimers: ReturnType<typeof setInterval>[] = [];
  private watchSubscriptions: Subscription[] = [];
  private decayTimer?: ReturnType<typeof setInterval>;
  private scaler?: ColonyScaler;
  private eventHandlers = new Map<RuntimeEvent, Set<EventHandler>>();
  private processingSignals = new Set<string>(); // prevent double-processing
  private decayPolicy: DecayPolicy;
  private totalProcessingMs = 0;

  readonly events: EventBus;
  private _onEvent?: RuntimeEventCallback;

  constructor(
    definition: ColonyDefinition,
    options?: {
      decayPolicy?: Partial<DecayPolicy>;
      onEvent?: RuntimeEventCallback;
      eventBus?: EventBus;
    }
  ) {
    this.definition = definition;
    this._effectiveConcurrency = resolveConcurrency(definition.concurrency);
    const decayPolicy = options?.decayPolicy;
    this.decayPolicy = { ...DEFAULT_DECAY_POLICY, ...decayPolicy };
    this.events = options?.eventBus ?? new EventBus();
    this._onEvent = options?.onEvent;
  }

  get state(): RuntimeState { return this._state; }
  get activeCount(): number { return this._activeCount; }
  get concurrency(): number { return this._effectiveConcurrency; }
  get stats(): RuntimeStats { return { ...this._stats }; }
  get name(): string { return this.definition.name; }

  // ----------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------

  async start(): Promise<void> {
    if (this._state === 'running') return;
    this._state = 'running';
    this.emitEvent({ type: 'colony:started', colony: this.definition.name, timestamp: Date.now() });
    this.emit('colony:started', this.definition.name);
    this.log('info', `Colony "${this.definition.name}" started (concurrency: ${this._effectiveConcurrency})`);

    // Start sensors
    for (const sensor of this.definition.sensors) {
      if (sensor.mode === 'watch') {
        this.startWatchSensor(sensor);
      } else {
        this.startPollSensor(sensor);
      }
    }

    // Start decay sweep
    this.decayTimer = setInterval(
      () => this.runDecay(),
      this.decayPolicy.interval,
    );

    // Start scaler if concurrency is a range with autoscale policy
    if (typeof this.definition.concurrency === 'object' && this.definition.config?.autoscale) {
      const range = this.definition.concurrency;
      this.scaler = new ColonyScaler({
        min: range.min,
        max: range.max,
        target: this._effectiveConcurrency,
        policy: this.definition.config.autoscale,
        environment: this.definition.environment,
        sensors: this.definition.sensors,
        getActiveCount: () => this._activeCount,
        onScale: (n) => { this._effectiveConcurrency = n; },
        onEvent: (e) => this.emitEvent(e),
        colonyName: this.definition.name,
      });
      await this.scaler.start();
    }
  }

  async stop(): Promise<void> {
    if (this._state !== 'running') return;
    this._state = 'stopping';
    this.log('info', `Colony "${this.definition.name}" stopping...`);

    // Stop scaler
    if (this.scaler) {
      this.scaler.stop();
      this.scaler = undefined;
    }

    // Stop all sensors
    for (const timer of this.pollTimers) clearInterval(timer);
    this.pollTimers = [];
    for (const sub of this.watchSubscriptions) sub.unsubscribe();
    this.watchSubscriptions = [];

    // Stop decay
    if (this.decayTimer) clearInterval(this.decayTimer);

    // Wait for active tasks to complete (with timeout)
    const timeout = this.definition.config?.actionTimeout ?? 30_000;
    const deadline = Date.now() + timeout;
    while (this._activeCount > 0 && Date.now() < deadline) {
      await sleep(100);
    }

    this._state = 'stopped';
    this.emitEvent({ type: 'colony:stopped', colony: this.definition.name, timestamp: Date.now() });
    this.emit('colony:stopped', this.definition.name);
    this.log('info', `Colony "${this.definition.name}" stopped.`);
  }

  // ----------------------------------------------------------
  // Event system (legacy string-based)
  // ----------------------------------------------------------

  on(event: RuntimeEvent, handler: EventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  private emit(event: RuntimeEvent, ...args: any[]): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(...args); } catch { /* don't let event handlers crash the runtime */ }
      }
    }
  }

  // ----------------------------------------------------------
  // Structured event emitter (for dashboard / observability)
  // ----------------------------------------------------------

  private emitEvent(event: RuntimeEventData): void {
    this.events.emit(event);
    if (this._onEvent) {
      try { this._onEvent(event); } catch { /* never crash the runtime */ }
    }
  }

  // ----------------------------------------------------------
  // Sensor implementations
  // ----------------------------------------------------------

  private startPollSensor(sensor: typeof this.definition.sensors[0]): void {
    const interval = sensor.pollInterval ?? this.definition.config?.defaultPollInterval ?? 2000;

    const poll = async () => {
      if (this._state !== 'running') return;
      if (this._activeCount >= this._effectiveConcurrency) return; // at capacity

      try {
        const signals = await this.definition.environment.observe({
          ...sensor.query,
          unclaimed: this.definition.claimStrategy !== 'none'
            ? true
            : sensor.query.unclaimed,
        });

        const prioritized = prioritize(signals);
        this._stats.signalsSensed += prioritized.length;

        for (const signal of prioritized) {
          if (this._state !== 'running') break;
          if (this._activeCount >= this._effectiveConcurrency) break;
          if (this.processingSignals.has(signal.id)) continue;

          this.processSignal(signal);
        }
      } catch (err) {
        this._stats.errors++;
        this.emit('action:failed', err);
        this.log('error', `Sensor poll error: ${err}`);
      }
    };

    // Initial poll
    poll();

    // Recurring polls
    const timer = setInterval(poll, interval);
    this.pollTimers.push(timer);
  }

  private startWatchSensor(sensor: typeof this.definition.sensors[0]): void {
    const sub = this.definition.environment.watch(
      {
        ...sensor.query,
        unclaimed: this.definition.claimStrategy !== 'none'
          ? true
          : sensor.query.unclaimed,
      },
      (signal) => {
        if (this._state !== 'running') return;
        if (this._activeCount >= this._effectiveConcurrency) return;
        if (this.processingSignals.has(signal.id)) return;

        this._stats.signalsSensed++;
        this.processSignal(signal);
      }
    );

    this.watchSubscriptions.push(sub);
  }

  // ----------------------------------------------------------
  // The Stigmergy Loop (per signal)
  // ----------------------------------------------------------

  private async processSignal(signal: Signal): Promise<void> {
    this.processingSignals.add(signal.id);
    this._activeCount++;
    const startTime = Date.now();
    const colonyName = this.definition.name;

    try {
      // 1. Sensed
      this.emitEvent({
        type: 'signal:sensed',
        colony: colonyName,
        timestamp: Date.now(),
        signalId: signal.id,
        signalType: signal.type,
      });

      // 2. Find matching rule
      const rule = await this.matchRule(signal);
      if (!rule) {
        this.processingSignals.delete(signal.id);
        this._activeCount--;
        return;
      }

      this.emitEvent({
        type: 'signal:matched',
        colony: colonyName,
        timestamp: Date.now(),
        signalId: signal.id,
        signalType: signal.type,
        rule: rule.name,
      });

      // 3. Claim (if strategy requires it)
      if (this.definition.claimStrategy !== 'none') {
        const leaseDuration = this.definition.config?.actionTimeout ?? 60_000;
        const claimed = await this.definition.environment.claim(
          signal.id,
          colonyName,
          leaseDuration
        );

        if (!claimed) {
          this._stats.claimConflicts++;
          this.emitEvent({
            type: 'signal:claim_failed',
            colony: colonyName,
            timestamp: Date.now(),
            signalId: signal.id,
            signalType: signal.type,
          });
          this.emit('signal:claim_failed', signal, colonyName);
          this.log('debug', `Claim conflict on ${signal.id} — another colony got it`);
          this.processingSignals.delete(signal.id);
          this._activeCount--;
          return;
        }

        this._stats.signalsClaimed++;
        this.emitEvent({
          type: 'signal:claimed',
          colony: colonyName,
          timestamp: Date.now(),
          signalId: signal.id,
          signalType: signal.type,
        });
        this.emit('signal:claimed', signal, colonyName);
      }

      // 4. Execute the action (with heartbeat if configured)
      const heartbeatState = this.createHeartbeatState(signal, rule);

      this.emitEvent({
        type: 'action:started',
        colony: colonyName,
        timestamp: Date.now(),
        signalId: signal.id,
        signalType: signal.type,
        rule: rule.name,
      });

      heartbeatState?.start();
      const ctx = this.createActionContext(signal, heartbeatState?.deposit);

      try {
        await this.executeWithRetry(rule, signal, ctx);
      } finally {
        if (heartbeatState) await heartbeatState.stop();
      }

      const actionDuration = Date.now() - startTime;
      this._stats.signalsProcessed++;
      this.emitEvent({
        type: 'action:completed',
        colony: colonyName,
        timestamp: Date.now(),
        signalId: signal.id,
        signalType: signal.type,
        rule: rule.name,
        duration: actionDuration,
      });
      this.emit('action:completed', signal, colonyName);

      // 5. Auto-withdraw if configured
      if (this.definition.config?.autoWithdraw) {
        await this.definition.environment.withdraw(signal.id);
        this.emitEvent({
          type: 'signal:withdrawn',
          colony: colonyName,
          timestamp: Date.now(),
          signalId: signal.id,
          signalType: signal.type,
        });
      }

    } catch (err) {
      this._stats.errors++;
      const actionDuration = Date.now() - startTime;
      this.emitEvent({
        type: 'action:failed',
        colony: colonyName,
        timestamp: Date.now(),
        signalId: signal.id,
        signalType: signal.type,
        duration: actionDuration,
        error: err instanceof Error ? err.message : String(err),
      });
      this.emit('action:failed', err, signal);
      this.log('error', `Error processing signal ${signal.id}: ${err}`);

      // Release claim on error so another agent can pick it up
      if (this.definition.claimStrategy !== 'none') {
        try {
          await this.definition.environment.release(signal.id);
          this.emitEvent({
            type: 'claim:released',
            colony: colonyName,
            timestamp: Date.now(),
            signalId: signal.id,
            signalType: signal.type,
          });
        } catch { /* best effort */ }
      }
    } finally {
      const elapsed = Date.now() - startTime;
      this.totalProcessingMs += elapsed;
      this._stats.avgProcessingMs = this.totalProcessingMs / Math.max(1, this._stats.signalsProcessed);
      this.processingSignals.delete(signal.id);
      this._activeCount--;
    }
  }

  // ----------------------------------------------------------
  // Rule matching
  // ----------------------------------------------------------

  private async matchRule(signal: Signal): Promise<Rule | null> {
    // Sort rules by priority (higher first)
    const sorted = [...this.definition.rules].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
    );

    for (const rule of sorted) {
      if (!rule.when) return rule; // no guard = always matches

      const result = rule.when(signal);
      const passes = result instanceof Promise ? await result : result;
      if (passes) return rule;
    }

    return null;
  }

  // ----------------------------------------------------------
  // Action execution with retry
  // ----------------------------------------------------------

  private async executeWithRetry(
    rule: Rule,
    signal: Signal,
    ctx: ActionContext
  ): Promise<void> {
    const maxAttempts = this.definition.config?.retry?.maxAttempts ?? 1;
    const backoffMs = this.definition.config?.retry?.backoffMs ?? 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Apply timeout if configured
        const timeout = this.definition.config?.actionTimeout;
        if (timeout) {
          await Promise.race([
            rule.do(signal, ctx),
            sleep(timeout).then(() => {
              throw new Error(`Action "${rule.name}" timed out after ${timeout}ms`);
            }),
          ]);
        } else {
          await rule.do(signal, ctx);
        }
        return; // success
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        this.log('warn', `Action "${rule.name}" failed (attempt ${attempt}/${maxAttempts}), retrying in ${backoffMs}ms...`);
        await sleep(backoffMs * attempt); // linear backoff
      }
    }
  }

  // ----------------------------------------------------------
  // Action context factory
  // ----------------------------------------------------------

  private createActionContext(
    triggeringSignal: Signal,
    heartbeatDeposit?: (payload?: Record<string, unknown>) => Promise<void>,
  ): ActionContext {
    const env = this.definition.environment;
    const colonyName = this.definition.name;
    const runtime = this;

    return {
      colony: colonyName,

      async deposit(type, payload = {}, options = {}) {
        const signal = await env.deposit({
          type,
          payload,
          meta: {
            deposited_by: colonyName,
            ttl: options.ttl,
            tags: options.tags,
            caused_by: options.causedBy ?? [triggeringSignal.id],
          },
        });
        runtime._stats.signalsDeposited++;
        runtime.emitEvent({
          type: 'signal:deposited',
          colony: colonyName,
          timestamp: Date.now(),
          signalId: signal.id,
          signalType: signal.type,
        });
        runtime.emit('signal:deposited', signal, colonyName);
        runtime.log('debug', `Deposited ${signal.type} (${signal.id})`);
        return signal;
      },

      async withdraw(signalId) {
        await env.withdraw(signalId);
        runtime.emitEvent({
          type: 'signal:withdrawn',
          colony: colonyName,
          timestamp: Date.now(),
          signalId,
        });
        runtime.log('debug', `Withdrew signal ${signalId}`);
      },

      log(message, level = 'info') {
        runtime.log(level, `[${colonyName}] ${message}`);
      },

      async heartbeat(payload?) {
        if (heartbeatDeposit) await heartbeatDeposit(payload);
      },
    };
  }

  // ----------------------------------------------------------
  // Heartbeat — periodic signals during long-running actions
  // ----------------------------------------------------------

  private createHeartbeatState(
    triggeringSignal: Signal,
    rule: Rule,
  ): { start: () => void; stop: () => Promise<void>; deposit: (payload?: Record<string, unknown>) => Promise<void> } | undefined {
    const heartbeatConfig = this.definition.config?.heartbeat;
    if (!heartbeatConfig) return undefined;

    const env = this.definition.environment;
    const colonyName = this.definition.name;
    const signalType = heartbeatConfig.type ?? `heartbeat:${colonyName}`;
    const ttl = heartbeatConfig.ttl ?? Math.round(heartbeatConfig.interval * 2.5);
    const startedAt = Date.now();

    let lastHeartbeatId: string | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;

    const deposit = async (payload?: Record<string, unknown>) => {
      try {
        const newSignal = await env.deposit({
          type: signalType,
          payload: {
            signalId: triggeringSignal.id,
            signalType: triggeringSignal.type,
            rule: rule.name,
            startedAt,
            elapsed: Date.now() - startedAt,
            ...payload,
          },
          meta: {
            deposited_by: colonyName,
            ttl,
            tags: ['heartbeat'],
            caused_by: [triggeringSignal.id],
          },
        });

        // Withdraw previous heartbeat (swap pattern: always 0 or 1 active)
        if (lastHeartbeatId) {
          try { await env.withdraw(lastHeartbeatId); } catch { /* best effort */ }
        }
        lastHeartbeatId = newSignal.id;
      } catch {
        // Never crash the action due to heartbeat failure
      }
    };

    const start = () => {
      timer = setInterval(() => { deposit(); }, heartbeatConfig.interval);
    };

    const stop = async () => {
      if (timer) clearInterval(timer);
      if (lastHeartbeatId) {
        try { await env.withdraw(lastHeartbeatId); } catch { /* best effort */ }
        lastHeartbeatId = undefined;
      }
    };

    return { start, stop, deposit };
  }

  // ----------------------------------------------------------
  // Decay
  // ----------------------------------------------------------

  private async runDecay(): Promise<void> {
    try {
      const result = await this.definition.environment.decay();
      this.emitEvent({
        type: 'decay:sweep',
        colony: this.definition.name,
        timestamp: Date.now(),
        metadata: {
          decayed: result.decayed,
          evaporated: result.evaporated,
          claimsReleased: result.claimsReleased,
        },
      });
      if (result.evaporated > 0 || result.claimsReleased > 0) {
        this.log('debug',
          `Decay sweep: ${result.decayed} decayed, ${result.evaporated} evaporated, ${result.claimsReleased} claims released`
        );
      }
    } catch (err) {
      this.log('error', `Decay error: ${err}`);
    }
  }

  // ----------------------------------------------------------
  // Logging
  // ----------------------------------------------------------

  private log(level: string, message: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = `[${ts}] [${level.toUpperCase().padEnd(5)}]`;
    const colonyTag = `[${this.definition.name}]`;

    switch (level) {
      case 'error': console.error(`${prefix} ${colonyTag} ${message}`); break;
      case 'warn':  console.warn(`${prefix} ${colonyTag} ${message}`); break;
      case 'debug': /* suppress unless DEBUG env is set */
        if (process.env.DEBUG) console.log(`${prefix} ${colonyTag} ${message}`);
        break;
      default:      console.log(`${prefix} ${colonyTag} ${message}`);
    }
  }
}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Resolve a ConcurrencyConfig to an initial concurrency number. */
function resolveConcurrency(config: ConcurrencyConfig): number {
  if (typeof config === 'number') return config;
  return config.target ?? config.min;
}

// ----------------------------------------------------------
// Factory function
// ----------------------------------------------------------

/**
 * Create a runtime for a colony definition.
 *
 * @example
 * const def = colony('shaper').in(env).sense('task:*').do(...).build();
 * const runtime = createRuntime(def);
 * await runtime.start();
 */
export function createRuntime(
  definition: ColonyDefinition,
  decayPolicyOrOptions?: Partial<DecayPolicy> | {
    decayPolicy?: Partial<DecayPolicy>;
    onEvent?: RuntimeEventCallback;
    eventBus?: EventBus;
  }
): ColonyRuntime {
  // Support both legacy (just decay policy) and new options format
  if (decayPolicyOrOptions && ('onEvent' in decayPolicyOrOptions || 'eventBus' in decayPolicyOrOptions || 'decayPolicy' in decayPolicyOrOptions)) {
    return new ColonyRuntime(definition, decayPolicyOrOptions as any);
  }
  return new ColonyRuntime(definition, {
    decayPolicy: decayPolicyOrOptions as Partial<DecayPolicy> | undefined,
  });
}
