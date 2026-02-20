// ============================================================
// mandible — Public API
// ============================================================

// Core types
export type {
  Signal,
  SignalMeta,
  SignalQuery,
  Environment,
  Subscription,
  DecayResult,
  ColonyDefinition,
  SensorConfig,
  Rule,
  ActionContext,
  ClaimStrategy,
  ColonyConfig,
  HeartbeatConfig,
  ColonyRuntime as IColonyRuntime,
  RuntimeState,
  RuntimeStats,
  RuntimeEvent,
  DecayPolicy,
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

// Colony DSL
export { colony } from './dsl/builder.js';
export { mandible, pipeline } from './dsl/pipeline.js';
export type { PipelineCloudConfig, PipelineDeployOptions, PipelineDevOptions, Deployment } from './dsl/pipeline.js';

// Runtime
export { ColonyRuntime, createRuntime } from './core/runtime.js';

// Event system
export { EventBus } from './core/events.js';
export type { RuntimeEventType, RuntimeEventData, RuntimeEventCallback } from './core/events.js';

// Validation
export { SignalValidationError, validateSignalInput } from './core/validation.js';

// Environment adapters
export { FilesystemEnvironment } from './environments/filesystem/index.js';
export { DoltEnvironment } from './environments/dolt/index.js';
export { GitHubEnvironment } from './environments/github/index.js';
export type { GitHubEnvConfig } from './environments/github/index.js';
export { RemoteEnvironment } from './environments/remote/index.js';
export type { RemoteEnvConfig } from './environments/remote/index.js';

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

// Action providers
export { withClaudeCode } from './providers/claude-code.js';
export { withStructuredOutput } from './providers/structured-output.js';
export { withBash } from './providers/bash.js';
export { assembleContext, withContext } from './providers/context.js';

export type {
  ActionHandler,
  ClaudeCodeConfig,
  AgentResult,
  BedrockConfig,
  StructuredOutputConfig,
  BashProviderConfig,
  LLMCallFunction,
  SignalDeposit,
  OutputMapping,
  ContextAssemblyConfig,
} from './providers/types.js';
