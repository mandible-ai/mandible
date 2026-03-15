// PURPOSE: withOpenHands — Sandboxed agentic coding via OpenHands agent server (V1 API).
// PURPOSE: REST client for CI investigation and DevOps tasks in isolated containers.

import type { Signal, ActionContext } from '../core/types.js';
import type { ActionHandler, OutputMapping, SignalDeposit } from './types.js';

// ----------------------------------------------------------
// Configuration
// ----------------------------------------------------------

export interface OpenHandsConfig<T = Record<string, unknown>> {
  /**
   * OpenHands agent server URL.
   * Default: 'http://localhost:3000'.
   */
  serverUrl?: string;

  /**
   * Bearer token for V1 API authentication.
   * Sent as `Authorization: Bearer {apiKey}` when provided.
   */
  apiKey?: string;

  /**
   * Model in "provider/model" format for the OpenHands agent.
   * e.g. 'openai/qwen3-coder', 'anthropic/claude-sonnet-4-5-20250929'
   */
  model?: string;

  /**
   * Git repository URL for the sandbox.
   * Can be a static string or derived from the signal.
   */
  repository?: string | ((signal: Signal<T>) => string);

  /**
   * Build the prompt from the incoming signal.
   * Can be a static string, or a function that receives the signal.
   *
   * For context assembly, capture the environment in a closure:
   *   prompt: async (signal) => {
   *     const ctx = await assembleContext(signal, env, { includeLineage: true });
   *     return `${ctx}\n\nInvestigate this CI failure:\n${signal.payload.logs}`;
   *   }
   */
  prompt: string | ((signal: Signal<T>) => string | Promise<string>);

  /**
   * Working directory for the OpenHands sandbox.
   * Can be static or derived from the signal.
   */
  workingDirectory?: string | ((signal: Signal<T>) => string);

  /**
   * Timeout in ms for the entire conversation. Default: 900_000 (15 min).
   * CI investigation can take a while — reproducing failures, installing deps, running tests.
   */
  timeout?: number;

  /**
   * Event callback for observability.
   * Called with synthetic events derived from poll status changes.
   * Errors in this callback are caught and do not crash the agent.
   */
  onEvent?: (event: OpenHandsEvent) => void;

  /** Map output to signal deposits. */
  output?: OutputMapping<T>;

  /** Auto-withdraw the triggering signal. Default: true. */
  autoWithdraw?: boolean;
}

// ----------------------------------------------------------
// Event and result types
// ----------------------------------------------------------

/** Synthetic event emitted from poll status changes. */
export interface OpenHandsEvent {
  id: number;
  source: 'agent' | 'user' | 'environment';
  action?: string;
  observation?: string;
  message?: string;
  args?: Record<string, unknown>;
  content?: string;
  extras?: Record<string, unknown>;
  timestamp?: string;
}

/** Result of an OpenHands agent conversation. */
export interface OpenHandsResult {
  /** Final status of the conversation. */
  status: 'finished' | 'error' | 'timeout' | 'stopped' | 'stuck';
  /** Summary text from the agent's final message. */
  text: string;
  /** Conversation ID for debugging/tracing. */
  conversationId: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Events received during the conversation. */
  events: OpenHandsEvent[];
}

// ----------------------------------------------------------
// Provider factory
// ----------------------------------------------------------

/**
 * Creates an action handler powered by the OpenHands agent server (V1 API).
 *
 * OpenHands provides sandboxed terminal access inside Docker containers,
 * which is ideal for CI investigation tasks that need to:
 * - Fetch and parse CI logs
 * - Reproduce build failures in isolation
 * - Install dependencies and run tests
 * - Propose fixes without affecting the host
 *
 * V1 Lifecycle:
 * 1. POST /api/v1/app-conversations — create with initial message
 * 2. GET /api/v1/app-conversations/start-tasks — poll until READY
 * 3. GET /api/v1/app-conversations — poll until terminal state
 */
export function withOpenHands<T = Record<string, unknown>>(
  config: OpenHandsConfig<T>
): ActionHandler<T> {
  const {
    serverUrl = 'http://localhost:3000',
    apiKey,
    model,
    repository,
    prompt,
    workingDirectory,
    timeout = 900_000,
    onEvent,
    output,
    autoWithdraw = true,
  } = config;

  return async (signal: Signal<T>, ctx: ActionContext) => {
    const startTime = Date.now();
    const baseUrl = serverUrl.replace(/\/$/, '');

    // Build shared headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // 1. Resolve prompt
    const resolvedPrompt = typeof prompt === 'function'
      ? await prompt(signal)
      : prompt;

    // 2. Resolve working directory
    const cwd = typeof workingDirectory === 'function'
      ? workingDirectory(signal)
      : workingDirectory;

    // 3. Resolve repository
    const repo = typeof repository === 'function'
      ? repository(signal)
      : repository;

    // 4. Create conversation with initial message
    const events: OpenHandsEvent[] = [];

    const createBody: Record<string, unknown> = {
      initial_message: resolvedPrompt,
    };
    if (repo !== undefined) createBody.repository = repo;
    if (model !== undefined) createBody.selected_model = model;
    if (cwd !== undefined) createBody.initial_cwd = cwd;

    const createRes = await fetchWithTimeout(
      `${baseUrl}/api/v1/app-conversations`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(createBody),
      },
      30_000
    );

    if (!createRes.ok) {
      const errorText = await createRes.text().catch(() => 'unknown error');
      throw new OpenHandsError(
        'CONVERSATION_CREATE_FAILED',
        `Failed to create OpenHands conversation: ${createRes.status} ${errorText}`
      );
    }

    const createData = await createRes.json() as Record<string, unknown>;
    const conversationId = createData.conversation_id as string | undefined;

    if (!conversationId) {
      throw new OpenHandsError(
        'CONVERSATION_CREATE_FAILED',
        'OpenHands returned no conversation ID'
      );
    }

    ctx.log(`OpenHands conversation ${conversationId} created`);

    // 5. Wait for startup
    await waitForStartup(baseUrl, conversationId, headers, 60_000, ctx);

    // 6. Wait for completion
    const result = await waitForCompletion(
      baseUrl,
      conversationId,
      headers,
      timeout,
      events,
      onEvent,
      ctx
    );

    const durationMs = Date.now() - startTime;

    const openHandsResult: OpenHandsResult = {
      status: result.status,
      text: result.text,
      conversationId,
      durationMs,
      events,
    };

    ctx.log(
      `OpenHands ${result.status} in ${durationMs}ms ` +
      `(conversation=${conversationId}, events=${events.length})`
    );

    // 7. Deposit output signals
    const deposits = resolveOutput(output, openHandsResult, signal);
    for (const deposit of deposits) {
      await ctx.deposit(deposit.type, deposit.payload ?? { ...openHandsResult }, {
        causedBy: [signal.id],
        tags: deposit.tags,
        ttl: deposit.ttl,
      });
    }

    // 8. Auto-withdraw
    if (autoWithdraw) {
      await ctx.withdraw(signal.id);
    }
  };
}

// ----------------------------------------------------------
// Startup polling
// ----------------------------------------------------------

/**
 * Wait for the OpenHands conversation sandbox to be ready.
 * Polls the start-tasks endpoint until READY or ERROR.
 */
async function waitForStartup(
  baseUrl: string,
  conversationId: string,
  headers: Record<string, string>,
  startupTimeout: number,
  ctx: ActionContext
): Promise<void> {
  const deadline = Date.now() + startupTimeout;
  const pollInterval = 2_000;

  while (Date.now() < deadline) {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/v1/app-conversations/start-tasks?ids=${encodeURIComponent(conversationId)}`,
      { method: 'GET', headers },
      10_000
    ).catch(() => null);

    if (res?.ok) {
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      const tasks = data.tasks as Array<Record<string, unknown>> | undefined;
      if (tasks && tasks.length > 0) {
        const task = tasks[0];
        const status = task.status as string;

        if (status === 'READY') {
          return;
        }

        if (status === 'ERROR') {
          throw new OpenHandsError(
            'STARTUP_FAILED',
            `OpenHands startup failed for conversation ${conversationId}`
          );
        }
      }
    }

    await sleep(pollInterval);
  }

  throw new OpenHandsError(
    'STARTUP_TIMEOUT',
    `OpenHands startup timed out after ${startupTimeout}ms for conversation ${conversationId}`
  );
}

// ----------------------------------------------------------
// Completion polling
// ----------------------------------------------------------

/**
 * Wait for the OpenHands conversation to reach a terminal state.
 * Polls the conversations endpoint and emits synthetic events on status changes.
 */
async function waitForCompletion(
  baseUrl: string,
  conversationId: string,
  headers: Record<string, string>,
  timeout: number,
  events: OpenHandsEvent[],
  onEvent: ((event: OpenHandsEvent) => void) | undefined,
  ctx: ActionContext
): Promise<{ status: OpenHandsResult['status']; text: string }> {
  const deadline = Date.now() + timeout;
  const pollInterval = 5_000;
  let lastStatus = '';

  while (Date.now() < deadline) {
    const statusRes = await fetchWithTimeout(
      `${baseUrl}/api/v1/app-conversations?ids=${encodeURIComponent(conversationId)}`,
      { method: 'GET', headers },
      10_000
    ).catch(() => null);

    if (statusRes?.ok) {
      const statusData = await statusRes.json().catch((err: Error) => {
        ctx.log(`Warning: failed to parse poll response: ${err.message}`, 'warn');
        return {};
      }) as Record<string, unknown>;

      const conversations = statusData.conversations as Array<Record<string, unknown>> | undefined;
      if (conversations && conversations.length > 0) {
        const conv = conversations[0];
        const executionStatus = conv.execution_status as string | undefined;
        const sandboxStatus = conv.sandbox_status as string | undefined;
        const lastMessage = conv.last_message as string | undefined;

        // Emit synthetic event on status change
        const currentStatus = `${executionStatus}:${sandboxStatus}`;
        if (currentStatus !== lastStatus) {
          lastStatus = currentStatus;
          const event: OpenHandsEvent = {
            id: events.length + 1,
            source: 'environment',
            observation: 'status_change',
            message: `execution=${executionStatus} sandbox=${sandboxStatus}`,
            timestamp: new Date().toISOString(),
          };
          events.push(event);
          if (onEvent) {
            try { onEvent(event); } catch { /* swallow callback errors */ }
          }
        }

        // Check terminal states
        if (executionStatus === 'FINISHED') {
          return { status: 'finished', text: lastMessage ?? '' };
        }

        if (executionStatus === 'ERROR') {
          return { status: 'error', text: lastMessage ?? 'Agent encountered an error' };
        }

        if (executionStatus === 'STUCK') {
          return { status: 'stuck', text: lastMessage ?? 'Agent is stuck' };
        }

        if (sandboxStatus === 'ERROR') {
          return { status: 'error', text: lastMessage ?? 'Sandbox error' };
        }

        if (executionStatus === 'PAUSED' && sandboxStatus === 'STOPPED') {
          return { status: 'stopped', text: lastMessage ?? 'Agent was stopped' };
        }
      }
    }

    await sleep(pollInterval);
  }

  return { status: 'timeout', text: 'Agent timed out' };
}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

/** fetch() with AbortSignal.timeout. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ----------------------------------------------------------
// Output mapping (same 3-pattern as withOpenCode/withClaudeCode)
// ----------------------------------------------------------

function resolveOutput<T>(
  output: OutputMapping<T> | undefined,
  result: OpenHandsResult,
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

// ----------------------------------------------------------
// Error types
// ----------------------------------------------------------

export type OpenHandsErrorCode =
  | 'CONVERSATION_CREATE_FAILED'
  | 'STARTUP_FAILED'
  | 'STARTUP_TIMEOUT';

export class OpenHandsError extends Error {
  constructor(
    public readonly code: OpenHandsErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'OpenHandsError';
  }
}
