// ============================================================
// Sentinel — Colony Pattern for Trust Monitoring
// ============================================================
// A sentinel colony watches for signals in an environment and
// evaluates their provenance against a trust policy. Untrusted
// signals can be quarantined, tagged, or reported.
//
// Phase 1: Advisory only — flags signals, doesn't enforce.
// Phase 2: Enforcement — integrates with environment deposit hooks.
//
// Biological analogy: guard ants that inspect returning foragers
// and reject those carrying foreign colony scents.
// ============================================================

import type {
  Signal,
  Environment,
  TrustPolicy,
  TrustLevel,
  Subscription,
  SignalQuery,
} from '../core/types.js';
import { verifySignal } from '../core/attestation.js';

export interface SentinelConfig {
  /** Name for this sentinel instance */
  name: string;

  /** The environment to monitor */
  environment: Environment;

  /** Trust policy to evaluate signals against */
  policy: TrustPolicy;

  /** Which signal types to monitor (glob patterns). Default: all. */
  watchTypes?: string[];

  /** Callback when a signal is evaluated */
  onEvaluated?: (signal: Signal, result: SentinelEvaluation) => void;

  /** Callback when a signal is flagged (trust below policy minimum) */
  onFlagged?: (signal: Signal, result: SentinelEvaluation) => void;

  /**
   * Whether to deposit sentinel report signals into the environment.
   * These signals allow other colonies to react to trust events.
   * Default: true
   */
  depositReports?: boolean;

  /** How often to poll for new signals (ms). Default: 3000 */
  pollInterval?: number;
}

export interface SentinelEvaluation {
  signalId: string;
  signalType: string;
  trustLevel: TrustLevel;
  meetsPolicy: boolean;
  reason: string;
  evaluatedAt: number;
}

export interface SentinelStats {
  signalsEvaluated: number;
  signalsFlagged: number;
  byTrustLevel: Record<TrustLevel, number>;
  lastEvaluatedAt?: number;
}

export interface Sentinel {
  /** Start monitoring */
  start(): Promise<void>;

  /** Stop monitoring */
  stop(): Promise<void>;

  /** Whether the sentinel is running */
  readonly running: boolean;

  /** Monitoring statistics */
  readonly stats: SentinelStats;

  /** Get recent evaluations */
  readonly recentEvaluations: SentinelEvaluation[];
}

/** The trust level ordering for comparison */
const TRUST_ORDERING: Record<TrustLevel, number> = {
  verified: 3,
  attested: 2,
  unverified: 1,
  rejected: 0,
};

function meetsTrustMinimum(level: TrustLevel, minimum: TrustLevel): boolean {
  return TRUST_ORDERING[level] >= TRUST_ORDERING[minimum];
}

/**
 * Create a sentinel that monitors an environment for signal trust.
 *
 * Usage:
 *   const sentinel = createSentinel({
 *     name: 'local-guardian',
 *     environment: localEnv,
 *     policy: {
 *       name: 'strict',
 *       defaultTrust: 'unverified',
 *       minimumTrust: 'attested',
 *       trustedColonies: [shaperKey, criticKey],
 *       trustedBridges: [githubBridgeKey],
 *       quarantineRejected: true,
 *     },
 *   });
 *   await sentinel.start();
 */
export function createSentinel(config: SentinelConfig): Sentinel {
  let running = false;
  let watchSub: Subscription | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const evaluatedIds = new Set<string>();
  const MAX_TRACKED = 10_000;
  const MAX_RECENT = 100;
  const recentEvaluations: SentinelEvaluation[] = [];

  const stats: SentinelStats = {
    signalsEvaluated: 0,
    signalsFlagged: 0,
    byTrustLevel: { verified: 0, attested: 0, unverified: 0, rejected: 0 },
  };

  function buildQuery(): SignalQuery {
    return {
      type: config.watchTypes ?? ['*'],
    };
  }

  async function evaluateSignal(signal: Signal): Promise<void> {
    // Skip already evaluated
    if (evaluatedIds.has(signal.id)) return;
    evaluatedIds.add(signal.id);

    // Prevent unbounded growth
    if (evaluatedIds.size > MAX_TRACKED) {
      const iter = evaluatedIds.values();
      for (let i = 0; i < MAX_TRACKED / 2; i++) {
        evaluatedIds.delete(iter.next().value!);
      }
    }

    // Run verification
    const result = await verifySignal(signal, config.policy);
    const meetsPolicy = meetsTrustMinimum(result.trustLevel, config.policy.minimumTrust);

    const evaluation: SentinelEvaluation = {
      signalId: signal.id,
      signalType: signal.type,
      trustLevel: result.trustLevel,
      meetsPolicy,
      reason: result.reason,
      evaluatedAt: Date.now(),
    };

    // Track stats
    stats.signalsEvaluated++;
    stats.byTrustLevel[result.trustLevel]++;
    stats.lastEvaluatedAt = evaluation.evaluatedAt;

    // Store recent
    recentEvaluations.push(evaluation);
    if (recentEvaluations.length > MAX_RECENT) {
      recentEvaluations.shift();
    }

    // Callbacks
    config.onEvaluated?.(signal, evaluation);

    if (!meetsPolicy) {
      stats.signalsFlagged++;
      config.onFlagged?.(signal, evaluation);

      // Deposit sentinel report signal if configured
      if (config.depositReports !== false) {
        try {
          await config.environment.deposit({
            type: 'sentinel:flagged',
            payload: {
              signalId: signal.id,
              signalType: signal.type,
              trustLevel: result.trustLevel,
              reason: result.reason,
              meetsPolicy: false,
              sourceEnvironment: signal.meta.sourceEnvironment,
              attestationCount: signal.meta.attestations?.length ?? 0,
            } as Record<string, unknown>,
            meta: {
              deposited_by: `sentinel:${config.name}`,
              tags: ['sentinel', 'trust', result.trustLevel],
              caused_by: [signal.id],
              ttl: 300_000, // sentinel reports expire after 5 minutes
            },
          });
        } catch (err: any) {
          console.error(`[sentinel:${config.name}] Error depositing report: ${err.message}`);
        }
      }
    }
  }

  return {
    async start() {
      if (running) return;
      running = true;

      const query = buildQuery();

      // Try watch first, fall back to polling
      try {
        watchSub = config.environment.watch(query, (signal) => {
          evaluateSignal(signal);
        });
      } catch {
        const interval = config.pollInterval ?? 3_000;
        pollTimer = setInterval(async () => {
          try {
            const signals = await config.environment.observe(query);
            for (const signal of signals) {
              await evaluateSignal(signal);
            }
          } catch (err: any) {
            console.error(`[sentinel:${config.name}] Poll error: ${err.message}`);
          }
        }, interval);
      }

      // Evaluate existing signals on start
      try {
        const existing = await config.environment.observe(query);
        for (const signal of existing) {
          await evaluateSignal(signal);
        }
      } catch (err: any) {
        console.error(`[sentinel:${config.name}] Initial scan error: ${err.message}`);
      }
    },

    async stop() {
      if (!running) return;
      running = false;

      watchSub?.unsubscribe();
      if (pollTimer) clearInterval(pollTimer);
      watchSub = undefined;
      pollTimer = undefined;
    },

    get running() {
      return running;
    },

    get stats() {
      return { ...stats, byTrustLevel: { ...stats.byTrustLevel } };
    },

    get recentEvaluations() {
      return [...recentEvaluations];
    },
  };
}
