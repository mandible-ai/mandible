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
  BeforeToolCallEvent,
  ToolCallVerdict,
  ToolCallRecord,
} from './tool-loop.js';

// Refusals as a first-class outcome
export { RefusalError, isRefusal } from './refusal.js';

// qwen-code subprocess wrapper (local agentic coding)
export { withQwenCode } from './qwen-code.js';
export type { QwenCodeConfig, QwenCodeResult } from './qwen-code.js';

// OpenCode agent wrapper (provider-agnostic agentic coding)
export { withOpenCode } from './opencode.js';
export type { OpenCodeConfig, OpenCodeResult } from './opencode.js';

// OpenHands agent wrapper (sandboxed agentic coding for CI/DevOps)
export { withOpenHands, OpenHandsError } from './openhands.js';
export type { OpenHandsConfig, OpenHandsResult, OpenHandsEvent, OpenHandsErrorCode } from './openhands.js';

// Skill-based colony provider
export { withSkill, loadSkills, loadSkill, parseFrontmatter } from './skill.js';
export type { SkillConfig, Skill, SkillMeta } from './skill.js';

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
