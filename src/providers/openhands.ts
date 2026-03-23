// PURPOSE: withOpenHands — Sandboxed agentic coding via OpenHands local self-hosted API.
// PURPOSE: REST client targeting /api/conversations for CI investigation and DevOps tasks.

import type { Signal, ActionContext } from '../core/types.js';
import type { ActionHandler, OutputMapping, SignalDeposit } from './types.js';

// ----------------------------------------------------------
// Configuration
// ----------------------------------------------------------

export interface OpenHandsConfig<T = Record<string, unknown>> {
  /**
   * OpenHands agent server URL.
   * Default: 'http://localhost:3001'.
   */
  serverUrl?: string;

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
   * Git branch to check out in the sandbox.
   * Can be static or derived from the signal.
   */
  selectedBranch?: string | ((signal: Signal<T>) => string);

  /**
   * System-level instructions for the OpenHands agent.
   * Sent as `conversation_instructions` in the create body.
   */
  conversationInstructions?: string;

  /**
   * Maximum iterations the agent can take. Default: 50.
   */
  maxIterations?: number;

  /**
   * Timeout in ms for the entire conversation. Default: 900_000 (15 min).
   * CI investigation can take a while — reproducing failures, installing deps, running tests.
   */
  timeout?: number;

  /**
   * Event callback for observability.
   * Called with events fetched from the conversation events endpoint.
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

/** Event from the OpenHands conversation events endpoint. */
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
  status: 'finished' | 'error' | 'timeout' | 'stopped';
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
 * Creates an action handler powered by the OpenHands local self-hosted API.
 *
 * OpenHands provides sandboxed terminal access inside Docker containers,
 * which is ideal for CI investigation tasks that need to:
 * - Fetch and parse CI logs
 * - Reproduce build failures in isolation
 * - Install dependencies and run tests
 * - Propose fixes without affecting the host
 *
 * Local API Lifecycle:
 * 1. POST /api/conversations — create conversation
 * 2. POST /api/conversations/{id}/message — send user prompt
 * 3. GET /api/conversations/{id} — poll until STOPPED
 * 4. GET /api/conversations/{id}/events — fetch agent events
 * 5. DELETE /api/conversations/{id} — cleanup
 */
export function withOpenHands<T = Record<string, unknown>>(
  config: OpenHandsConfig<T>
): ActionHandler<T> {
  const {
    serverUrl = 'http://localhost:3001',
    repository,
    prompt,
    workingDirectory,
    selectedBranch,
    conversationInstructions,
    maxIterations = 50,
    timeout = 900_000,
    onEvent,
    output,
    autoWithdraw = true,
  } = config;

  return async (signal: Signal<T>, ctx: ActionContext) => {
    const startTime = Date.now();
    const baseUrl = serverUrl.replace(/\/$/, '');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Resolve dynamic config fields
    const resolvedPrompt = typeof prompt === 'function'
      ? await prompt(signal)
      : prompt;

    const cwd = typeof workingDirectory === 'function'
      ? workingDirectory(signal)
      : workingDirectory;

    const repo = typeof repository === 'function'
      ? repository(signal)
      : repository;

    const branch = typeof selectedBranch === 'function'
      ? selectedBranch(signal)
      : selectedBranch;

    const events: OpenHandsEvent[] = [];
    let conversationId: string | undefined;

    try {
      // 1. Create conversation
      // Note: InitSessionRequest only accepts specific fields — do not send extras
      // like max_iterations which cause 422 "Extra inputs are not permitted".
      const createBody: Record<string, unknown> = {};
      if (repo !== undefined) createBody.repository = repo;
      if (resolvedPrompt) createBody.initial_user_msg = resolvedPrompt;
      if (branch !== undefined) createBody.selected_branch = branch;
      if (conversationInstructions !== undefined) createBody.conversation_instructions = conversationInstructions;

      const createRes = await fetchWithTimeout(
        `${baseUrl}/api/conversations`,
        { method: 'POST', headers, body: JSON.stringify(createBody) },
        30_000
      );

      if (!createRes.ok) {
        const errorText = await createRes.text().catch(() => 'unknown error');
        throw new OpenHandsError(
          'CONVERSATION_CREATE_FAILED',
          `Failed to create OpenHands conversation: ${createRes.status} ${truncate(errorText, 500)}`
        );
      }

      const createData = await createRes.json() as Record<string, unknown>;
      conversationId = createData.conversation_id as string | undefined;

      if (!conversationId) {
        throw new OpenHandsError(
          'CONVERSATION_CREATE_FAILED',
          'OpenHands returned no conversation ID'
        );
      }

      ctx.log(`OpenHands conversation ${conversationId} created`);

      // 2. Send user prompt as message
      const messageRes = await fetchWithTimeout(
        `${baseUrl}/api/conversations/${conversationId}/message`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ message: resolvedPrompt }),
        },
        30_000
      );

      if (!messageRes.ok) {
        const errorText = await messageRes.text().catch(() => 'unknown error');
        throw new OpenHandsError(
          'MESSAGE_SEND_FAILED',
          `Failed to send message to conversation ${conversationId}: ${messageRes.status} ${truncate(errorText, 500)}`
        );
      }

      ctx.log(`Message sent to conversation ${conversationId}`);

      // 3. Poll for completion
      const finalStatus = await pollForCompletion(
        baseUrl,
        conversationId,
        headers,
        timeout,
        onEvent,
        events,
        ctx
      );

      // 4. Fetch events
      await fetchEvents(baseUrl, conversationId, headers, events, onEvent, ctx);

      const durationMs = Date.now() - startTime;

      // Extract result text from events or conversation data
      const resultText = extractResultText(events, finalStatus);

      const openHandsResult: OpenHandsResult = {
        status: finalStatus,
        text: resultText,
        conversationId,
        durationMs,
        events,
      };

      ctx.log(
        `OpenHands ${finalStatus} in ${durationMs}ms ` +
        `(conversation=${conversationId}, events=${events.length})`
      );

      // 5. Deposit output signals
      const deposits = resolveOutput(output, openHandsResult, signal);
      for (const deposit of deposits) {
        await ctx.deposit(deposit.type, deposit.payload ?? { ...openHandsResult }, {
          causedBy: [signal.id],
          tags: deposit.tags,
          ttl: deposit.ttl,
        });
      }

      // 6. Auto-withdraw
      if (autoWithdraw) {
        await ctx.withdraw(signal.id);
      }
    } finally {
      // Always cleanup the conversation
      if (conversationId) {
        await fetchWithTimeout(
          `${baseUrl}/api/conversations/${conversationId}`,
          { method: 'DELETE', headers },
          10_000
        ).catch(() => {});
      }
    }
  };
}

// ----------------------------------------------------------
// Completion polling
// ----------------------------------------------------------

/**
 * Poll the conversation status until it reaches a terminal state.
 * The local API uses `status` (RUNNING/STOPPED) and `runtime_status`.
 */
async function pollForCompletion(
  baseUrl: string,
  conversationId: string,
  headers: Record<string, string>,
  timeout: number,
  onEvent: ((event: OpenHandsEvent) => void) | undefined,
  events: OpenHandsEvent[],
  ctx: ActionContext
): Promise<OpenHandsResult['status']> {
  const deadline = Date.now() + timeout;
  const pollInterval = 3_000;
  let lastStatus = '';

  while (Date.now() < deadline) {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/conversations/${conversationId}`,
      { method: 'GET', headers },
      10_000
    ).catch(() => null);

    if (res?.ok) {
      const data = await res.json().catch((err: Error) => {
        ctx.log(`Warning: failed to parse poll response: ${err.message}`, 'warn');
        return {};
      }) as Record<string, unknown>;

      const status = data.status as string | undefined;
      const runtimeStatus = data.runtime_status as string | undefined;

      // Emit synthetic event on status change
      const currentStatus = `${status}:${runtimeStatus}`;
      if (currentStatus !== lastStatus) {
        lastStatus = currentStatus;
        const event: OpenHandsEvent = {
          id: events.length + 1,
          source: 'environment',
          observation: 'status_change',
          message: `status=${status} runtime_status=${runtimeStatus}`,
          timestamp: new Date().toISOString(),
        };
        events.push(event);
        if (onEvent) {
          try { onEvent(event); } catch { /* swallow callback errors */ }
        }
      }

      // STOPPED is the terminal state for the local API
      if (status === 'STOPPED') {
        return 'finished';
      }
    }

    await sleep(pollInterval);
  }

  return 'timeout';
}

// ----------------------------------------------------------
// Events fetching
// ----------------------------------------------------------

/**
 * Fetch all events from the conversation events endpoint.
 */
async function fetchEvents(
  baseUrl: string,
  conversationId: string,
  headers: Record<string, string>,
  events: OpenHandsEvent[],
  onEvent: ((event: OpenHandsEvent) => void) | undefined,
  ctx: ActionContext
): Promise<void> {
  const res = await fetchWithTimeout(
    `${baseUrl}/api/conversations/${conversationId}/events`,
    { method: 'GET', headers },
    30_000
  ).catch(() => null);

  if (!res?.ok) {
    ctx.log(`Warning: failed to fetch events for conversation ${conversationId}`, 'warn');
    return;
  }

  const data = await res.json().catch(() => []) as unknown[];

  for (let i = 0; i < data.length; i++) {
    const raw = data[i] as Record<string, unknown>;
    const event: OpenHandsEvent = {
      id: events.length + 1,
      source: (raw.source as OpenHandsEvent['source']) ?? 'agent',
      action: raw.action as string | undefined,
      observation: raw.observation as string | undefined,
      message: raw.message as string | undefined,
      args: raw.args as Record<string, unknown> | undefined,
      content: raw.content as string | undefined,
      extras: raw.extras as Record<string, unknown> | undefined,
      timestamp: raw.timestamp as string | undefined,
    };
    events.push(event);
    if (onEvent) {
      try { onEvent(event); } catch { /* swallow callback errors */ }
    }
  }
}

// ----------------------------------------------------------
// Result text extraction
// ----------------------------------------------------------

/**
 * Extract the best result text from the collected events.
 * Falls back to a status-based message.
 */
function extractResultText(
  events: OpenHandsEvent[],
  status: OpenHandsResult['status']
): string {
  // Walk events in reverse looking for the last agent message
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.source === 'agent' && event.message) {
      return event.message;
    }
    if (event.source === 'agent' && event.content) {
      return event.content;
    }
  }

  // Fallback
  if (status === 'timeout') return 'Agent timed out';
  if (status === 'error') return 'Agent encountered an error';
  return '';
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

/** Truncate a string to a max length. */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

// ----------------------------------------------------------
// Output mapping (same 3-pattern as withClaudeCode/withBash)
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
  | 'MESSAGE_SEND_FAILED'
  | 'CONNECTION_FAILED'
  | 'TIMEOUT';

export class OpenHandsError extends Error {
  constructor(
    public readonly code: OpenHandsErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'OpenHandsError';
  }
}
