// ============================================================
// withQwenCode — Subprocess wrapper for qwen-code CLI agent
// ============================================================
// Wraps the qwen-code open-source terminal agent (Apache 2.0)
// as a Mandible action provider. qwen-code is Qwen's equivalent
// of Claude Code — a terminal agent that can read files, write
// code, run tests, and fix bugs using local vLLM inference.
//
// qwen-code supports self-hosted endpoints via OPENAI_BASE_URL.
// This provider spawns it as a subprocess in non-interactive mode,
// points it at the local vLLM, and captures the output.
//
// Same pattern as withClaudeCode (wraps Claude Agent SDK) but for
// local DGX deployments where all inference is on-device.
//
// Prerequisites:
//   npm install -g qwen-code   (or have it in PATH)
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
//       maxTurns: 20,
//       timeout: 600_000,
//       output: (result) => ({
//         type: result.exitCode === 0 ? 'fix:applied' : 'fix:failed',
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

export interface QwenCodeConfig<T = Record<string, unknown>> {
  /** vLLM endpoint — sets OPENAI_BASE_URL for qwen-code. */
  endpoint: string;

  /** Model name. Default: 'Qwen3-Coder-Next'. */
  model?: string;

  /** Optional API key — sets OPENAI_API_KEY for qwen-code. */
  apiKey?: string;

  /** Build the prompt from the incoming signal. */
  prompt: string | ((signal: Signal<T>) => string | Promise<string>);

  /**
   * Working directory for the qwen-code session.
   * Can be static or derived from the signal.
   */
  workingDirectory?: string | ((signal: Signal<T>) => string);

  /**
   * Maximum conversation turns for qwen-code. Default: 20.
   * Maps to qwen-code's --max-turns flag.
   */
  maxTurns?: number;

  /** Timeout in ms for the entire session. Default: 600_000 (10 min). */
  timeout?: number;

  /**
   * Shell commands the agent is allowed to run.
   * If not set, qwen-code uses its default allowed commands.
   */
  allowedCommands?: string[];

  /**
   * Additional environment variables to pass to the subprocess.
   */
  env?: Record<string, string>;

  /**
   * Path to the qwen-code binary. Default: 'qwen-code' (from PATH).
   */
  binary?: string;

  /**
   * Map the output to signal deposits.
   * If not provided, deposits the raw result.
   */
  output?: OutputMapping<T>;

  /** Whether to auto-withdraw the triggering signal. Default: true. */
  autoWithdraw?: boolean;

  /**
   * Observability hook — called with chunks of stdout as they arrive.
   * Use for real-time logging or progress tracking.
   */
  onOutput?: (chunk: string) => void;
}

// ----------------------------------------------------------
// Result types
// ----------------------------------------------------------

export interface QwenCodeResult {
  /** Combined stdout from the qwen-code session. */
  text: string;

  /** stderr output (usually progress/debug info). */
  stderr: string;

  /** Process exit code. 0 = success. */
  exitCode: number;

  /** Wall-clock duration in ms. */
  durationMs: number;

  /** Whether the session completed successfully (exit code 0). */
  success: boolean;

  /** Whether the session was killed by timeout. */
  timedOut: boolean;
}

// ----------------------------------------------------------
// Provider factory
// ----------------------------------------------------------

/**
 * Creates an action handler that spawns a qwen-code subprocess.
 * The subprocess runs against local vLLM and executes agentic coding tasks.
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
    maxTurns = 20,
    timeout = 600_000,
    allowedCommands,
    env: extraEnv = {},
    binary = 'qwen-code',
    output,
    autoWithdraw = true,
    onOutput,
  } = config;

  return async (signal: Signal<T>, ctx: ActionContext) => {
    const startTime = Date.now();

    // Resolve prompt and working directory
    const resolvedPrompt = typeof prompt === 'function'
      ? await prompt(signal)
      : prompt;

    const cwd = typeof workingDirectory === 'function'
      ? workingDirectory(signal)
      : workingDirectory ?? process.cwd();

    ctx.log(`Starting qwen-code session in ${cwd}`);

    // Build environment
    const processEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      OPENAI_BASE_URL: endpoint.replace(/\/+$/, '') + '/v1',
      OPENAI_API_KEY: apiKey ?? 'not-needed',  // vLLM doesn't require a key by default
      ...extraEnv,
    };

    // Build args
    const args = buildQwenCodeArgs(resolvedPrompt, model, maxTurns, allowedCommands);

    // Spawn subprocess
    const result = await runQwenCode(binary, args, cwd, processEnv, timeout, onOutput);

    ctx.log(
      result.success
        ? `qwen-code completed in ${result.durationMs}ms`
        : `qwen-code ${result.timedOut ? 'timed out' : 'failed'} (exit ${result.exitCode}, ${result.durationMs}ms)`
    );

    // Deposit results
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
// Subprocess management
// ----------------------------------------------------------

function buildQwenCodeArgs(
  prompt: string,
  model: string,
  maxTurns: number,
  allowedCommands?: string[],
): string[] {
  const args: string[] = [
    '-p', prompt,           // Non-interactive mode with prompt
    '--model', model,
    '--max-turns', String(maxTurns),
  ];

  if (allowedCommands && allowedCommands.length > 0) {
    args.push('--allowed-commands', allowedCommands.join(','));
  }

  return args;
}

function runQwenCode(
  binary: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeout: number,
  onOutput?: (chunk: string) => void,
): Promise<QwenCodeResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Set up timeout
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Force kill after 5s if SIGTERM doesn't work
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
    }, timeout);

    child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      onOutput?.(chunk);
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        text: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? (timedOut ? 124 : 1),
        durationMs: Date.now() - startTime,
        success: code === 0,
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        text: '',
        stderr: `Failed to spawn ${binary}: ${err.message}.\n\nEnsure qwen-code is installed:\n  npm install -g qwen-code\n\nOr specify the path:\n  withQwenCode({ binary: '/path/to/qwen-code', ... })`,
        exitCode: 127,
        durationMs: Date.now() - startTime,
        success: false,
        timedOut: false,
      });
    });
  });
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
