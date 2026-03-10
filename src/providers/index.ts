// Action providers
export { withClaudeCode, buildDefaultSystemPrompt } from './claude-code.js';
export { withStructuredOutput } from './structured-output.js';
export { withLLM } from './llm.js';
export { withBash } from './bash.js';

// vLLM local inference providers
export {
  vllmProvider,
  vllmStructuredProvider,
  vllmFromEnv,
  vllmStructuredFromEnv,
  VLLMError,
} from './vllm.js';
export type { VLLMConfig, VLLMErrorCode } from './vllm.js';

// Tool-calling loop (local agentic coding via vLLM)
export {
  withToolLoop,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  bashTool,
  globTool,
  grepTool,
  listDirTool,
} from './tool-loop.js';
export type {
  ToolLoopConfig,
  ToolDefinition,
  ToolLoopResult,
  ToolCallEvent,
  TurnEvent,
} from './tool-loop.js';

// qwen-code subprocess wrapper (local agentic coding)
export { withQwenCode } from './qwen-code.js';
export type { QwenCodeConfig, QwenCodeResult } from './qwen-code.js';

// Context assembly
export { assembleContext, withContext } from './context.js';

// Types
export type {
  ActionHandler,
  ClaudeCodeConfig,
  AgentResult,
  StructuredOutputConfig,
  BashProviderConfig,
  LLMConfig,
  LLMCallFunction,
  SignalDeposit,
  OutputMapping,
  ContextAssemblyConfig,
} from './types.js';
