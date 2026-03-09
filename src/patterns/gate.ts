// ============================================================
// SignalGate — Concentration Gating for Ordered Coordination
// ============================================================
// A gate holds signals at concentration 0 until their
// preconditions are satisfied, then activates them.
//
// This enables explicit ordering without a central orchestrator:
//   1. Deposit a signal with preconditions → starts gated (conc 0)
//   2. Gate periodically checks if preconditions are met
//   3. When met, the signal is re-deposited at full concentration
//
// Preconditions can be:
//   - Signal IDs that must exist (deposited or active)
//   - Signal IDs that must be withdrawn (completed)
//
// Biological analogy: pheromone thresholds that only activate
// when multiple trails converge — an ant won't follow a trail
// until enough scent has accumulated from different sources.
// ============================================================

import type { Signal, SignalMeta, Environment } from '../core/types.js';
import { matchesQuery } from '../core/signal.js';

// ----------------------------------------------------------
// Types
// ----------------------------------------------------------

export interface GateConfig {
  /** The environment to gate signals in */
  environment: Environment;

  /** How often to check preconditions (ms, default: 3000) */
  pollInterval?: number;

  /** Name for logging/debugging */
  name?: string;
}

export interface GatedSignalOptions {
  /** Signal type */
  type: string;

  /** Signal payload */
  payload: Record<string, unknown>;

  /**
   * Precondition signal IDs. The signal stays gated (concentration 0)
   * until ALL precondition signals exist in the environment.
   */
  preconditions: string[];

  /**
   * How to check preconditions:
   *   'exists'    — signal must be present (active, not withdrawn) (default)
   *   'withdrawn' — signal must have been withdrawn (completed)
   */
  preconditionMode?: 'exists' | 'withdrawn';

  /** Concentration to set when activated (default: 1.0) */
  activationConcentration?: number;

  /** Optional meta fields */
  meta?: Partial<Pick<SignalMeta, 'deposited_by' | 'ttl' | 'tags' | 'caused_by'>>;
}

export interface GateStats {
  /** Number of gated signals currently waiting */
  pending: number;
  /** Number of signals activated so far */
  activated: number;
  /** Number of signals that expired while gated */
  expired: number;
  /** Number of poll errors */
  errors: number;
}

export interface SignalGate {
  /**
   * Deposit a gated signal. It will have concentration 0 and be
   * invisible to normal colony sensors until preconditions are met.
   */
  deposit(options: GatedSignalOptions): Promise<Signal>;

  /** Start the gate — begins polling preconditions */
  start(): Promise<void>;

  /** Stop the gate */
  stop(): Promise<void>;

  /** Whether the gate is currently running */
  readonly running: boolean;

  /** Gate statistics */
  readonly stats: GateStats;
}

// ----------------------------------------------------------
// Internal tracking
// ----------------------------------------------------------

interface PendingGate {
  /** The gated signal deposited at concentration 0 */
  signal: Signal;
  /** Signal IDs that must be satisfied */
  preconditions: string[];
  /** Check mode */
  mode: 'exists' | 'withdrawn';
  /** Concentration to set on activation */
  activationConcentration: number;
  /** Original meta from deposit */
  meta?: Partial<Pick<SignalMeta, 'deposited_by' | 'ttl' | 'tags' | 'caused_by'>>;
}

// ----------------------------------------------------------
// Factory
// ----------------------------------------------------------

/**
 * Create a signal gate for concentration-based ordering.
 *
 * @example
 * const gate = createGate({ environment: env });
 * await gate.start();
 *
 * // Deposit a gated signal — won't be visible until both preconditions exist
 * await gate.deposit({
 *   type: 'phase:review',
 *   payload: { batch: 'sprint-1' },
 *   preconditions: ['sig_shaping_a', 'sig_shaping_b'],
 * });
 */
export function createGate(config: GateConfig): SignalGate {
  const env = config.environment;
  const interval = config.pollInterval ?? 3_000;
  const name = config.name ?? 'gate';

  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const pending = new Map<string, PendingGate>();
  const stats: GateStats = { pending: 0, activated: 0, expired: 0, errors: 0 };

  async function checkPreconditions(): Promise<void> {
    if (pending.size === 0) return;

    for (const [gatedId, gate] of pending) {
      try {
        const met = await arePreconditionsMet(gate);
        if (met) {
          await activate(gatedId, gate);
        }
      } catch (err) {
        stats.errors++;
      }
    }

    stats.pending = pending.size;
  }

  async function arePreconditionsMet(gate: PendingGate): Promise<boolean> {
    for (const precondId of gate.preconditions) {
      if (gate.mode === 'withdrawn') {
        // Check that the signal does NOT exist (was withdrawn)
        const active = await env.observe({
          filter: (s) => s.id === precondId,
        });
        if (active.length > 0) return false; // Still active, not yet withdrawn

        // Verify it was actually deposited at some point (check history)
        try {
          const historical = await env.history({
            includeWithdrawn: true,
            filter: (s) => s.id === precondId,
          });
          if (historical.length === 0) return false; // Never existed
        } catch {
          // Environment may not support history — fall back to trusting absence
        }
      } else {
        // 'exists' mode — signal must be present in the environment
        const found = await env.observe({
          filter: (s) => s.id === precondId,
        });
        if (found.length === 0) return false;
      }
    }
    return true;
  }

  async function activate(gatedId: string, gate: PendingGate): Promise<void> {
    // Withdraw the gated (concentration 0) signal
    await env.withdraw(gatedId);

    // Re-deposit with full concentration, preserving lineage
    const causedBy = [
      gatedId,
      ...(gate.meta?.caused_by ?? []),
      ...gate.preconditions,
    ];

    await env.deposit({
      type: gate.signal.type,
      payload: gate.signal.payload,
      meta: {
        deposited_by: gate.meta?.deposited_by ?? `gate:${name}`,
        ttl: gate.meta?.ttl,
        tags: gate.meta?.tags,
        caused_by: causedBy,
        concentration: gate.activationConcentration,
      },
    });

    pending.delete(gatedId);
    stats.activated++;
    stats.pending = pending.size;
  }

  return {
    async deposit(options: GatedSignalOptions): Promise<Signal> {
      const signal = await env.deposit({
        type: options.type,
        payload: options.payload,
        meta: {
          deposited_by: options.meta?.deposited_by ?? `gate:${name}`,
          ttl: options.meta?.ttl,
          tags: [...(options.meta?.tags ?? []), 'gated'],
          caused_by: options.meta?.caused_by,
          concentration: 0,
        },
      });

      pending.set(signal.id, {
        signal,
        preconditions: options.preconditions,
        mode: options.preconditionMode ?? 'exists',
        activationConcentration: options.activationConcentration ?? 1.0,
        meta: options.meta,
      });

      stats.pending = pending.size;
      return signal;
    },

    async start() {
      if (running) return;
      running = true;

      // Initial check
      await checkPreconditions();

      timer = setInterval(() => {
        checkPreconditions();
      }, interval);
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

    get stats() {
      return { ...stats };
    },
  };
}
