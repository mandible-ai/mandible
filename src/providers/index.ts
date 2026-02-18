// Action providers
export { withAgent } from './agent.js';
export { withStructuredOutput } from './structured-output.js';
export { withBash } from './bash.js';

// Context assembly
export { assembleContext, withContext } from './context.js';

// Types
export type {
  ActionHandler,
  AgentProviderConfig,
  StructuredOutputConfig,
  BashProviderConfig,
  LLMCallFunction,
  SignalDeposit,
  OutputMapping,
  ContextAssemblyConfig,
} from './types.js';
