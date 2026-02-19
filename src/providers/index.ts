// Action providers
export { withAgent, buildDefaultSystemPrompt } from './agent.js';
export { withStructuredOutput } from './structured-output.js';
export { withBash } from './bash.js';

// Context assembly
export { assembleContext, withContext } from './context.js';

// Types
export type {
  ActionHandler,
  AgentProviderConfig,
  AgentResult,
  StructuredOutputConfig,
  BashProviderConfig,
  LLMCallFunction,
  SignalDeposit,
  OutputMapping,
  ContextAssemblyConfig,
} from './types.js';
