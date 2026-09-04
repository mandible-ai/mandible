// Action providers
export { withClaudeCode, buildDefaultSystemPrompt } from './claude-code.js';
export { withStructuredOutput } from './structured-output.js';
export { withLLM } from './llm.js';
export { withBash } from './bash.js';
export { generateStructured } from './structured-output.js';
export type { StructuredCallOptions } from './structured-output.js';

// Model aliases — tier names that track the latest model
export {
  MODEL_ALIASES,
  DEFAULT_MODEL_ALIAS,
  resolveModel,
  isModelAlias,
  setModelAliases,
  resetModelAliases,
  currentModelAliases,
} from './models.js';
export type { ModelAlias } from './models.js';

// Classification — marks left on signals for routers and downstream colonies
export { withClassifier, isClassified, mergeTags, CLASSIFIED_TAG_PREFIX } from './classifier.js';
export type { ClassifierConfig } from './classifier.js';

// Stigmergic model routing
export {
  withModelRouter,
  selectModel,
  byTag,
  byConcentration,
  byType,
  byPayload,
  byEscalation,
  byLineage,
  escalationLevel,
  routedVia,
  ROUTE_TAG_PREFIX,
  ESCALATION_TAG_PREFIX,
} from './model-router.js';
export type { ModelRoute, ModelRouterConfig } from './model-router.js';

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
