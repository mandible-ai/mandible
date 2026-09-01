// ============================================================
// withToolLoop — Native tool-calling loop against local vLLM
// ============================================================
// The heavyweight local provider. Replaces withClaudeCode for DGX
// deployments where all inference runs on local vLLM.
//
// Implements the ReAct loop:
//   1. Call vLLM with tools (OpenAI function-calling format)
//   2. Parse tool calls from response
//   3. Execute tools (file_read, file_write, bash, etc.)
//   4. Feed results back to vLLM
//   5. Repeat until done, max turns, or token budget exhausted
//
// Usage:
//   import { withToolLoop, fileReadTool, bashTool } from '@mandible-ai/mandible/providers';
//
//   colony('devops')
//     .sense('ci:failed', { unclaimed: true })
//     .do('investigate', withToolLoop({
//       endpoint: 'http://localhost:8001',
//       model: 'Qwen3-Coder-Next',
//       tools: [fileReadTool, fileEditTool, bashTool, grepTool],
//       maxTurns: 15,
//       maxBudget: { tokens: 100_000 },
//       workingDirectory: '/workspace/repo',
//       prompt: (signal) => `CI failed. Logs:\n${signal.payload.logs}\nInvestigate and fix.`,
//       output: (result) => ({
//         type: result.success ? 'devops:fixed' : 'devops:investigated',
//         payload: { summary: result.text, toolCalls: result.totalToolCalls },
//       }),
//     }))
//     .build();
// ============================================================

import { exec } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { promisify } from 'node:util';
import type { Signal, ActionContext } from '../core/types.js';
import type { ActionHandler, SignalDeposit, OutputMapping } from './types.js';

const execAsync = promisify(exec);

// ----------------------------------------------------------
// Configuration
// ----------------------------------------------------------

export interface ToolLoopConfig<T = Record<string, unknown>> {
  /** vLLM endpoint, e.g. 'http://localhost:8001'. */
  endpoint: string;

  /** Model name. Default: auto-detect from /v1/models. */
  model?: string;

  /** Optional API key for vLLM. */
  apiKey?: string;

  /** Build the prompt from the incoming signal. */
  prompt: string | ((signal: Signal<T>) => string | Promise<string>);

  /** System prompt for the agent. Sets role and constraints. */
  systemPrompt?: string;

  /**
   * Tools available to the agent. Use the built-in tool definitions
   * (fileReadTool, fileWriteTool, etc.) or define custom ones.
   */
  tools: ToolDefinition[];

  /** Maximum conversation turns (LLM calls). Default: 20. */
  maxTurns?: number;

  /** Token budget — stop when cumulative tokens exceed this. */
  maxBudget?: { tokens: number };

  /** Request timeout per LLM call in ms. Default: 120_000. */
  timeoutMs?: number;

  /**
   * Working directory for file operations and bash commands.
   * Can be static or derived from the signal.
   */
  workingDirectory?: string | ((signal: Signal<T>) => string);

  /**
   * Governance hook — called BEFORE each tool executes. Return
   * `{ deny: 'reason' }` to veto the call: the tool does not run, the
   * denial is fed back to the model as the tool result, and the
   * transcript entry records it. Use this to enforce capability
   * policies, audit-log calls before they act, or apply data
   * boundaries. A thrown error aborts the run.
   */
  beforeToolCall?: (call: BeforeToolCallEvent<T>) => ToolCallVerdict | void | Promise<ToolCallVerdict | void>;

  /**
   * Observability hook — called for each tool call.
   * Use for logging, metrics, or debugging.
   * Results are truncated here; the full text lives in `result.transcript`.
   */
  onToolCall?: (call: ToolCallEvent) => void;

  /**
   * Observability hook — called after each LLM response.
   */
  onTurn?: (turn: TurnEvent) => void;

  /**
   * Map the loop result to signal deposits.
   * If not provided, deposits the raw result as-is.
   */
  output?: OutputMapping<T>;

  /** Whether to auto-withdraw the triggering signal. Default: true. */
  autoWithdraw?: boolean;
}

// ----------------------------------------------------------
// Tool definition (OpenAI function-calling format)
// ----------------------------------------------------------

export interface ToolDefinition {
  /** Tool type — always 'function' for vLLM. */
  type: 'function';

  function: {
    /** Tool name. Must match the executor key. */
    name: string;

    /** Human-readable description for the LLM. */
    description: string;

    /** JSON Schema for the tool's parameters. */
    parameters: Record<string, unknown>;
  };

  /**
   * The executor function. Called when the LLM invokes this tool.
   * Receives parsed arguments and the working directory.
   * Returns a string result to feed back to the LLM.
   */
  execute: (args: Record<string, unknown>, cwd: string) => Promise<string>;
}

// ----------------------------------------------------------
// Result types
// ----------------------------------------------------------

/** What beforeToolCall saw, before the tool ran. */
export interface BeforeToolCallEvent<T = Record<string, unknown>> {
  tool: string;
  args: Record<string, unknown>;
  cwd: string;
  turn: number;
  signal: Signal<T>;
}

/** Returned by beforeToolCall to veto a tool call. */
export interface ToolCallVerdict {
  deny: string;
}

/**
 * One entry in the run's full transcript. Unlike ToolCallEvent, the
 * result is NOT truncated — this is the record an evidence store keeps.
 */
export interface ToolCallRecord {
  turn: number;
  tool: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
  error?: string;
  /** Set when beforeToolCall vetoed the call; the tool did not run. */
  denied?: string;
}

export interface ToolLoopResult {
  /** Final text output from the agent (last assistant message without tool calls). */
  text: string;

  /** Whether the loop completed normally (not via max turns or token budget). */
  success: boolean;

  /** Why the loop stopped. */
  stopReason: 'complete' | 'max_turns' | 'token_budget' | 'error' | 'refusal';

  /** The refusal text, when stopReason is 'refusal'. */
  refusal?: string;

  /** Total number of tool calls executed. */
  totalToolCalls: number;

  /** Total tokens used (prompt + completion). */
  totalTokens: { input: number; output: number };

  /** Wall-clock duration in ms. */
  durationMs: number;

  /** Number of LLM turns (API calls). */
  turns: number;

  /** Errors encountered during tool execution (non-fatal). */
  toolErrors: Array<{ tool: string; error: string }>;

  /** Tool calls vetoed by beforeToolCall. */
  deniedToolCalls: number;

  /** Full, untruncated record of every tool call in order. */
  transcript: ToolCallRecord[];
}

export interface ToolCallEvent {
  tool: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
  error?: string;
  /** Set when beforeToolCall vetoed the call; the tool did not run. */
  denied?: string;
}

export interface TurnEvent {
  turn: number;
  tokensUsed: { input: number; output: number };
  toolCalls: number;
  hasMoreToolCalls: boolean;
}

// ----------------------------------------------------------
// Provider factory
// ----------------------------------------------------------

/**
 * Creates an action handler that runs a tool-calling loop against vLLM.
 * The agent iterates: prompt → LLM → tool calls → results → LLM → ...
 * until the LLM produces a response with no tool calls, or limits are hit.
 */
export function withToolLoop<T = Record<string, unknown>>(
  config: ToolLoopConfig<T>
): ActionHandler<T> {
  const {
    endpoint: rawEndpoint,
    model,
    apiKey,
    prompt,
    systemPrompt,
    tools,
    maxTurns = 20,
    maxBudget,
    timeoutMs = 120_000,
    workingDirectory,
    beforeToolCall,
    onToolCall,
    onTurn,
    output,
    autoWithdraw = true,
  } = config;

  const endpoint = rawEndpoint.replace(/\/+$/, '');

  // Build the tool executor map
  const executors = new Map<string, ToolDefinition['execute']>();
  for (const tool of tools) {
    executors.set(tool.function.name, tool.execute);
  }

  // Build OpenAI-format tool specs (without the execute function)
  const toolSpecs = tools.map(t => ({
    type: t.type,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));

  return async (signal: Signal<T>, ctx: ActionContext) => {
    const startTime = Date.now();

    // Resolve prompt and working directory
    const resolvedPrompt = typeof prompt === 'function'
      ? await prompt(signal)
      : prompt;

    const cwd = typeof workingDirectory === 'function'
      ? workingDirectory(signal)
      : workingDirectory ?? process.cwd();

    // Resolve model (auto-detect if needed)
    const resolvedModel = model ?? await autoDetectModel(endpoint, apiKey, timeoutMs);

    // Build initial messages
    const messages: Array<Record<string, unknown>> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: resolvedPrompt });

    // Loop state
    let totalToolCalls = 0;
    let deniedToolCalls = 0;
    let totalTokens = { input: 0, output: 0 };
    let turn = 0;
    let lastText = '';
    const toolErrors: Array<{ tool: string; error: string }> = [];
    const transcript: ToolCallRecord[] = [];

    while (turn < maxTurns) {
      // Check token budget
      if (maxBudget && (totalTokens.input + totalTokens.output) >= maxBudget.tokens) {
        ctx.log(`Token budget exhausted (${totalTokens.input + totalTokens.output}/${maxBudget.tokens})`);
        const result = buildResult(lastText, 'token_budget', totalToolCalls, totalTokens, startTime, turn, toolErrors, deniedToolCalls, transcript);
        await depositResult(result, signal, ctx, output, autoWithdraw);
        return;
      }

      turn++;

      // Call vLLM
      const response = await callVLLMChat(endpoint, resolvedModel, messages, toolSpecs, apiKey, timeoutMs);

      // Track tokens
      if (response.usage) {
        totalTokens.input += response.usage.prompt_tokens ?? 0;
        totalTokens.output += response.usage.completion_tokens ?? 0;
      }

      const choice = response.choices?.[0];
      if (!choice) {
        ctx.log('No choices in vLLM response, stopping loop.', 'error');
        const result = buildResult(lastText, 'error', totalToolCalls, totalTokens, startTime, turn, toolErrors, deniedToolCalls, transcript);
        await depositResult(result, signal, ctx, output, autoWithdraw);
        return;
      }

      const assistantMessage = choice.message;
      messages.push(assistantMessage);

      // Extract text content
      if (assistantMessage.content) {
        lastText = assistantMessage.content;
      }

      // A refusal ends the run as its own outcome — not an error, and
      // never something to retry in a loop.
      if (choice.finish_reason === 'content_filter') {
        ctx.log('Model refused (finish_reason=content_filter).', 'warn');
        const result = buildResult(lastText, 'refusal', totalToolCalls, totalTokens, startTime, turn, toolErrors, deniedToolCalls, transcript);
        result.refusal = lastText || 'finish_reason=content_filter';
        await depositResult(result, signal, ctx, output, autoWithdraw);
        return;
      }

      const toolCalls = assistantMessage.tool_calls;
      const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;

      // Fire turn event
      onTurn?.({
        turn,
        tokensUsed: {
          input: response.usage?.prompt_tokens ?? 0,
          output: response.usage?.completion_tokens ?? 0,
        },
        toolCalls: hasToolCalls ? toolCalls.length : 0,
        hasMoreToolCalls: hasToolCalls,
      });

      // If no tool calls, the agent is done
      if (!hasToolCalls) {
        ctx.log(`Tool loop completed after ${turn} turns, ${totalToolCalls} tool calls.`);
        const result = buildResult(lastText, 'complete', totalToolCalls, totalTokens, startTime, turn, toolErrors, deniedToolCalls, transcript);
        await depositResult(result, signal, ctx, output, autoWithdraw);
        return;
      }

      // Execute each tool call
      for (const tc of toolCalls) {
        const toolName = tc.function?.name;
        const toolArgs = parseToolArgs(tc.function?.arguments);
        const callStart = Date.now();

        let toolResult: string;
        let callError: string | undefined;
        let callDenied: string | undefined;

        // The governance gate runs before anything executes. A veto is
        // final for this call: the executor is never reached.
        if (beforeToolCall) {
          const verdict = await beforeToolCall({ tool: toolName, args: toolArgs, cwd, turn, signal });
          if (verdict && typeof verdict === 'object' && 'deny' in verdict) {
            callDenied = verdict.deny;
          }
        }

        if (callDenied !== undefined) {
          toolResult = `Tool call denied: ${callDenied}`;
          deniedToolCalls++;
        } else {
          const executor = executors.get(toolName);
          if (!executor) {
            toolResult = `Error: Unknown tool "${toolName}". Available tools: ${[...executors.keys()].join(', ')}`;
            callError = `Unknown tool: ${toolName}`;
            toolErrors.push({ tool: toolName, error: callError });
          } else {
            try {
              toolResult = await executor(toolArgs, cwd);
            } catch (err: any) {
              const message: string = err?.message ?? String(err);
              toolResult = `Error executing ${toolName}: ${message}`;
              callError = message;
              toolErrors.push({ tool: toolName, error: message });
            }
          }
        }

        totalToolCalls++;
        const callDuration = Date.now() - callStart;

        transcript.push({
          turn,
          tool: toolName,
          args: toolArgs,
          result: toolResult,
          durationMs: callDuration,
          ...(callError !== undefined ? { error: callError } : {}),
          ...(callDenied !== undefined ? { denied: callDenied } : {}),
        });

        // Fire tool call event
        onToolCall?.({
          tool: toolName,
          args: toolArgs,
          result: toolResult.slice(0, 1000), // truncate for observability
          durationMs: callDuration,
          error: callError,
          ...(callDenied !== undefined ? { denied: callDenied } : {}),
        });

        // Add tool result to messages
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolResult,
        });
      }
    }

    // Max turns reached
    ctx.log(`Tool loop hit max turns (${maxTurns}). ${totalToolCalls} tool calls executed.`);
    const result = buildResult(lastText, 'max_turns', totalToolCalls, totalTokens, startTime, maxTurns, toolErrors, deniedToolCalls, transcript);
    await depositResult(result, signal, ctx, output, autoWithdraw);
  };
}

// ----------------------------------------------------------
// vLLM HTTP call (with tools)
// ----------------------------------------------------------

async function callVLLMChat(
  endpoint: string,
  model: string,
  messages: Array<Record<string, unknown>>,
  tools: Array<Record<string, unknown>>,
  apiKey?: string,
  timeoutMs: number = 120_000,
): Promise<any> {
  const url = `${endpoint}/v1/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const body: Record<string, unknown> = {
    model,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: tools.length > 0 ? 'auto' : undefined,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`vLLM tool-loop API error: ${response.status} ${response.statusText}\n${errorBody}`);
  }

  return response.json();
}

async function autoDetectModel(endpoint: string, apiKey?: string, timeoutMs: number = 10_000): Promise<string> {
  const url = `${endpoint}/v1/models`;
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Cannot auto-detect model: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { data?: Array<{ id: string }> };
  const models = data.data ?? [];
  if (models.length === 0) {
    throw new Error('No models loaded on vLLM server. Pass model explicitly or load a model.');
  }
  return models[0].id;
}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

function parseToolArgs(argsStr: string | undefined): Record<string, unknown> {
  if (!argsStr) return {};
  try {
    return JSON.parse(argsStr);
  } catch {
    return { raw: argsStr };
  }
}

function buildResult(
  text: string,
  stopReason: ToolLoopResult['stopReason'],
  totalToolCalls: number,
  totalTokens: { input: number; output: number },
  startTime: number,
  turns: number,
  toolErrors: Array<{ tool: string; error: string }>,
  deniedToolCalls: number,
  transcript: ToolCallRecord[],
): ToolLoopResult {
  return {
    text,
    success: stopReason === 'complete',
    stopReason,
    totalToolCalls,
    totalTokens,
    durationMs: Date.now() - startTime,
    turns,
    toolErrors,
    deniedToolCalls,
    transcript,
  };
}

async function depositResult<T>(
  result: ToolLoopResult,
  signal: Signal<T>,
  ctx: ActionContext,
  output: OutputMapping<T> | undefined,
  autoWithdraw: boolean,
): Promise<void> {
  if (output) {
    const deposits = resolveOutput(output, result, signal);
    for (const deposit of deposits) {
      await ctx.deposit(deposit.type, deposit.payload ?? (result as any), {
        causedBy: [signal.id],
        tags: deposit.tags,
        ttl: deposit.ttl,
      });
    }
  } else {
    await ctx.deposit('tool-loop:completed', result as any, {
      causedBy: [signal.id],
    });
  }

  if (autoWithdraw) {
    await ctx.withdraw(signal.id);
  }
}

function resolveOutput<T>(
  output: OutputMapping<T>,
  result: ToolLoopResult,
  signal: Signal<T>,
): SignalDeposit[] {
  if (typeof output === 'function') {
    const mapped = output(result, signal);
    return Array.isArray(mapped) ? mapped : [mapped];
  }
  return [{
    type: output.type,
    payload: result as any,
    tags: output.tags,
    ttl: output.ttl,
  }];
}

// ============================================================
// Built-in Tool Definitions
// ============================================================
// These tools mirror common coding agent capabilities.
// Each tool includes an OpenAI function-calling spec AND
// an executor that runs locally.
// ============================================================

/**
 * file_read — Read file contents from disk.
 *
 * Usage in colony config:
 *   tools: [fileReadTool]
 */
export const fileReadTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'file_read',
    description: 'Read the contents of a file. Returns the full text content of the file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path to the file to read.',
        },
      },
      required: ['path'],
    },
  },
  execute: async (args, cwd) => {
    const filePath = resolve(cwd, args.path as string);
    try {
      const content = await readFile(filePath, 'utf-8');
      return content;
    } catch (err: any) {
      return `Error reading ${filePath}: ${err.message}`;
    }
  },
};

/**
 * file_write — Write content to a file (creates directories if needed).
 *
 * Usage in colony config:
 *   tools: [fileWriteTool]
 */
export const fileWriteTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'file_write',
    description: 'Write content to a file. Creates the file and parent directories if they do not exist. Overwrites existing content.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to write.',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file.',
        },
      },
      required: ['path', 'content'],
    },
  },
  execute: async (args, cwd) => {
    const filePath = resolve(cwd, args.path as string);
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, args.content as string, 'utf-8');
      return `Successfully wrote ${(args.content as string).length} characters to ${filePath}`;
    } catch (err: any) {
      return `Error writing ${filePath}: ${err.message}`;
    }
  },
};

/**
 * file_edit — Replace a specific string in a file.
 * The LLM provides old_string and new_string for precise edits.
 *
 * Usage in colony config:
 *   tools: [fileEditTool]
 */
export const fileEditTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'file_edit',
    description: 'Replace a specific string in a file. The old_string must match exactly (including whitespace). If old_string appears multiple times, only the first occurrence is replaced.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to edit.',
        },
        old_string: {
          type: 'string',
          description: 'The exact string to find and replace.',
        },
        new_string: {
          type: 'string',
          description: 'The replacement string.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  execute: async (args, cwd) => {
    const filePath = resolve(cwd, args.path as string);
    try {
      const content = await readFile(filePath, 'utf-8');
      const oldStr = args.old_string as string;
      if (!content.includes(oldStr)) {
        return `Error: old_string not found in ${filePath}. Ensure the string matches exactly.`;
      }
      const newContent = content.replace(oldStr, args.new_string as string);
      await writeFile(filePath, newContent, 'utf-8');
      return `Successfully edited ${filePath}`;
    } catch (err: any) {
      return `Error editing ${filePath}: ${err.message}`;
    }
  },
};

/**
 * bash — Execute a shell command.
 *
 * Usage in colony config:
 *   tools: [bashTool]
 */
export const bashTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'bash',
    description: 'Execute a shell command and return stdout/stderr. Use for running tests, git commands, build tools, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute.',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds. Default: 30000.',
        },
      },
      required: ['command'],
    },
  },
  execute: async (args, cwd) => {
    const command = args.command as string;
    const timeout = (args.timeout as number) ?? 30_000;
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });
      const output = [
        stdout ? `stdout:\n${stdout}` : '',
        stderr ? `stderr:\n${stderr}` : '',
      ].filter(Boolean).join('\n');
      return output || '(no output)';
    } catch (err: any) {
      const output = [
        err.stdout ? `stdout:\n${err.stdout}` : '',
        err.stderr ? `stderr:\n${err.stderr}` : '',
        `exit code: ${err.code ?? 1}`,
      ].filter(Boolean).join('\n');
      return output;
    }
  },
};

/**
 * glob — Find files matching a glob pattern.
 *
 * Usage in colony config:
 *   tools: [globTool]
 */
export const globTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'glob',
    description: 'Find files matching a glob pattern. Returns a list of matching file paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match (e.g. "**/*.ts", "src/**/*.test.ts").',
        },
      },
      required: ['pattern'],
    },
  },
  execute: async (args, cwd) => {
    const pattern = args.pattern as string;
    try {
      // Use bash find as a portable glob implementation
      const { stdout } = await execAsync(
        `find . -path './${pattern}' -o -name '${pattern}' 2>/dev/null | head -100`,
        { cwd, timeout: 10_000 }
      );
      return stdout.trim() || '(no matches)';
    } catch {
      // Fallback: use ls with the pattern
      try {
        const { stdout } = await execAsync(`ls -1 ${pattern} 2>/dev/null | head -100`, { cwd, timeout: 10_000 });
        return stdout.trim() || '(no matches)';
      } catch {
        return '(no matches)';
      }
    }
  },
};

/**
 * grep — Search file contents using a regex pattern.
 *
 * Usage in colony config:
 *   tools: [grepTool]
 */
export const grepTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'grep',
    description: 'Search for a pattern in files. Returns matching lines with file paths and line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern to search for.',
        },
        path: {
          type: 'string',
          description: 'File or directory to search in. Default: current directory.',
        },
        include: {
          type: 'string',
          description: 'File glob to filter (e.g. "*.ts"). Optional.',
        },
      },
      required: ['pattern'],
    },
  },
  execute: async (args, cwd) => {
    const pattern = args.pattern as string;
    const searchPath = args.path ? resolve(cwd, args.path as string) : cwd;
    const include = args.include ? `--include='${args.include}'` : '';
    try {
      const { stdout } = await execAsync(
        `grep -rn ${include} '${pattern.replace(/'/g, "'\\''")}' '${searchPath}' 2>/dev/null | head -50`,
        { cwd, timeout: 10_000, maxBuffer: 5 * 1024 * 1024 }
      );
      return stdout.trim() || '(no matches)';
    } catch {
      return '(no matches)';
    }
  },
};

/**
 * list_dir — List directory contents.
 *
 * Usage in colony config:
 *   tools: [listDirTool]
 */
export const listDirTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'list_dir',
    description: 'List the contents of a directory. Returns file and directory names.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the directory. Default: current working directory.',
        },
      },
    },
  },
  execute: async (args, cwd) => {
    const dirPath = args.path ? resolve(cwd, args.path as string) : cwd;
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      return entries
        .map(e => `${e.isDirectory() ? '[DIR] ' : '      '}${e.name}`)
        .join('\n') || '(empty directory)';
    } catch (err: any) {
      return `Error listing ${dirPath}: ${err.message}`;
    }
  },
};
