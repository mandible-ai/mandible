// ============================================================
// Action Providers — Pluggable intelligence for colony actions
// ============================================================
// The stigmergy framework handles coordination (signals, environments,
// claims, decay). Action providers handle intelligence (LLM calls,
// tool use, structured output, shell commands).
//
// Providers are factories that return standard action handlers.
// This means the colony DSL doesn't change — .do() still takes
// (signal, ctx) => Promise<void>. Providers just make it easier
// to build those handlers with different LLM backends.
//
// Design principle: each colony uses the MINIMUM intelligence it
// needs. A Shaper gets a full coding agent. A Critic gets structured
// output. A Keeper gets a shell command. Cost and latency stay
// proportional to task complexity.
// ============================================================

import type { Signal, ActionContext } from '../core/types.js';

/**
 * A standard action handler — what .do() accepts.
 * Providers are factories that produce these.
 */
export type ActionHandler<T = Record<string, unknown>> = (
  signal: Signal<T>,
  ctx: ActionContext
) => Promise<void>;

// ----------------------------------------------------------
// Provider configs
// ----------------------------------------------------------

/**
 * Config for the Claude agent provider (withAgent).
 * Uses Claude Agent SDK for full agentic coding capabilities.
 */
export interface AgentProviderConfig<T = Record<string, unknown>> {
  /** Model to use. Defaults to 'claude-sonnet-4-5-20250929'. */
  model?: string;

  /**
   * Build the prompt from the incoming signal.
   * Can return a string or a message array for multi-turn context.
   */
  prompt: string | ((signal: Signal<T>) => string | Promise<string>);

  /**
   * System prompt for the agent. Sets the agent's role and constraints.
   */
  systemPrompt?: string;

  /**
   * Tools the agent is allowed to use. Claude Agent SDK tool names
   * like 'Read', 'Edit', 'Bash', 'Glob', 'Grep', etc.
   */
  allowedTools?: string[];

  /**
   * @deprecated Use `allowedTools` instead. Kept for backward compatibility.
   */
  tools?: string[];

  /**
   * Tools the agent is explicitly forbidden from using.
   * Takes precedence over allowedTools.
   */
  disallowedTools?: string[];

  /**
   * Working directory for the agent session.
   * Can be static or derived from the signal.
   */
  workingDirectory?: string | ((signal: Signal<T>) => string);

  /**
   * @deprecated The Claude Agent SDK does not use maxTokens directly.
   * Use maxTurns or maxBudgetUsd to control agent scope instead.
   */
  maxTokens?: number;

  /** Maximum conversation turns before the agent stops. */
  maxTurns?: number;

  /** Maximum budget in USD for a single agent invocation. Defaults to 1.0. */
  maxBudgetUsd?: number;

  /**
   * Permission mode for the agent session.
   * - 'bypassPermissions': skip all permission checks (default for colonies)
   * - 'acceptEdits': auto-accept file edits but prompt for other tools
   * - 'default': standard permission behavior
   */
  permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'default';

  /**
   * Streaming observability callback — called for each SDK message.
   * Errors in this callback are caught and do not crash the agent.
   */
  onMessage?: (message: unknown) => void;

  /**
   * Environment variables to pass to the agent process.
   * Use this to provide ANTHROPIC_API_KEY explicitly.
   */
  env?: Record<string, string>;

  /**
   * Map the agent's output to signal deposits.
   * If not provided, the raw output is deposited as-is.
   */
  output?: OutputMapping<T>;

  /**
   * Whether to auto-withdraw the triggering signal after success.
   * Defaults to true.
   */
  autoWithdraw?: boolean;
}

/**
 * Result returned by the Claude Agent SDK after an agent run.
 */
export interface AgentResult {
  /** The final text output from the agent. */
  text: string;
  /** Total cost in USD for the agent run. */
  costUsd: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Token usage for the run. */
  usage: { input_tokens: number; output_tokens: number };
  /** Result subtype: 'success', 'error_max_turns', 'error_during_execution', etc. */
  subtype: string;
  /** All messages from the agent conversation (for debugging). */
  messages: unknown[];
}

/**
 * Config for structured output provider (withStructuredOutput).
 * Calls an LLM and validates the response against a schema.
 * Provider-agnostic — works with any model that supports JSON output.
 */
export interface StructuredOutputConfig<T = Record<string, unknown>, R = Record<string, unknown>> {
  /** Model identifier. Format depends on the SDK you're using. */
  model: string;

  /**
   * Provider SDK to use for the LLM call.
   * 'anthropic' = @anthropic-ai/sdk
   * 'openai' = openai SDK
   * 'vercel-ai' = Vercel AI SDK (ai package)
   * Or pass a custom function.
   */
  provider?: 'anthropic' | 'openai' | 'vercel-ai' | LLMCallFunction<R>;

  /** Build the prompt from the signal. */
  prompt: string | ((signal: Signal<T>) => string | Promise<string>);

  /** System prompt. */
  systemPrompt?: string;

  /**
   * Zod schema for the expected output.
   * The LLM response will be validated against this.
   * Pass the schema object directly — we'll handle serialization.
   */
  schema?: any; // ZodType — kept as any to avoid hard Zod dependency

  /** Max tokens. */
  maxTokens?: number;

  /** Temperature (0-1). Lower = more deterministic. */
  temperature?: number;

  /**
   * Route the output to different signal types based on the result.
   * If a string, deposits that type with the full result as payload.
   * If a function, returns the signal type to deposit.
   */
  route: string | ((result: R, signal: Signal<T>) => SignalDeposit | SignalDeposit[]);

  autoWithdraw?: boolean;
}

/**
 * Config for bash provider (withBash).
 * Runs shell commands for mechanical tasks like git merge, deploy, etc.
 */
export interface BashProviderConfig<T = Record<string, unknown>> {
  /** The command to run. Can be static or derived from the signal. */
  command: string | ((signal: Signal<T>) => string | Promise<string>);

  /** Working directory for the command. */
  cwd?: string | ((signal: Signal<T>) => string);

  /** Timeout in ms. Defaults to 30_000. */
  timeout?: number;

  /** Map the command output to signal deposits. */
  output: OutputMapping<T>;

  autoWithdraw?: boolean;
}

// ----------------------------------------------------------
// Shared types
// ----------------------------------------------------------

/**
 * A custom LLM call function for providers not covered by built-in SDKs.
 * Takes a prompt and returns a structured result.
 */
export type LLMCallFunction<R = Record<string, unknown>> = (
  prompt: string,
  options: { systemPrompt?: string; maxTokens?: number; temperature?: number }
) => Promise<R>;

/**
 * Describes what signals to deposit after an action completes.
 */
export interface SignalDeposit {
  type: string;
  payload?: Record<string, unknown>;
  tags?: string[];
  ttl?: number;
}

/**
 * Maps action output to signal deposits.
 * Simple case: just a signal type (payload = full output).
 * Complex case: a function that decides what to deposit.
 */
export type OutputMapping<T = Record<string, unknown>> =
  | { type: string; tags?: string[]; ttl?: number }
  | ((result: any, signal: Signal<T>) => SignalDeposit | SignalDeposit[]);

// ----------------------------------------------------------
// Context assembly — building prompts from signal lineage
// ----------------------------------------------------------

/**
 * Options for assembling context from the signal environment.
 * Lets you pull in related signals to give the LLM richer context.
 */
export interface ContextAssemblyConfig {
  /**
   * Include the causal chain — signals that caused this one.
   * Walks the caused_by lineage up to `depth` levels.
   */
  includeLineage?: boolean;
  lineageDepth?: number;

  /**
   * Include sibling signals — other signals in the same causal family.
   */
  includeSiblings?: boolean;

  /**
   * Include related signals by type pattern.
   * e.g., 'review:*' to include all reviews related to this artifact.
   */
  includeRelated?: string[];

  /**
   * Custom context builder. Receives the signal and environment,
   * returns additional context to append to the prompt.
   */
  custom?: (signal: Signal, env: any) => Promise<string>;
}
