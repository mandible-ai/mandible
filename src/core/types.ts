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

  // ── Provenance & Trust ──────────────────────────────

  /**
   * Ed25519 signature of the canonical signal content.
   * Signs: hash(type + JSON(payload) + JSON(caused_by))
   * Proves the depositing colony actually produced this signal.
   */
  signature?: string;

  /**
   * Public key (hex-encoded) of the colony that signed this signal.
   * Used to look up the colony identity for verification.
   */
  signer?: string;

  /**
   * Attestation chain for bridged signals.
   * Each bridge that transfers a signal appends its own attestation.
   * Verification walks the chain from origin to current environment.
   */
  attestations?: Attestation[];

  /**
   * Trust level assigned by the receiving environment's trust policy.
   * Set during deposit validation. Colonies can filter by trust level.
   *   'verified'   — signature valid, attestation chain checks out
   *   'attested'   — bridge attestation present but colony sig missing
   *   'unverified' — no provenance metadata (local signals, legacy)
   *   'rejected'   — failed verification (quarantined, not evicted)
   */
  trustLevel?: TrustLevel;

  /**
   * The environment where this signal originated.
   * Set automatically by bridges when transferring signals.
   * Undefined for signals deposited locally.
   */
  sourceEnvironment?: string;
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

// ----------------------------------------------------------
// Host — the process model (where colony code executes)
// ----------------------------------------------------------
// Hosts are orthogonal to Environments:
//   Environment = where signals live (GitHub, filesystem, Kafka, signal server)
//   Host        = where colony code runs (local machine, Docker, Edera microVM)
//
// A single host can run colonies that observe multiple environments.
// A single environment can be observed by colonies on different hosts.
// ----------------------------------------------------------

export interface Host {
  /** Human-readable name for this host */
  readonly name: string;

  /**
   * Deploy colony definitions. The host decides how to run the colony code.
   * The colony definitions already reference their environments.
   */
  deploy(colonies: ColonyDefinition[], options?: DeployOptions): Promise<Deployment>;

  /** Tear down all deployed colonies */
  teardown(): Promise<void>;
}

export interface DeployOptions {
  /** Dashboard port. Default: 4040 */
  port?: number;
  /** Auto-open dashboard in browser. Default: true */
  open?: boolean;
  /** Deploy without starting dashboard. Default: false */
  headless?: boolean;
  /** Colony container image (container/cloud hosts only) */
  image?: string;
}

export interface HostResources {
  targetCpus?: number;
  maxCpus?: number;
  targetMemoryMb?: number;
  maxMemoryMb?: number;
}

export interface Deployment {
  /** Per-colony deployment details */
  colonies: Array<{ name: string; state: string; zoneId?: string }>;
  /** Open the dashboard */
  dashboard(options?: { port?: number; open?: boolean }): Promise<void>;
  /** Tear down all deployed colonies and clean up */
  teardown(): Promise<void>;
  /** The host this deployment is running on */
  host: Host;
  /** The environments the colonies are observing */
  environments: Environment[];
}

/** Type guard to check if an object is a Host */
export function isHost(obj: unknown): obj is Host {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'name' in obj &&
    'deploy' in obj &&
    typeof (obj as Host).deploy === 'function' &&
    'teardown' in obj &&
    typeof (obj as Host).teardown === 'function'
  );
}

// ----------------------------------------------------------
// Deprecated: Deployable on Environment
// ----------------------------------------------------------
// Kept for backward compatibility. Prefer using Host instead.
// ----------------------------------------------------------

/**
 * @deprecated Use the Host interface instead. Environments should only
 * model the signal substrate, not the process model.
 */
export interface Deployable {
  deploy(colonies: ColonyDefinition[], options?: DeployOptions): Promise<Deployment>;
  teardown(): Promise<void>;
}

/**
 * @deprecated Use isHost() instead. Deployment should go through a Host,
 * not be coupled to the Environment.
 */
export function isDeployable(env: Environment): env is Environment & Deployable {
  return 'deploy' in env && typeof (env as any).deploy === 'function';
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

  /** Manually deposit a heartbeat signal (no-op if heartbeat not configured) */
  heartbeat(payload?: Record<string, unknown>): Promise<void>;
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

  /** Heartbeat configuration — deposits periodic signals during long-running actions */
  heartbeat?: HeartbeatConfig;
}

export interface HeartbeatConfig {
  /** Milliseconds between heartbeat deposits */
  interval: number;

  /** TTL in ms for heartbeat signals. Defaults to Math.round(interval * 2.5) */
  ttl?: number;

  /** Signal type for heartbeat. Defaults to 'heartbeat:{colonyName}' */
  type?: string;
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

/**
 * Runtime event types — the canonical set of events emitted by the stigmergy loop.
 * Re-exported from events.ts as RuntimeEvent for backward compatibility.
 */
import type { RuntimeEventType } from './events.js';
export type RuntimeEvent = RuntimeEventType;

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

// ----------------------------------------------------------
// Provenance & Trust — colony signing and bridge attestation
// ----------------------------------------------------------
// Phase 1: Metadata only (no enforcement). Colonies sign signals,
// bridges attest transfers. Environment trust policies come later.
// ----------------------------------------------------------

/**
 * Trust levels assigned to signals based on provenance verification.
 *   'verified'   — colony signature valid, full attestation chain checks out
 *   'attested'   — bridge attestation present but colony signature missing
 *   'unverified' — no provenance metadata (local signals, legacy systems)
 *   'rejected'   — failed verification (quarantined, not evicted)
 */
export type TrustLevel = 'verified' | 'attested' | 'unverified' | 'rejected';

/**
 * A single attestation in the chain of custody for a bridged signal.
 * Each bridge that transfers a signal appends its own attestation.
 * Verification walks the chain from origin → current environment.
 */
export interface Attestation {
  /** Identity of the bridge or environment that attests this transfer */
  attester: string;

  /** Public key (hex-encoded) of the attesting entity */
  attesterKey: string;

  /** Environment the signal was transferred FROM */
  sourceEnvironment: string;

  /** Environment the signal was transferred TO */
  targetEnvironment: string;

  /** When this attestation was created (epoch ms) */
  timestamp: number;

  /**
   * Ed25519 signature over the attestation content.
   * Signs: hash(signalId + sourceEnvironment + targetEnvironment + timestamp + previousSignature?)
   * This creates a chain — each attestation signs over the previous one.
   */
  signature: string;

  /** Optional human-readable note about the transfer */
  note?: string;
}

/**
 * Colony identity — the cryptographic identity of a colony.
 * Generated once when a colony is first created, persisted across restarts.
 * The private key stays with the colony; the public key is shared.
 */
export interface ColonyIdentity {
  /** Colony name (must match ColonyDefinition.name) */
  name: string;

  /** Ed25519 public key, hex-encoded */
  publicKey: string;

  /** Ed25519 private key, hex-encoded. NEVER share or log this. */
  privateKey: string;

  /** Which environment this colony is registered in */
  environment: string;

  /** When the identity was created */
  createdAt: number;

  /** Optional metadata (version, capabilities, etc.) */
  metadata?: Record<string, unknown>;
}

/**
 * Trust policy for an environment — defines how signals are evaluated.
 * Phase 2 feature: environments will enforce these policies during deposit.
 * For now, policies are advisory and used by Sentinel colonies.
 */
export interface TrustPolicy {
  /** Policy name for logging/debugging */
  name: string;

  /** Default trust level for signals with no provenance metadata */
  defaultTrust: TrustLevel;

  /** Whether to accept signals below a certain trust level */
  minimumTrust: TrustLevel;

  /** Explicitly trusted colony public keys (always 'verified' if sig checks out) */
  trustedColonies: string[];

  /** Explicitly trusted bridge/attester public keys */
  trustedBridges: string[];

  /**
   * Environments whose signals are accepted via bridge.
   * Empty array = accept from any environment.
   * Undefined = accept from any environment.
   */
  allowedSourceEnvironments?: string[];

  /**
   * Environments whose signals are rejected regardless of attestation.
   */
  blockedSourceEnvironments?: string[];

  /** Whether to quarantine rejected signals (keep but mark) or drop them entirely */
  quarantineRejected: boolean;

  /**
   * Maximum age of the oldest attestation in the chain (ms).
   * Prevents replay attacks with ancient attestation chains.
   */
  maxAttestationAge?: number;

  /**
   * Maximum number of hops (attestations) allowed in the chain.
   * Prevents signals from traveling through too many intermediaries.
   */
  maxAttestationDepth?: number;
}

/**
 * Configuration for signal signing within a colony.
 * Passed to colony runtime to enable automatic signing.
 */
export interface SigningConfig {
  /** Colony identity with private key for signing */
  identity: ColonyIdentity;

  /** Whether to sign all deposited signals (default: true) */
  signAll?: boolean;

  /** Signal types to exclude from signing (e.g., debug signals) */
  excludeTypes?: string[];
}

/**
 * Result of verifying a signal's provenance.
 */
export interface VerificationResult {
  /** The trust level determined by verification */
  trustLevel: TrustLevel;

  /** Whether the colony signature is valid (if present) */
  signatureValid: boolean | null; // null if no signature

  /** Whether the attestation chain is valid (if present) */
  attestationChainValid: boolean | null; // null if no attestations

  /** Human-readable reason for the trust level */
  reason: string;

  /** Individual attestation verification results */
  attestationResults?: Array<{
    attester: string;
    valid: boolean;
    reason: string;
  }>;
}

/**
 * Bridge configuration for connecting two environments.
 */
export interface BridgeConfig {
  /** Human-readable bridge name */
  name: string;

  /** Bridge identity for signing attestations */
  identity: ColonyIdentity;

  /** Source environment to mirror signals FROM */
  source: Environment;

  /** Target environment to mirror signals TO */
  target: Environment;

  /** Which signal types to bridge (glob patterns) */
  signalTypes: string[];

  /** Whether to bridge in both directions */
  bidirectional?: boolean;

  /** Transform signals during bridging (e.g., remap types, filter fields) */
  transform?: (signal: Signal) => Signal | null;

  /** How often to poll source for new signals (ms). Only if source doesn't support watch. */
  pollInterval?: number;
}
