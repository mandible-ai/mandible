// ============================================================
// SignalBridge — Colony Pattern for Cross-Environment Bridging
// ============================================================
// A bridge monitors one environment and mirrors matching signals
// to another, attesting each transfer with its own identity.
//
// Biological analogy: scout ants that carry pheromone markers
// between foraging trails, creating connections between colonies.
// ============================================================

import type {
  Signal,
  Environment,
  BridgeConfig,
  Subscription,
  SignalQuery,
} from '../core/types.js';
import { prepareForBridge } from '../core/attestation.js';
import { matchesQuery } from '../core/signal.js';

export interface BridgeStats {
  signalsBridged: number;
  signalsFiltered: number;
  errors: number;
  lastBridgedAt?: number;
}

export interface SignalBridge {
  /** Start the bridge — begins watching/polling the source */
  start(): Promise<void>;

  /** Stop the bridge gracefully */
  stop(): Promise<void>;

  /** Whether the bridge is currently running */
  readonly running: boolean;

  /** Bridge statistics */
  readonly stats: BridgeStats;
}

/**
 * Create a signal bridge between two environments.
 *
 * Usage:
 *   const bridge = createBridge({
 *     name: 'github-to-local',
 *     identity: bridgeId,
 *     source: githubEnv,
 *     target: localEnv,
 *     signalTypes: ['task:ready', 'review:*'],
 *   });
 *   await bridge.start();
 */
export function createBridge(config: BridgeConfig): SignalBridge {
  let running = false;
  let forwardSub: Subscription | undefined;
  let reverseSub: Subscription | undefined;
  let forwardPoll: ReturnType<typeof setInterval> | undefined;
  let reversePoll: ReturnType<typeof setInterval> | undefined;

  // Track which signals we've already bridged (prevent loops)
  const bridgedIds = new Set<string>();
  const MAX_TRACKED = 10_000;

  const stats: BridgeStats = {
    signalsBridged: 0,
    signalsFiltered: 0,
    errors: 0,
  };

  function trackBridged(id: string) {
    bridgedIds.add(id);
    // Prevent unbounded memory growth
    if (bridgedIds.size > MAX_TRACKED) {
      const iter = bridgedIds.values();
      for (let i = 0; i < MAX_TRACKED / 2; i++) {
        bridgedIds.delete(iter.next().value!);
      }
    }
  }

  function buildQuery(): SignalQuery {
    return {
      type: config.signalTypes,
      unclaimed: false, // bridge all signals, not just unclaimed
    };
  }

  async function bridgeSignal(
    signal: Signal,
    from: Environment,
    to: Environment,
    fromName: string,
    toName: string
  ): Promise<void> {
    // Skip if we already bridged this signal (prevents loops in bidirectional)
    if (bridgedIds.has(signal.id)) return;

    // Skip signals that originated from the target (prevent echo)
    if (signal.meta.sourceEnvironment === toName) return;

    try {
      // Apply optional transform
      let transformedSignal: Signal | null = signal;
      if (config.transform) {
        transformedSignal = config.transform(signal);
        if (!transformedSignal) {
          stats.signalsFiltered++;
          return;
        }
      }

      // Add attestation and bridge metadata
      const bridgedSignal = await prepareForBridge(
        transformedSignal,
        fromName,
        toName,
        config.identity
      );

      // Deposit in target environment
      await to.deposit({
        type: bridgedSignal.type,
        payload: bridgedSignal.payload,
        meta: {
          ...bridgedSignal.meta,
          // Reset mutable state for the new environment
          concentration: 1.0,
          claimed_by: undefined,
          claimed_at: undefined,
          claim_lease: undefined,
        },
      });

      trackBridged(signal.id);
      stats.signalsBridged++;
      stats.lastBridgedAt = Date.now();
    } catch (err: any) {
      stats.errors++;
      console.error(`[bridge:${config.name}] Error bridging signal ${signal.id}: ${err.message}`);
    }
  }

  function setupWatch(
    from: Environment,
    to: Environment,
    fromName: string,
    toName: string
  ): Subscription {
    return from.watch(buildQuery(), (signal) => {
      bridgeSignal(signal, from, to, fromName, toName);
    });
  }

  function setupPoll(
    from: Environment,
    to: Environment,
    fromName: string,
    toName: string
  ): ReturnType<typeof setInterval> {
    const interval = config.pollInterval ?? 5_000;
    return setInterval(async () => {
      try {
        const signals = await from.observe(buildQuery());
        for (const signal of signals) {
          await bridgeSignal(signal, from, to, fromName, toName);
        }
      } catch (err: any) {
        stats.errors++;
        console.error(`[bridge:${config.name}] Poll error: ${err.message}`);
      }
    }, interval);
  }

  return {
    async start() {
      if (running) return;
      running = true;

      const sourceName = config.source.name;
      const targetName = config.target.name;

      // Forward direction: source → target
      try {
        forwardSub = setupWatch(config.source, config.target, sourceName, targetName);
      } catch {
        // Watch not supported, fall back to polling
        forwardPoll = setupPoll(config.source, config.target, sourceName, targetName);
      }

      // Reverse direction (if bidirectional): target → source
      if (config.bidirectional) {
        try {
          reverseSub = setupWatch(config.target, config.source, targetName, sourceName);
        } catch {
          reversePoll = setupPoll(config.target, config.source, targetName, sourceName);
        }
      }
    },

    async stop() {
      if (!running) return;
      running = false;

      forwardSub?.unsubscribe();
      reverseSub?.unsubscribe();
      if (forwardPoll) clearInterval(forwardPoll);
      if (reversePoll) clearInterval(reversePoll);

      forwardSub = undefined;
      reverseSub = undefined;
      forwardPoll = undefined;
      reversePoll = undefined;
    },

    get running() {
      return running;
    },

    get stats() {
      return { ...stats };
    },
  };
}
