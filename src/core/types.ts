// ============================================================
// @stigmergy/core — Type System
// ============================================================
// The fundamental primitives of stigmergic coordination.
// Every concept maps to a biological analogy:
//   Signal    = pheromone
//   Environment = substrate (ground, nest, repo, filesystem)
//   Colony    = ant colony (group of identical agents)
//   Sensor    = antennae
//   Actuator  = mandibles
//   Rule      = instinct (stimulus → response)
// ============================================================

// ----------------------------------------------------------
// Signals — the pheromones agents leave in the environment
// ----------------------------------------------------------

export interface Signal<T = Record<string, unknown>> {
  /** Unique signal ID */
  id: string;

  /**
   * Hierarchical signal type, e.g. 'task:ready', 'review:needed', 'artifact:shaped'
   * Convention: {domain}:{state}
   */
  type: string;

  /** Arbitrary structured payload */
  payload: T;

  /** Signal metadata — managed by the framework, not the agent */
  meta: SignalMeta;
}

export interface SignalMeta {
  /** When the signal was deposited (epoch ms) */
  deposited_at: number;

  /** Which colony deposited this signal */
  deposited_by: string;

  /**
   * Signal strength: 1.0 = fresh, decays toward 0.0 over time.
   * Agents can use concentration to prioritize work.
   */
  concentration: number;

  /** Optional time-to-live in milliseconds. Signal evaporates after this. */
  ttl?: number;

  /** If claimed, which colony instance holds the claim */
  claimed_by?: string;

  /** When the claim was taken */
  claimed_at?: number;

  /** Claim lease duration in ms — auto-releases if holder dies */
  claim_lease?: number;

  /** Lineage: signal IDs that caused this signal to be deposited */
  caused_by?: string[];

  /** Arbitrary tags for filtering */
  tags?: string[];
}

// ----------------------------------------------------------
// Signal Queries — how agents specify what they're looking for
// ----------------------------------------------------------

export interface SignalQuery {
  /** Match signal types (exact or glob pattern like 'task:*') */
  type?: string | string[];

  /** Only signals above this concentration threshold */
  minConcentration?: number;

  /** Only unclaimed signals */
  unclaimed?: boolean;

  /** Only signals with these tags */
  tags?: string[];

  /** Only signals deposited after this time */
  after?: number;

  /** Max results to return */
  limit?: number;

  /** Custom filter predicate */
  filter?: (signal: Signal) => boolean;
}

// ----------------------------------------------------------
// Environment — the shared substrate
// ----------------------------------------------------------

export interface Environment {
  /** Human-readable name for this environment instance */
  readonly name: string;

  /** Observe signals matching a query */
  observe(query: SignalQuery): Promise<Signal[]>;

  /** Deposit a new signal into the environment */
  deposit(signal: Omit<Signal, 'id' | 'meta'> & { meta?: Partial<SignalMeta> }): Promise<Signal>;

  /** Withdraw (remove) a signal from the environment */
  withdraw(signalId: string): Promise<void>;

  /**
   * Attempt to claim a signal. Returns true if claim succeeded.
   * Supports optimistic concurrency — if two agents claim simultaneously,
   * only one succeeds.
   */
  claim(signalId: string, claimant: string, leaseDuration?: number): Promise<boolean>;

  /** Release a previously held claim */
  release(signalId: string): Promise<void>;

  /**
   * Watch for signals matching a pattern. Callback fires when new signals appear.
   * This is the reactive sensor mechanism.
   */
  watch(
    query: SignalQuery,
    callback: (signal: Signal) => void
  ): Subscription;

  /** Query historical signals (including withdrawn ones, if supported) */
  history(query: SignalQuery & { includeWithdrawn?: boolean }): Promise<Signal[]>;

  /** Apply decay to all signals based on their age and TTL */
  decay(): Promise<DecayResult>;

  /** Get all active signals (primarily for debugging/observability) */
  snapshot(): Promise<Signal[]>;
}

export interface Subscription {
  unsubscribe(): void;
}

export interface DecayResult {
  /** Number of signals that had their concentration reduced */
  decayed: number;
  /** Number of signals that were evaporated (removed) entirely */
  evaporated: number;
  /** Number of expired claims that were released */
  claimsReleased: number;
}

// ----------------------------------------------------------
// Colony — the agent group definition
// ----------------------------------------------------------

export interface ColonyDefinition<T = Record<string, unknown>> {
  /** Colony name — all instances share this identity */
  name: string;

  /** Which environment this colony operates in */
  environment: Environment;

  /** What signals this colony watches for */
  sensors: SensorConfig[];

  /** The rules that map stimuli to responses */
  rules: Rule<T>[];

  /** How many concurrent agents can run */
  concurrency: number;

  /** How to handle contention for the same signal */
  claimStrategy: ClaimStrategy;

  /** Colony-level configuration */
  config?: ColonyConfig;
}

export interface SensorConfig {
  /** Signal query to watch */
  query: SignalQuery;

  /** Polling interval in ms (for environments that don't support watch) */
  pollInterval?: number;

  /** Whether to use push-based watching (preferred) or polling */
  mode?: 'watch' | 'poll';
}

export interface Rule<T = Record<string, unknown>> {
  /** Human-readable rule name */
  name: string;

  /**
   * Guard condition — if this returns false, the rule doesn't fire.
   * Use for additional filtering beyond what the sensor query provides.
   */
  when?: (signal: Signal<T>) => boolean | Promise<boolean>;

  /**
   * The action to take when the rule fires.
   * Receives the triggering signal and a context for depositing new signals.
   */
  do: (signal: Signal<T>, ctx: ActionContext) => Promise<void>;

  /** Priority relative to other rules (higher = evaluated first) */
  priority?: number;
}

export interface ActionContext {
  /** The colony name performing this action */
  colony: string;

  /** Deposit a new signal into the environment */
  deposit(
    type: string,
    payload?: Record<string, unknown>,
    options?: { ttl?: number; tags?: string[]; causedBy?: string[] }
  ): Promise<Signal>;

  /** Withdraw a signal (typically the one being processed) */
  withdraw(signalId: string): Promise<void>;

  /** Log a message (routed through the framework's logging) */
  log(message: string, level?: 'debug' | 'info' | 'warn' | 'error'): void;
}

export type ClaimStrategy =
  | 'optimistic'     // Let multiple agents start, reconcile after
  | 'exclusive'      // Strict claim-before-work
  | 'lease'          // Claim with TTL, auto-release if agent dies
  | 'none';          // No claiming — multiple agents may process same signal

export interface ColonyConfig {
  /** How often the sensor polls (if not using watch mode) */
  defaultPollInterval?: number;

  /** Whether to automatically withdraw signals after processing */
  autoWithdraw?: boolean;

  /** Decay configuration for signals this colony deposits */
  decayRate?: number; // concentration units per second

  /** Max time a single rule action can take before timeout */
  actionTimeout?: number;

  /** Retry configuration for failed actions */
  retry?: {
    maxAttempts: number;
    backoffMs: number;
  };
}

// ----------------------------------------------------------
// Runtime — the execution engine
// ----------------------------------------------------------

export interface ColonyRuntime {
  /** Start the colony — begins sensor loops */
  start(): Promise<void>;

  /** Stop the colony gracefully */
  stop(): Promise<void>;

  /** Current runtime state */
  readonly state: RuntimeState;

  /** Number of currently active agent tasks */
  readonly activeCount: number;

  /** Runtime statistics */
  readonly stats: RuntimeStats;

  /** Subscribe to runtime events */
  on(event: RuntimeEvent, handler: (...args: any[]) => void): void;
}

export type RuntimeState = 'idle' | 'running' | 'stopping' | 'stopped';

export interface RuntimeStats {
  signalsSensed: number;
  signalsClaimed: number;
  signalsProcessed: number;
  signalsDeposited: number;
  claimConflicts: number;
  errors: number;
  avgProcessingMs: number;
}

export type RuntimeEvent =
  | 'signal:sensed'
  | 'signal:claimed'
  | 'signal:processed'
  | 'signal:deposited'
  | 'signal:claim-conflict'
  | 'colony:started'
  | 'colony:stopped'
  | 'colony:error';

// ----------------------------------------------------------
// Decay — pheromone evaporation
// ----------------------------------------------------------

export interface DecayPolicy {
  /** How fast concentration drops (units per second) */
  rate: number;

  /** Minimum concentration before signal is evaporated entirely */
  floor: number;

  /** Whether to auto-release expired claims */
  releaseExpiredClaims: boolean;

  /** How often to run the decay sweep (ms) */
  interval: number;
}

export const DEFAULT_DECAY_POLICY: DecayPolicy = {
  rate: 0.01,          // lose 1% per second
  floor: 0.05,         // evaporate below 5%
  releaseExpiredClaims: true,
  interval: 5_000,     // sweep every 5 seconds
};
