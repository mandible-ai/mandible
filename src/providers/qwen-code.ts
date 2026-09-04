// PURPOSE: Wraps the qwen headless CLI as a Mandible action provider
// PURPOSE: Spawns `qwen -p`, parses its structured output, deposits the result as signals
// ============================================================
// withQwenCode — Subprocess wrapper for the qwen-code CLI agent
// ============================================================
// qwen-code (Apache 2.0) is Qwen's terminal coding agent — the
// same shape as Claude Code. It reads files, writes code, runs
// tests and fixes bugs, and it speaks any OpenAI-compatible
// endpoint, so it runs entirely on local vLLM inference.
//
// This provider spawns it in headless mode (`qwen -p`), parses
// the structured session output, and deposits the outcome.
//
// Two things matter for unattended runs:
//   1. Approval mode. Headless runs still gate write/shell tools
//      behind approval, so the default here is 'yolo'. Pair it
//      with `sandbox` or `excludeTools` on shared machines.
//   2. Budgets. `maxSessionTurns` / `maxToolCalls` / `maxWallTime`
//      are enforced by the CLI itself and surface as distinct
//      stop reasons, so a colony can tell "ran out of budget"
//      apart from "failed".
//
// Prerequisites:
//   npm install -g @qwen-code/qwen-code@latest
//
// Usage:
//   import { withQwenCode } from '@mandible-ai/mandible/providers';
//
//   colony('devops')
//     .sense('ci:failed', { unclaimed: true })
//     .do('fix-build', withQwenCode({
//       endpoint: 'http://localhost:8001',
//       model: 'Qwen3-Coder-Next',
//       prompt: (signal) => `CI failed for PR #${signal.payload.pr}. Fix the build.`,
//       workingDirectory: '/workspace/repo',
//       maxSessionTurns: 30,
//       maxWallTime: '10m',
//       output: (result) => ({
//         type: result.stopReason === 'success' ? 'fix:applied' : 'fix:failed',
//         payload: { summary: result.text, pr: signal.payload.pr },
//       }),
//     }))
//     .build();
// ============================================================

import { spawn } from 'node:child_process';
import type { Signal, ActionContext } from '../core/types.js';
import type { ActionHandler, OutputMapping, SignalDeposit } from './types.js';

// ----------------------------------------------------------
// Configuration
// ----------------------------------------------------------

/** Tool approval policy for the run. Maps to `--approval-mode`. */
export type QwenApprovalMode = 'plan' | 'default' | 'auto-edit' | 'auto' | 'yolo';

/** Output format for the headless session. Maps to `--output-format`. */
export type QwenOutputFormat = 'text' | 'json' | 'stream-json';

/**
 * Why the session ended. Derived from the CLI's exit codes, which
 * are distinct enough to branch on when mapping to signals.
 */
export type QwenStopReason =
  | 'success'
  | 'error'
  | 'max-turns'
  | 'budget'
  | 'interrupted'
  | 'timeout'
  | 'spawn-failed';

export interface QwenCodeConfig<T = Record<string, unknown>> {
  /** OpenAI-compatible endpoint (vLLM, Ollama, a hosted gateway). */
  endpoint: string;

  /** Model name. Default: 'Qwen3-Coder-Next'. */
  model?: string;

  /** Optional API key. Local vLLM usually needs none. */
  apiKey?: string;

  /** Build the prompt from the incoming signal. */
  prompt: string | ((signal: Signal<T>) => string | Promise<string>);

  /**
   * Working directory for the qwen session.
   * Can be static or derived from the signal.
   */
  workingDirectory?: string | ((signal: Signal<T>) => string);

  /**
   * Tool approval policy. Default: 'yolo'.
   *
   * Anything stricter than 'yolo' or 'auto' will stall an unattended
   * run, because there is no one present to approve a tool call.
   * 'yolo' does NOT sandbox — set `sandbox` or `excludeTools` when
   * the agent runs anywhere you care about.
   */
  approvalMode?: QwenApprovalMode;

  /**
   * Output format. Default: 'json' — the structured session, parsed
   * into `messages` / `usage` / `toolCalls`. Use 'stream-json' to
   * observe messages live via `onMessage`; 'text' skips parsing.
   */
  outputFormat?: QwenOutputFormat;

  /** Cap on user/model/tool turns. Default: 20. Maps to `--max-session-turns`. */
  maxSessionTurns?: number;

  /** Cumulative top-level tool-call budget. Maps to `--max-tool-calls`. */
  maxToolCalls?: number;

  /**
   * Wall-clock budget enforced by the CLI. Accepts the CLI's own
   * forms — `90` (seconds), '30s', '5m', '1h'. Maps to `--max-wall-time`.
   * This is the cooperative budget; `timeout` is the hard kill.
   */
  maxWallTime?: string | number;

  /** Tools the agent may not use, e.g. ['shell', 'write']. Maps to `--exclude-tools`. */
  excludeTools?: string[];

  /** Extra directories to bring into context. Maps to `--include-directories`. */
  includeDirectories?: string[];

  /** Replace the built-in system prompt for this run. */
  systemPrompt?: string;

  /** Append extra instructions to the system prompt for this run. */
  appendSystemPrompt?: string;

  /** Run tools inside the CLI's sandbox image. Maps to `--sandbox`. */
  sandbox?: boolean;

  /**
   * Retry transient 429/529 responses indefinitely (with backoff).
   * Sets QWEN_CODE_UNATTENDED_RETRY=1. Pair with `maxWallTime` so a
   * persistently failing provider cannot stall the colony forever.
   */
  unattendedRetry?: boolean;

  /** Hard subprocess kill in ms. Default: 600_000 (10 min). */
  timeout?: number;

  /** Additional environment variables for the subprocess. */
  env?: Record<string, string>;

  /** Path to the qwen binary. Default: 'qwen' (from PATH). */
  binary?: string;

  /** Map the result to signal deposits. Defaults to depositing the raw result. */
  output?: OutputMapping<T>;

  /** Whether to auto-withdraw the triggering signal. Default: true. */
  autoWithdraw?: boolean;

  /** Observability hook — raw stdout chunks as they arrive. */
  onOutput?: (chunk: string) => void;

  /**
   * Observability hook — parsed messages as they arrive.
   * Only fires when `outputFormat` is 'stream-json'.
   */
  onMessage?: (message: QwenMessage) => void;
}

// ----------------------------------------------------------
// Result types
// ----------------------------------------------------------

/** A single message from a structured qwen session. */
export interface QwenMessage {
  /** 'system' | 'assistant' | 'user' | 'result' | 'stream_event' | ... */
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  model?: string;
  is_error?: boolean;
  duration_ms?: number;
  /** Final answer text — present on the terminal 'result' message. */
  result?: string;
  usage?: QwenUsage;
  message?: {
    role?: string;
    model?: string;
    content?: Array<{ type: string; text?: string; name?: string }>;
    usage?: QwenUsage;
  };
  stats?: {
    tools?: { totalCalls?: number };
    models?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface QwenUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface QwenCodeResult {
  /**
   * The agent's final answer. Taken from the terminal 'result'
   * message when the session parses, otherwise the raw stdout.
   */
  text: string;

  /** Raw stdout, untouched. */
  stdout: string;

  /** stderr output (progress, warnings, retry heartbeats). */
  stderr: string;

  /** Process exit code. 0 = success, 53 = turn cap, 55 = budget, 130 = interrupt. */
  exitCode: number;

  /** Why the session ended — branch on this when mapping to signals. */
  stopReason: QwenStopReason;

  /** Wall-clock duration in ms. */
  durationMs: number;

  /** Whether the session exited cleanly (exit code 0). */
  success: boolean;

  /** Whether the CLI itself reported an error result. */
  isError: boolean;

  /** Whether the hard `timeout` killed the subprocess. */
  timedOut: boolean;

  /** Session id — reusable with the CLI's --resume. */
  sessionId?: string;

  /** Model the session actually ran with. */
  model?: string;

  /** Result subtype, e.g. 'success' | 'error_during_execution'. */
  subtype?: string;

  /** Token usage for the run. Zeroed when unavailable. */
  usage: QwenUsage;

  /** Number of tool calls the agent made. */
  toolCalls: number;

  /** All parsed session messages. Empty in 'text' mode or on a parse failure. */
  messages: QwenMessage[];
}

// ----------------------------------------------------------
// Provider factory
// ----------------------------------------------------------

/**
 * Creates an action handler that runs a headless qwen session.
 * The subprocess talks to an OpenAI-compatible endpoint and does
 * its own tool execution.
 */
export function withQwenCode<T = Record<string, unknown>>(
  config: QwenCodeConfig<T>
): ActionHandler<T> {
  const {
    endpoint,
    model = 'Qwen3-Coder-Next',
    apiKey,
    prompt,
    workingDirectory,
    approvalMode = 'yolo',
    outputFormat = 'json',
    maxSessionTurns = 20,
    maxToolCalls,
    maxWallTime,
    excludeTools,
    includeDirectories,
    systemPrompt,
    appendSystemPrompt,
    sandbox = false,
    unattendedRetry = false,
    timeout = 600_000,
    env: extraEnv = {},
    binary = 'qwen',
    output,
    autoWithdraw = true,
    onOutput,
    onMessage,
  } = config;

  return async (signal: Signal<T>, ctx: ActionContext) => {
    const resolvedPrompt = typeof prompt === 'function'
      ? await prompt(signal)
      : prompt;

    const cwd = typeof workingDirectory === 'function'
      ? workingDirectory(signal)
      : workingDirectory ?? process.cwd();

    ctx.log(`Starting qwen session in ${cwd}`);

    const processEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      OPENAI_BASE_URL: normalizeBaseUrl(endpoint),
      OPENAI_API_KEY: apiKey ?? 'not-needed',  // local servers usually need no key
      OPENAI_MODEL: model,
      ...(unattendedRetry ? { QWEN_CODE_UNATTENDED_RETRY: '1' } : {}),
      ...extraEnv,
    };

    const args = buildQwenArgs({
      prompt: resolvedPrompt,
      model,
      approvalMode,
      outputFormat,
      maxSessionTurns,
      maxToolCalls,
      maxWallTime,
      excludeTools,
      includeDirectories,
      systemPrompt,
      appendSystemPrompt,
      sandbox,
    });

    const result = await runQwen({
      binary,
      args,
      cwd,
      env: processEnv,
      timeout,
      outputFormat,
      onOutput,
      onMessage,
    });

    ctx.log(
      result.stopReason === 'success'
        ? `qwen completed in ${result.durationMs}ms (${result.toolCalls} tool calls, ${result.usage.output_tokens} output tokens)`
        : `qwen ended: ${result.stopReason} (exit ${result.exitCode}, ${result.durationMs}ms)`
    );

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
      await ctx.deposit('qwen-code:completed', result as any, {
        causedBy: [signal.id],
      });
    }

    if (autoWithdraw) {
      await ctx.withdraw(signal.id);
    }
  };
}

// ----------------------------------------------------------
// Endpoint + argv construction
// ----------------------------------------------------------

/** The CLI expects an OpenAI-style base URL, so ensure exactly one /v1 suffix. */
function normalizeBaseUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

interface QwenArgsInput {
  prompt: string;
  model: string;
  approvalMode: QwenApprovalMode;
  outputFormat: QwenOutputFormat;
  maxSessionTurns: number;
  maxToolCalls?: number;
  maxWallTime?: string | number;
  excludeTools?: string[];
  includeDirectories?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  sandbox: boolean;
}

function buildQwenArgs(input: QwenArgsInput): string[] {
  const args: string[] = [
    '-p', input.prompt,
    '--model', input.model,
    '--output-format', input.outputFormat,
    '--approval-mode', input.approvalMode,
    '--max-session-turns', String(input.maxSessionTurns),
  ];

  if (input.maxToolCalls !== undefined) {
    args.push('--max-tool-calls', String(input.maxToolCalls));
  }
  if (input.maxWallTime !== undefined) {
    args.push('--max-wall-time', String(input.maxWallTime));
  }
  if (input.excludeTools?.length) {
    args.push('--exclude-tools', input.excludeTools.join(','));
  }
  if (input.includeDirectories?.length) {
    args.push('--include-directories', input.includeDirectories.join(','));
  }
  if (input.systemPrompt) {
    args.push('--system-prompt', input.systemPrompt);
  }
  if (input.appendSystemPrompt) {
    args.push('--append-system-prompt', input.appendSystemPrompt);
  }
  if (input.sandbox) {
    args.push('--sandbox');
  }

  return args;
}

// ----------------------------------------------------------
// Subprocess management
// ----------------------------------------------------------

interface RunInput {
  binary: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeout: number;
  outputFormat: QwenOutputFormat;
  onOutput?: (chunk: string) => void;
  onMessage?: (message: QwenMessage) => void;
}

function runQwen(input: RunInput): Promise<QwenCodeResult> {
  const { binary, args, cwd, env, timeout, outputFormat, onOutput, onMessage } = input;

  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    // stream-json arrives line-delimited and may split mid-line
    // across chunks, so messages are assembled from a line buffer.
    const streamed: QwenMessage[] = [];
    let lineBuffer = '';

    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 5000);
    }, timeout);

    const clearTimers = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      onOutput?.(chunk);

      if (outputFormat !== 'stream-json') return;
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const message = parseLine(line);
        if (!message) continue;
        streamed.push(message);
        onMessage?.(message);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimers();

      if (outputFormat === 'stream-json') {
        const message = parseLine(lineBuffer);
        if (message) {
          streamed.push(message);
          onMessage?.(message);
        }
      }

      const exitCode = code ?? (timedOut ? 124 : 1);
      const messages = outputFormat === 'stream-json'
        ? streamed
        : parseJsonSession(stdout, outputFormat);

      resolve(buildResult({
        stdout,
        stderr,
        exitCode,
        timedOut,
        messages,
        durationMs: Date.now() - startTime,
      }));
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(buildResult({
        stdout: '',
        stderr: [
          `Failed to spawn ${binary}: ${err.message}.`,
          '',
          'Ensure the qwen CLI is installed:',
          '  npm install -g @qwen-code/qwen-code@latest',
          '',
          'Or point at it directly:',
          "  withQwenCode({ binary: '/path/to/qwen', ... })",
        ].join('\n'),
        exitCode: 127,
        timedOut: false,
        messages: [],
        durationMs: Date.now() - startTime,
        spawnFailed: true,
      }));
    });
  });
}

// ----------------------------------------------------------
// Session parsing
// ----------------------------------------------------------

function parseLine(line: string): QwenMessage | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return isMessage(parsed) ? parsed : undefined;
  } catch {
    return undefined;  // interleaved non-JSON output is not fatal
  }
}

/** `--output-format json` buffers the whole session into one JSON array. */
function parseJsonSession(stdout: string, outputFormat: QwenOutputFormat): QwenMessage[] {
  if (outputFormat !== 'json') return [];
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.filter(isMessage) : [];
  } catch {
    return [];  // fall back to raw text rather than failing the action
  }
}

function isMessage(value: unknown): value is QwenMessage {
  return typeof value === 'object' && value !== null && typeof (value as any).type === 'string';
}

interface RawRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  messages: QwenMessage[];
  durationMs: number;
  spawnFailed?: boolean;
}

function buildResult(raw: RawRun): QwenCodeResult {
  let resultMessage: QwenMessage | undefined;
  for (let i = raw.messages.length - 1; i >= 0; i--) {
    if (raw.messages[i].type === 'result') {
      resultMessage = raw.messages[i];
      break;
    }
  }
  const usage = resultMessage?.usage
    ? normalizeUsage(resultMessage.usage)
    : sumAssistantUsage(raw.messages);
  const isError = resultMessage?.is_error ?? raw.exitCode !== 0;
  const stopReason = raw.exitCode === 0 && isError ? 'error' : stopReasonFor(raw);

  return {
    text: resultMessage?.result ?? assistantText(raw.messages) ?? raw.stdout.trim(),
    stdout: raw.stdout,
    stderr: raw.stderr.trim(),
    exitCode: raw.exitCode,
    stopReason,
    durationMs: raw.durationMs,
    success: stopReason === 'success',
    isError,
    timedOut: raw.timedOut,
    sessionId: raw.messages.find((m) => m.session_id)?.session_id,
    model: raw.messages.find((m) => m.model ?? m.message?.model)?.model
      ?? raw.messages.find((m) => m.message?.model)?.message?.model,
    subtype: resultMessage?.subtype,
    usage,
    toolCalls: resultMessage?.stats?.tools?.totalCalls ?? countToolCalls(raw.messages),
    messages: raw.messages,
  };
}

/**
 * The CLI reserves distinct exit codes for budget overruns, so a
 * colony can tell an exhausted budget apart from a real failure.
 */
function stopReasonFor(raw: RawRun): QwenStopReason {
  if (raw.spawnFailed) return 'spawn-failed';
  if (raw.timedOut) return 'timeout';
  switch (raw.exitCode) {
    case 0: return 'success';
    case 53: return 'max-turns';
    case 55: return 'budget';
    case 130: return 'interrupted';
    default: return 'error';
  }
}

function assistantText(messages: QwenMessage[]): string | undefined {
  const blocks = messages
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => m.message?.content ?? [])
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text as string);

  return blocks.length > 0 ? blocks.join('\n') : undefined;
}

function countToolCalls(messages: QwenMessage[]): number {
  return messages
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => m.message?.content ?? [])
    .filter((block) => block.type === 'tool_use')
    .length;
}

function normalizeUsage(usage: Partial<QwenUsage>): QwenUsage {
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
  };
}

function sumAssistantUsage(messages: QwenMessage[]): QwenUsage {
  return messages.reduce<QwenUsage>((total, message) => {
    const usage = message.message?.usage ?? (message.type === 'assistant' ? message.usage : undefined);
    if (!usage) return total;
    return {
      input_tokens: total.input_tokens + (usage.input_tokens ?? 0),
      output_tokens: total.output_tokens + (usage.output_tokens ?? 0),
    };
  }, { input_tokens: 0, output_tokens: 0 });
}

// ----------------------------------------------------------
// Output mapping
// ----------------------------------------------------------

function resolveOutput<T>(
  output: OutputMapping<T>,
  result: QwenCodeResult,
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