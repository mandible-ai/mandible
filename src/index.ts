// ============================================================
// @stigmergy/framework — Public API
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
  ColonyRuntime as IColonyRuntime,
  RuntimeState,
  RuntimeStats,
  RuntimeEvent,
  DecayPolicy,
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

// Runtime
export { ColonyRuntime, createRuntime } from './core/runtime.js';

// Environment adapters
export { FilesystemEnvironment } from './environments/filesystem/index.js';
export { DoltEnvironment } from './environments/dolt/index.js';

// Default policies
export { DEFAULT_DECAY_POLICY } from './core/types.js';

// Action providers
export { withAgent } from './providers/agent.js';
export { withStructuredOutput } from './providers/structured-output.js';
export { withBash } from './providers/bash.js';
export { assembleContext, withContext } from './providers/context.js';

export type {
  ActionHandler,
  AgentProviderConfig,
  StructuredOutputConfig,
  BashProviderConfig,
  LLMCallFunction,
  SignalDeposit,
  OutputMapping,
  ContextAssemblyConfig,
} from './providers/types.js';
