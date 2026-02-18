// ============================================================
// withBash — Shell command provider
// ============================================================
// The lightweight provider for mechanical tasks: git merge,
// deploy scripts, file operations, test runners.
//
// No LLM involved — just runs a command and maps the output
// to signal deposits. Use this for Keepers, Deployers, and
// any colony that does deterministic work.
//
// Usage:
//   colony('keeper')
//     .do('merge', withBash({
//       command: (signal) => `git merge ${signal.payload.branch}`,
//       cwd: '/workspace/repo',
//       timeout: 30_000,
//       output: (result, signal) => ({
//         type: result.exitCode === 0 ? 'artifact:merged' : 'merge:failed',
//         payload: result,
//       }),
//     }))
//     .build();
// ============================================================

import { exec } from 'node:child_process';
import type { Signal, ActionContext } from '../core/types.js';
import type { BashProviderConfig, ActionHandler, SignalDeposit } from './types.js';

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Creates an action handler that runs a shell command
 * and maps the result to signal deposits.
 */
export function withBash<T = Record<string, unknown>>(
  config: BashProviderConfig<T>
): ActionHandler<T> {
  const {
    command,
    cwd,
    timeout = 30_000,
    output,
    autoWithdraw = true,
  } = config;

  return async (signal: Signal<T>, ctx: ActionContext) => {
    // 1. Resolve command and working directory
    const resolvedCommand = typeof command === 'function'
      ? await command(signal)
      : command;

    const resolvedCwd = typeof cwd === 'function'
      ? cwd(signal)
      : cwd ?? process.cwd();

    ctx.log(`Executing: ${resolvedCommand}`);

    // 2. Run the command
    const result = await executeCommand(resolvedCommand, resolvedCwd, timeout);

    // 3. Deposit output signals
    const deposits = resolveOutput(output, result, signal);
    for (const deposit of deposits) {
      await ctx.deposit(deposit.type, deposit.payload ?? (result as any), {
        causedBy: [signal.id],
        tags: deposit.tags,
        ttl: deposit.ttl,
      });
    }

    // 4. Withdraw
    if (autoWithdraw) {
      await ctx.withdraw(signal.id);
    }

    ctx.log(
      result.exitCode === 0
        ? `Command succeeded (${result.durationMs}ms)`
        : `Command failed with exit code ${result.exitCode} (${result.durationMs}ms)`
    );
  };
}

// ----------------------------------------------------------
// Command execution
// ----------------------------------------------------------

function executeCommand(
  command: string,
  cwd: string,
  timeout: number
): Promise<BashResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();

    exec(command, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
        exitCode: error?.code ?? (error ? 1 : 0),
        durationMs: Date.now() - startTime,
      });
    });
  });
}

// ----------------------------------------------------------
// Output mapping
// ----------------------------------------------------------

function resolveOutput<T>(
  output: BashProviderConfig<T>['output'],
  result: BashResult,
  signal: Signal<T>
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
