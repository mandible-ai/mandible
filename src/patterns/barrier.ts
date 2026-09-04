// ============================================================
// SignalBarrier — Fan-In Convergence Pattern
// ============================================================
// A barrier watches for N signals of a given type, then
// deposits a downstream signal when the threshold is reached.
//
// This solves fan-in coordination:
//   "Wait until 3 reviewers approve, then proceed to merge"
//   "Wait until all shapers finish, then start the next phase"
//
// Barriers are stateful — they track accumulated evidence.
// Each barrier has a TTL: if the threshold isn't reached in time,
// the barrier expires and optionally deposits a timeout signal.
//
// Biological analogy: quorum sensing in bacteria — individual
// cells deposit signaling molecules, and the group only acts
// when concentration crosses a threshold.
// ============================================================

import type { Signal, Environment, SignalQuery } from '../core/types.js';
import { matchesQuery } from '../core/signal.js';

// ----------------------------------------------------------
// Types
// ----------------------------------------------------------

export interface BarrierConfig {
  /** The environment to watch */
  environment: Environment;

  /** Human-readable name */
  name: string;

  /**
   * Query for the trigger signals to accumulate.
   * Can be a type string (shorthand) or a full SignalQuery.
   */
  trigger: string | SignalQuery;

  /** Number of matching signals required to fire (default: 1) */
  threshold: number;

  /**
   * What to deposit when the threshold is reached.
   * If `payload` is a function, it receives the accumulated signals.
   */
  then: {
    type: string;
    payload: Record<string, unknown> | ((accumulated: Signal[]) => Record<string, unknown>);
    tags?: string[];
    ttl?: number;
  };

  /**
   * Optional: what to deposit if the barrier times out.
   * If not set, expired barriers are silently cleaned up.
   */
  onTimeout?: {
    type: string;
    payload: Record<string, unknown> | ((accumulated: Signal[]) => Record<string, unknown>);
    tags?: string[];
    ttl?: number;
  };

  /**
   * Time-to-live for the barrier in ms.
   * If the threshold isn't reached within this time, the barrier expires.
   * Default: no expiration (waits forever).
   */
  ttl?: number;

  /** How often to check for new trigger signals (ms, default: 3000) */
  pollInterval?: number;

  /**
   * Whether to automatically withdraw trigger signals after the barrier fires.
   * Default: false (trigger signals remain in the environment).
   */
  withdrawTriggers?: boolean;

  /**
   * Whether the barrier resets after firing (reusable) or is one-shot.
   * Default: false (one-shot — stops after first fire).
   */
  repeatable?: boolean;
}

export interface BarrierStats {
  /** Signals accumulated toward the current threshold */
  accumulated: number;
  /** Number of times the barrier has fired */
  fired: number;
  /** Number of times the barrier expired before reaching threshold */
  expired: number;
  /** Number of poll errors */
  errors: number;
}

export interface SignalBarrier {
  /** Start the barrier — begins watching for trigger signals */
  start(): Promise<void>;

  /** Stop the barrier */
  stop(): Promise<void>;

  /** Whether the barrier is currently running */
  readonly running: boolean;

  /** Current accumulated signals (read-only snapshot) */
  readonly accumulated: Signal[];

  /** Barrier statistics */
  readonly stats: BarrierStats;
}

// ----------------------------------------------------------
// Factory
// ----------------------------------------------------------

/**
 * Create a signal barrier for fan-in convergence.
 *
 * @example
 * // Wait for 3 review approvals, then deposit merge-ready signal
 * const barrier = createBarrier({
 *   environment: env,
 *   name: 'review-quorum',
 *   trigger: 'review:approved',
 *   threshold: 3,
 *   then: {
 *     type: 'phase:merge-ready',
 *     payload: (signals) => ({
 *       reviews: signals.map(s => s.id),
 *       approvers: signals.map(s => s.meta.deposited_by),
 *     }),
 *   },
 *   ttl: 300_000, // 5 minute timeout
 *   onTimeout: {
 *     type: 'phase:review-timeout',
 *     payload: (signals) => ({
 *       received: signals.length,
 *       needed: 3,
 *     }),
 *   },
 * });
 * await barrier.start();
 */
export function createBarrier(config: BarrierConfig): SignalBarrier {
  const env = config.environment;
  const interval = config.pollInterval ?? 3_000;
  const threshold = config.threshold;

  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAt: number | undefined;

  // Accumulated trigger signals (by ID to prevent duplicates)
  const accumulatedMap = new Map<string, Signal>();
  // Keep IDs across repeatable rounds so active triggers cannot fire again.
  const consumedTriggerIds = new Set<string>();

  const stats: BarrierStats = { accumulated: 0, fired: 0, expired: 0, errors: 0 };

  const triggerQuery: SignalQuery = typeof config.trigger === 'string'
    ? { type: config.trigger }
    : config.trigger;

  async function poll(): Promise<void> {
    if (!running) return;

    try {
      // Check TTL expiration
      if (config.ttl && startedAt && Date.now() - startedAt > config.ttl) {
        await handleTimeout();
        return;
      }

      // Observe trigger signals
      const signals = await env.observe(triggerQuery);
      const activeTriggerIds = new Set(signals.map(signal => signal.id));
      for (const signalId of consumedTriggerIds) {
        if (!activeTriggerIds.has(signalId)) consumedTriggerIds.delete(signalId);
      }

      // Add new signals to accumulated set
      for (const signal of signals) {
        if (!consumedTriggerIds.has(signal.id)) {
          consumedTriggerIds.add(signal.id);
          accumulatedMap.set(signal.id, signal);
        }
      }

      stats.accumulated = accumulatedMap.size;

      // Check if threshold is reached
      if (accumulatedMap.size >= threshold) {
        await fire();
      }
    } catch (err) {
      stats.errors++;
    }
  }

  async function fire(): Promise<void> {
    const accumulated = [...accumulatedMap.values()];

    // Deposit the downstream signal
    const payload = typeof config.then.payload === 'function'
      ? config.then.payload(accumulated)
      : config.then.payload;

    await env.deposit({
      type: config.then.type,
      payload,
      meta: {
        deposited_by: `barrier:${config.name}`,
        ttl: config.then.ttl,
        tags: config.then.tags,
        caused_by: accumulated.map(s => s.id),
      },
    });

    stats.fired++;

    // Optionally withdraw trigger signals
    if (config.withdrawTriggers) {
      for (const signal of accumulated) {
        try { await env.withdraw(signal.id); } catch { /* best effort */ }
      }
    }

    if (config.repeatable) {
      // Reset for next round
      accumulatedMap.clear();
      stats.accumulated = 0;
      startedAt = Date.now();
    } else {
      // One-shot — stop the barrier
      running = false;
      if (timer) clearInterval(timer);
      timer = undefined;
    }
  }

  async function handleTimeout(): Promise<void> {
    const accumulated = [...accumulatedMap.values()];
    stats.expired++;

    if (config.onTimeout) {
      const payload = typeof config.onTimeout.payload === 'function'
        ? config.onTimeout.payload(accumulated)
        : config.onTimeout.payload;

      try {
        await env.deposit({
          type: config.onTimeout.type,
          payload,
          meta: {
            deposited_by: `barrier:${config.name}`,
            ttl: config.onTimeout.ttl,
            tags: config.onTimeout.tags,
            caused_by: accumulated.map(s => s.id),
          },
        });
      } catch {
        stats.errors++;
      }
    }

    if (config.repeatable) {
      accumulatedMap.clear();
      stats.accumulated = 0;
      startedAt = Date.now();
    } else {
      running = false;
      if (timer) clearInterval(timer);
      timer = undefined;
    }
  }

  return {
    async start() {
      if (running) return;
      running = true;
      startedAt = Date.now();

      // Initial poll
      await poll();

      if (running) {
        timer = setInterval(() => { poll(); }, interval);
      }
    },

    async stop() {
      if (!running) return;
      running = false;
      if (timer) clearInterval(timer);
      timer = undefined;
    },

    get running() {
      return running;
    },

    get accumulated() {
      return [...accumulatedMap.values()];
    },

    get stats() {
      return { ...stats };
    },
  };
}
