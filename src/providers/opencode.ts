// PURPOSE: withOpenCode — Provider-agnostic agentic coding via OpenCode SDK.
// PURPOSE: Wraps the OpenCode Go server's TypeScript SDK for multi-provider LLM access.

import type { Signal, ActionContext } from '../core/types.js';
import type { ActionHandler, OutputMapping, SignalDeposit } from './types.js';

// ----------------------------------------------------------
// Configuration
// ----------------------------------------------------------

export interface OpenCodeConfig<T = Record<string, unknown>> {
  /**
   * OpenCode server URL. Default: 'http://localhost:4096'.
   * Start the server with: opencode serve
   */
  serverUrl?: string;

  /**
   * Model in "provider/modelId" format.
   * e.g. 'anthropic/claude-sonnet-4-5-20250929', 'openai/gpt-5.1'
   * Falls back to the server's configured default model.
   */
  model?: string;

  /**
   * OpenCode agent type.
   * - 'build': Full development (file editing, commands, all tools)
   * - 'plan': Read-only analysis, suggests changes without executing
   * - 'general': Multi-step research with subagent support
   * - 'explore': Fast read-only codebase scanning
   * Default: 'build'.
   */
  agent?: 'build' | 'plan' | 'general' | 'explore';

  /** Build the prompt from the incoming signal. */
  prompt: string | ((signal: Signal<T>) => string | Promise<string>);

  /**
   * System prompt. Injected as a noReply message before the main prompt
   * to set the agent's role and constraints.
   */
  systemPrompt?: string;

  /**
   * Working directory for the OpenCode session.
   * Can be static or derived from the signal.
   */
  workingDirectory?: string | ((signal: Signal<T>) => string);

  /** Timeout in ms for the prompt call. Default: 600_000 (10 min). */
  timeout?: number;

  /**
   * JSON schema for structured output. When set, the agent returns
   * validated JSON matching this schema instead of free-form text.
   */
  schema?: { name: string; schema: Record<string, unknown> };

  /**
   * Event stream callback for observability.
   * Called with each SSE event from the OpenCode server.
   * Errors in this callback are caught and do not crash the agent.
   */
  onEvent?: (event: unknown) => void;

  /** Map output to signal deposits. */
  output?: OutputMapping<T>;

  /** Auto-withdraw the triggering signal. Default: true. */
  autoWithdraw?: boolean;
}

// ----------------------------------------------------------
// Result types
// ----------------------------------------------------------

export interface OpenCodeResult {
  /** Final text output from the agent. */
  text: string;
  /** Structured output (parsed JSON) when schema was provided. */
  structuredOutput?: unknown;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** OpenCode session ID (for debugging/resumption). */
  sessionId: string;
}

// ----------------------------------------------------------
// Provider factory
// ----------------------------------------------------------

/**
 * Creates an action handler powered by the OpenCode SDK.
 *
 * The SDK must be installed separately:
 *   npm install @opencode-ai/sdk
 *
 * The OpenCode server must be running:
 *   opencode serve
 *
 * The handler:
 * 1. Connects to the OpenCode server via the SDK
 * 2. Creates a session with the specified agent and model
 * 3. Optionally injects a system prompt as a noReply message
 * 4. Sends the main prompt (with optional structured output schema)
 * 5. Extracts text and structured output from the response
 * 6. Maps the output to signal deposits
 * 7. Cleans up the session
 */
export function withOpenCode<T = Record<string, unknown>>(
  config: OpenCodeConfig<T>
): ActionHandler<T> {
  const {
    serverUrl = 'http://localhost:4096',
    model,
    agent = 'build',
    prompt,
    systemPrompt,
    workingDirectory,
    timeout = 600_000,
    schema,
    onEvent,
    output,
    autoWithdraw = true,
  } = config;

  return async (signal: Signal<T>, ctx: ActionContext) => {
    const startTime = Date.now();

    // 1. Resolve prompt
    const resolvedPrompt = typeof prompt === 'function'
      ? await prompt(signal)
      : prompt;

    // 2. Resolve working directory
    const cwd = typeof workingDirectory === 'function'
      ? workingDirectory(signal)
      : workingDirectory;

    // 3. Dynamic import + full SDK interaction in try/catch
    //    Catches MODULE_NOT_FOUND from both the import() and the SDK usage.
    let client: any;
    let sessionId: string | undefined;

    try {
      const sdk = await (import('@opencode-ai/sdk' as string) as Promise<any>);
      const createOpencodeClient = sdk.createOpencodeClient;

      // 4. Create client
      client = createOpencodeClient({ baseUrl: serverUrl });

      // 5. Create session
      const sessionBody: Record<string, unknown> = {};
      if (model) sessionBody.model = model;
      if (agent) sessionBody.agent = agent;
      if (cwd) sessionBody.path = cwd;

      const session = await client.session.create({ body: sessionBody });
      sessionId = session.data.id;
    } catch (err: any) {
      if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
        throw new Error(
          'withOpenCode requires @opencode-ai/sdk. Install it:\n' +
          '  npm install @opencode-ai/sdk'
        );
      }
      throw err;
    }

    ctx.log(`OpenCode session ${sessionId} created (agent=${agent}${model ? `, model=${model}` : ''})`);

    const eventAbort = new AbortController();

    try {
      // 6. Subscribe to events (cancelled in finally via eventAbort)
      if (onEvent) {
        consumeEvents(client, onEvent, eventAbort.signal).catch(() => {});
      }

      // 7. Inject system prompt as noReply message
      if (systemPrompt) {
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{ type: 'text', text: systemPrompt }],
            noReply: true,
          },
        });
      }

      // 8. Send main prompt
      const promptBody: Record<string, unknown> = {
        parts: [{ type: 'text', text: resolvedPrompt }],
      };

      if (schema) {
        promptBody.format = {
          type: 'json_schema',
          schema: schema.schema,
        };
      }

      const response = await client.session.prompt({
        path: { id: sessionId },
        body: promptBody,
        signal: AbortSignal.timeout(timeout),
      });

      // 9. Extract result
      const durationMs = Date.now() - startTime;
      const parts: any[] = response.data?.parts ?? [];
      const textParts = parts.filter((p: any) => p.type === 'text');
      const text = textParts.map((p: any) => p.text).join('\n');

      const structuredOutput = response.data?.info?.structured_output;

      const result: OpenCodeResult = {
        text,
        structuredOutput,
        durationMs,
        sessionId: sessionId!,
      };

      ctx.log(`OpenCode completed in ${durationMs}ms (session=${sessionId})`);

      // 10. Deposit output signals
      const deposits = resolveOutput(output, result, signal);
      for (const deposit of deposits) {
        await ctx.deposit(deposit.type, deposit.payload ?? { ...result }, {
          causedBy: [signal.id],
          tags: deposit.tags,
          ttl: deposit.ttl,
        });
      }

      // 11. Auto-withdraw
      if (autoWithdraw) {
        await ctx.withdraw(signal.id);
      }
    } finally {
      // 12. Stop event stream before deleting session
      eventAbort.abort();

      // 13. Clean up session
      if (sessionId) {
        await client.session.delete({ path: { id: sessionId } }).catch(() => {});
      }
    }
  };
}

// ----------------------------------------------------------
// Default system prompt
// ----------------------------------------------------------

export function buildOpenCodeSystemPrompt(colonyName: string): string {
  return [
    `You are an agent in the "${colonyName}" colony.`,
    'Complete the task described in the prompt.',
    'Be thorough but concise. Focus on the specific task at hand.',
    'If you create or modify files, ensure they compile/pass tests.',
  ].join('\n');
}

// ----------------------------------------------------------
// Event consumer (background, non-blocking)
// ----------------------------------------------------------

async function consumeEvents(
  client: any,
  onEvent: (event: unknown) => void,
  abortSignal: AbortSignal,
): Promise<void> {
  const events = await client.event.subscribe();
  for await (const event of events.stream) {
    if (abortSignal.aborted) break;
    try { onEvent(event); } catch { /* swallow callback errors */ }
  }
}

// ----------------------------------------------------------
// Output mapping (same 3-pattern as withClaudeCode/withQwenCode)
// ----------------------------------------------------------

function resolveOutput<T>(
  output: OutputMapping<T> | undefined,
  result: OpenCodeResult,
  signal: Signal<T>,
): SignalDeposit[] {
  if (!output) {
    return [{ type: `${signal.type}:completed`, payload: result as any }];
  }

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
