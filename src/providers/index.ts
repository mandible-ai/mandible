// Action providers
export { withClaudeCode, buildDefaultSystemPrompt } from './claude-code.js';
export { withStructuredOutput } from './structured-output.js';
export { withBash } from './bash.js';

// Context assembly
export { assembleContext, withContext } from './context.js';

// Types
export type {
  ActionHandler,
  ClaudeCodeConfig,
  AgentResult,
  StructuredOutputConfig,
  BashProviderConfig,
  LLMCallFunction,
  SignalDeposit,
  OutputMapping,
  ContextAssemblyConfig,
} from './types.js';
