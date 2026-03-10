// ============================================================
// mandible — Public API
// ============================================================

// Core types
export type {
  Signal,
  SignalMeta,
  SignalQuery,
  Environment,
  EnvironmentConfig,
  SerializableEnvironment,
  Subscription,
  DecayResult,
  ColonyDefinition,
  SensorConfig,
  Rule,
  ActionContext,
  ClaimStrategy,
  ColonyConfig,
  HeartbeatConfig,
  ConcurrencyConfig,
  AutoScalePolicy,
  ColonyRuntime as IColonyRuntime,
  RuntimeState,
  RuntimeStats,
  RuntimeEvent,
  DecayPolicy,
  // Host — the process model (where colony code runs)
  Host,
  // Provenance & Trust types
  TrustLevel,
  Attestation,
  ColonyIdentity,
  TrustPolicy,
  SigningConfig,
  VerificationResult,
  BridgeConfig,
} from './core/types.js';

// Signal utilities
export {
  createSignal,
  matchesQuery,
  decayConcentration,
  isExpired,
  isClaimExpired,
  prioritize,
} from './core/signal.js';

// Environment registry
export {
  registerEnvironment,
  deserializeEnvironment,
  isSerializableEnvironment,
} from './core/environment-registry.js';

// Colony DSL
export { colony } from './dsl/builder.js';
export { mandible } from './dsl/mandible.js';

// Host lifecycle
export { isHost } from './core/types.js';
export type { HostMetadata, DashboardOptions, HostResources } from './core/types.js';

// Hosts — where colony code runs (the process model)
// LocalHost and DockerHost are part of the OSS core.
// CloudHost (Edera microVMs) lives in @mandible-ai/cloud (mandible-cloud repo).
export { LocalHost, local } from './hosts/local.js';
export type { LocalHostMetadata } from './hosts/local.js';
export { DockerHost, docker } from './hosts/docker.js';
export type { DockerHostConfig, DockerHostMetadata } from './hosts/docker.js';

// Runtime
export { ColonyRuntime, createRuntime } from './core/runtime.js';
export { ColonyScaler } from './core/scaler.js';

// Event system
export { EventBus } from './core/events.js';
export type { RuntimeEventType, RuntimeEventData, RuntimeEventCallback } from './core/events.js';

// Validation
export { SignalValidationError, validateSignalInput, validateUpdateInput } from './core/validation.js';

// Environment adapters
export { FilesystemEnvironment } from './environments/filesystem/index.js';
export { DoltEnvironment } from './environments/dolt/index.js';
export { GitHubEnvironment } from './environments/github/index.js';
export type { GitHubEnvConfig } from './environments/github/index.js';

// Default policies
export { DEFAULT_DECAY_POLICY } from './core/types.js';

// Attestation & signing utilities
export {
  generateIdentity,
  signSignal,
  createSigner,
  verifySignature,
  verifyAttestationChain,
  verifySignal,
  createAttestation,
  prepareForBridge,
  canonicalHash,
  attestationHash,
} from './core/attestation.js';

// Patterns — reusable colony patterns
export { createBridge } from './patterns/bridge.js';
export type { SignalBridge, BridgeStats } from './patterns/bridge.js';

export { createSentinel } from './patterns/sentinel.js';
export type { Sentinel, SentinelConfig, SentinelEvaluation, SentinelStats } from './patterns/sentinel.js';

export { createDebugBridge } from './patterns/debug-bridge.js';
export type { DebugBridge, DebugBridgeConfig } from './patterns/debug-bridge.js';

// Dashboard
export { startDashboard, LocalDashboardSource, resolveEnvironments } from './cli/server.js';
export type { DashboardSource, DashboardHandle, ColonyInfo, DashboardOptions as DashboardServerOptions, SimpleConfig } from './cli/server.js';

// Action providers
export { withClaudeCode } from './providers/claude-code.js';
export { withStructuredOutput } from './providers/structured-output.js';
export { withLLM } from './providers/llm.js';
export { withBash } from './providers/bash.js';
export { withOpenCode } from './providers/opencode.js';
export { assembleContext, withContext } from './providers/context.js';

export type {
  ActionHandler,
  ClaudeCodeConfig,
  AgentResult,
  BedrockConfig,
  StructuredOutputConfig,
  LLMConfig,
  BashProviderConfig,
  LLMCallFunction,
  SignalDeposit,
  OutputMapping,
  ContextAssemblyConfig,
} from './providers/types.js';

export type { OpenCodeConfig, OpenCodeResult } from './providers/opencode.js';
