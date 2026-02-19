// PURPOSE: withAgent — Claude Agent SDK provider for full agentic colony actions.
// Wraps the Claude Agent SDK AsyncGenerator to give colonies coding capabilities.

import type { Signal, ActionContext } from '../core/types.js';
import type { AgentProviderConfig, AgentResult, ActionHandler, SignalDeposit } from './types.js';

/**
 * Creates an action handler powered by the Claude Agent SDK.
 *
 * The SDK must be installed separately:
 *   npm install @anthropic-ai/claude-agent-sdk
 *
 * The handler:
 * 1. Builds a prompt from the signal
 * 2. Spawns a Claude agent session via the SDK's query() AsyncGenerator
 * 3. Consumes all messages, calling onMessage for observability
 * 4. Extracts the final result (text, cost, duration, usage)
 * 5. Maps the agent's output to signal deposits
 * 6. Optionally withdraws the triggering signal
 */
export function withAgent<T = Record<string, unknown>>(
  config: AgentProviderConfig<T>
): ActionHandler<T> {
  const {
    model = 'claude-sonnet-4-5-20250929',
    prompt,
    systemPrompt,
    allowedTools,
    tools,
    disallowedTools,
    workingDirectory,
    maxTurns,
    maxBudgetUsd = 1.0,
    permissionMode = 'bypassPermissions',
    onMessage,
    env,
    output,
    autoWithdraw = true,
  } = config;

  // Resolve allowedTools with backward compat for deprecated `tools`
  const resolvedAllowedTools = allowedTools ?? tools;

  return async (signal: Signal<T>, ctx: ActionContext) => {
    // 1. Resolve the prompt
    const resolvedPrompt = typeof prompt === 'function'
      ? await prompt(signal)
      : prompt;

    // 2. Resolve working directory
    const cwd = typeof workingDirectory === 'function'
      ? workingDirectory(signal)
      : workingDirectory;

    // 3. Call Claude Agent SDK
    let agentResult: AgentResult;
    try {
      // Dynamic import — SDK is an optional peer dependency
      const sdk = await import('@anthropic-ai/claude-agent-sdk');

      const queryOptions: Record<string, unknown> = {
        model,
        systemPrompt: systemPrompt ?? buildDefaultSystemPrompt(ctx.colony),
        cwd: cwd ?? process.cwd(),
        permissionMode,
        allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
        maxBudgetUsd,
      };

      if (resolvedAllowedTools) queryOptions.allowedTools = resolvedAllowedTools;
      if (disallowedTools) queryOptions.disallowedTools = disallowedTools;
      if (maxTurns !== undefined) queryOptions.maxTurns = maxTurns;
      if (env) queryOptions.env = env;

      const generator = sdk.query({
        prompt: resolvedPrompt,
        options: queryOptions,
      });

      agentResult = await consumeGenerator(generator, onMessage);

    } catch (err: any) {
      if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
        throw new Error(
          'withAgent requires @anthropic-ai/claude-agent-sdk. Install it:\n' +
          '  npm install @anthropic-ai/claude-agent-sdk'
        );
      }
      throw err;
    }

    // 4. Deposit output signals
    const deposits = resolveOutput(output, agentResult, signal);
    for (const deposit of deposits) {
      await ctx.deposit(deposit.type, deposit.payload ?? { ...agentResult }, {
        causedBy: [signal.id],
        tags: deposit.tags,
        ttl: deposit.ttl,
      });
    }

    // 5. Withdraw the triggering signal
    if (autoWithdraw) {
      await ctx.withdraw(signal.id);
    }

    ctx.log(`Agent completed (${agentResult.subtype}). Cost: $${agentResult.costUsd.toFixed(4)}, Duration: ${agentResult.durationMs}ms. Deposited ${deposits.length} signal(s).`);
  };
}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

/**
 * Consumes the SDK's AsyncGenerator, collecting all messages and
 * extracting the final result from the SDKResultMessage.
 */
async function consumeGenerator(
  generator: AsyncGenerator<any, void>,
  onMessage?: (message: unknown) => void
): Promise<AgentResult> {
  const messages: unknown[] = [];
  let resultMessage: any = null;

  for await (const message of generator) {
    messages.push(message);

    // Call observability callback (errors must not crash the agent)
    if (onMessage) {
      try { onMessage(message); } catch { /* swallow */ }
    }

    // Capture the result message when it arrives
    if (message.type === 'result') {
      resultMessage = message;
    }
  }

  if (!resultMessage) {
    return {
      text: '',
      costUsd: 0,
      durationMs: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      subtype: 'error_during_execution',
      messages,
    };
  }

  return {
    text: resultMessage.result ?? resultMessage.errors?.join('\n') ?? '',
    costUsd: resultMessage.total_cost_usd ?? 0,
    durationMs: resultMessage.duration_ms ?? 0,
    usage: {
      input_tokens: resultMessage.usage?.input_tokens ?? 0,
      output_tokens: resultMessage.usage?.output_tokens ?? 0,
    },
    subtype: resultMessage.subtype ?? 'success',
    messages,
  };
}

export function buildDefaultSystemPrompt(colonyName: string): string {
  return [
    `You are an agent in the "${colonyName}" colony.`,
    'Complete the task described in the prompt.',
    'Be thorough but concise. Focus on the specific task at hand.',
    'If you create or modify files, ensure they compile/pass tests.',
  ].join('\n');
}

function resolveOutput<T>(
  output: AgentProviderConfig<T>['output'],
  result: any,
  signal: Signal<T>
): SignalDeposit[] {
  if (!output) {
    return [{ type: `${signal.type}:completed`, payload: result }];
  }

  if (typeof output === 'function') {
    const mapped = output(result, signal);
    return Array.isArray(mapped) ? mapped : [mapped];
  }

  return [{
    type: output.type,
    payload: result,
    tags: output.tags,
    ttl: output.ttl,
  }];
}
