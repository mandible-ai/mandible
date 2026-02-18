// ============================================================
// withAgent — Claude Code SDK Provider
// ============================================================
// Wraps the Claude Code SDK to give colonies full agentic
// capabilities: file editing, bash execution, code review,
// multi-turn tool use loops.
//
// This is the heavyweight provider — use it for colonies that
// need to do real coding work (Shapers, complex Critics).
//
// Usage:
//   colony('shaper')
//     .do('shape', withAgent({
//       prompt: (signal) => `Implement: ${signal.payload.description}`,
//       systemPrompt: 'You are a senior engineer. Write clean, tested code.',
//       tools: ['file_edit', 'bash'],
//       workingDirectory: (signal) => `/workspace/${signal.payload.name}`,
//       output: { type: 'artifact:shaped', tags: ['needs-review'] },
//     }))
//     .build();
// ============================================================

import type { Signal, ActionContext } from '../core/types.js';
import type { AgentProviderConfig, ActionHandler, SignalDeposit } from './types.js';

/**
 * Creates an action handler powered by the Claude Code SDK.
 *
 * The SDK must be installed separately:
 *   npm install @anthropic-ai/claude-code
 *
 * The handler:
 * 1. Builds a prompt from the signal
 * 2. Spawns a Claude Code agent session with the specified tools
 * 3. Lets the agent work (tool use loop runs internally)
 * 4. Maps the agent's output to signal deposits
 * 5. Optionally withdraws the triggering signal
 */
export function withAgent<T = Record<string, unknown>>(
  config: AgentProviderConfig<T>
): ActionHandler<T> {
  const {
    model = 'claude-sonnet-4-5-20250929',
    prompt,
    systemPrompt,
    tools,
    workingDirectory,
    maxTokens = 8192,
    output,
    autoWithdraw = true,
  } = config;

  return async (signal: Signal<T>, ctx: ActionContext) => {
    // 1. Resolve the prompt
    const resolvedPrompt = typeof prompt === 'function'
      ? await prompt(signal)
      : prompt;

    // 2. Resolve working directory
    const cwd = typeof workingDirectory === 'function'
      ? workingDirectory(signal)
      : workingDirectory;

    // 3. Call Claude Code SDK
    let agentResult: any;
    try {
      // Dynamic import — SDK is an optional peer dependency
      const { query } = await import('@anthropic-ai/claude-code');

      const messages = await query({
        prompt: resolvedPrompt,
        options: {
          model,
          maxTokens,
          systemPrompt: systemPrompt ?? buildDefaultSystemPrompt(ctx.colony),
          allowedTools: tools,
          cwd: cwd ?? process.cwd(),
        },
      });

      // Extract the final assistant text from the conversation
      agentResult = extractResult(messages);

    } catch (err: any) {
      if (err.code === 'MODULE_NOT_FOUND') {
        throw new Error(
          'withAgent requires @anthropic-ai/claude-code. Install it:\n' +
          '  npm install @anthropic-ai/claude-code'
        );
      }
      throw err;
    }

    // 4. Deposit output signals
    const deposits = resolveOutput(output, agentResult, signal);
    for (const deposit of deposits) {
      await ctx.deposit(deposit.type, deposit.payload ?? agentResult, {
        causedBy: [signal.id],
        tags: deposit.tags,
        ttl: deposit.ttl,
      });
    }

    // 5. Withdraw the triggering signal
    if (autoWithdraw) {
      await ctx.withdraw(signal.id);
    }

    ctx.log(`Agent completed. Deposited ${deposits.length} signal(s).`);
  };
}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

function buildDefaultSystemPrompt(colonyName: string): string {
  return [
    `You are an agent in the "${colonyName}" colony.`,
    'Complete the task described in the prompt.',
    'Be thorough but concise. Focus on the specific task at hand.',
    'If you create or modify files, ensure they compile/pass tests.',
  ].join('\n');
}

function extractResult(messages: any[]): Record<string, unknown> {
  // Walk backwards to find the last assistant message with text content
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      // Handle both string content and content blocks
      if (typeof msg.content === 'string') {
        return { text: msg.content, raw: msg };
      }
      if (Array.isArray(msg.content)) {
        const textBlock = msg.content.find((b: any) => b.type === 'text');
        if (textBlock) {
          return { text: textBlock.text, raw: msg };
        }
      }
    }
  }
  return { text: '', raw: messages };
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
