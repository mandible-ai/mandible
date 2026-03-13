// PURPOSE: withOpenHands — Sandboxed agentic coding via OpenHands agent server.
// PURPOSE: REST + WebSocket client for CI investigation and DevOps tasks in isolated containers.

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
   * Model in "provider/model" format for the OpenHands agent.
   * e.g. 'openai/qwen3-coder', 'anthropic/claude-sonnet-4-5-20250929'
   */
  model?: string;

  /**
   * LLM base URL for the OpenHands agent to use.
   * Points to the vLLM or other OpenAI-compatible endpoint.
   * e.g. 'http://dgx-inference:8000/v1'
   */
  llmBaseUrl?: string;

  /**
   * LLM API key. Default: 'not-needed' (for local vLLM).
   */
  llmApiKey?: string;

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
   * Max iterations for the OpenHands agent. Default: 50.
   */
  maxIterations?: number;

  /**
   * Event callback for observability.
   * Called with each WebSocket event from the OpenHands server.
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

/** OpenHands WebSocket event (subset of event types we care about). */
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
 * Creates an action handler powered by the OpenHands agent server.
 *
 * OpenHands provides sandboxed terminal access inside Docker containers,
 * which is ideal for CI investigation tasks that need to:
 * - Fetch and parse CI logs
 * - Reproduce build failures in isolation
 * - Install dependencies and run tests
 * - Propose fixes without affecting the host
 *
 * Lifecycle:
 * 1. POST /api/conversations — create a new conversation
 * 2. POST /api/conversations/{id}/messages — send the prompt
 * 3. WebSocket /ws/{id} — stream events until completion
 * 4. DELETE /api/conversations/{id} — clean up
 */
export function withOpenHands<T = Record<string, unknown>>(
  config: OpenHandsConfig<T>
): ActionHandler<T> {
  const {
    serverUrl = 'http://localhost:3001',
    model,
    llmBaseUrl,
    llmApiKey = 'not-needed',
    prompt,
    workingDirectory,
    timeout = 900_000,
    maxIterations = 50,
    onEvent,
    output,
    autoWithdraw = true,
  } = config;

  return async (signal: Signal<T>, ctx: ActionContext) => {
    const startTime = Date.now();
    const baseUrl = serverUrl.replace(/\/$/, '');

    // 1. Resolve prompt (colony templates capture env in closure for assembleContext)
    const resolvedPrompt = typeof prompt === 'function'
      ? await prompt(signal)
      : prompt;

    // 2. Resolve working directory
    const cwd = typeof workingDirectory === 'function'
      ? workingDirectory(signal)
      : workingDirectory;

    // 3. Create conversation
    let conversationId: string | undefined;
    const events: OpenHandsEvent[] = [];

    try {
      const createBody: Record<string, unknown> = {};
      if (model) createBody.model = model;
      if (llmBaseUrl) createBody.llm_base_url = llmBaseUrl;
      if (llmApiKey) createBody.llm_api_key = llmApiKey;
      if (maxIterations) createBody.max_iterations = maxIterations;
      if (cwd) createBody.initial_cwd = cwd;

      const createRes = await fetchWithTimeout(
        `${baseUrl}/api/conversations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

      const createData = await createRes.json();
      conversationId = createData.conversation_id ?? createData.id;

      if (!conversationId) {
        throw new OpenHandsError(
          'CONVERSATION_CREATE_FAILED',
          'OpenHands returned no conversation ID'
        );
      }

      ctx.log(`OpenHands conversation ${conversationId} created`);

      // 4. Send prompt message
      const messageRes = await fetchWithTimeout(
        `${baseUrl}/api/conversations/${conversationId}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            role: 'user',
            content: resolvedPrompt,
          }),
        },
        30_000
      );

      if (!messageRes.ok) {
        const errorText = await messageRes.text().catch(() => 'unknown error');
        throw new OpenHandsError(
          'MESSAGE_SEND_FAILED',
          `Failed to send message: ${messageRes.status} ${errorText}`
        );
      }

      // 5. Stream events via WebSocket (or poll for completion)
      const result = await waitForCompletion(
        baseUrl,
        conversationId,
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

      // 6. Deposit output signals
      const deposits = resolveOutput(output, openHandsResult, signal);
      for (const deposit of deposits) {
        await ctx.deposit(deposit.type, deposit.payload ?? { ...openHandsResult }, {
          causedBy: [signal.id],
          tags: deposit.tags,
          ttl: deposit.ttl,
        });
      }

      // 7. Auto-withdraw
      if (autoWithdraw) {
        await ctx.withdraw(signal.id);
      }
    } finally {
      // 8. Clean up conversation
      if (conversationId) {
        await cleanupConversation(baseUrl, conversationId).catch((err) => {
          ctx.log(`Warning: failed to clean up conversation ${conversationId}: ${err.message}`, 'warn');
        });
      }
    }
  };
}

// ----------------------------------------------------------
// Completion polling
// ----------------------------------------------------------

/**
 * Wait for the OpenHands conversation to complete.
 * Uses polling against the conversation status endpoint.
 * WebSocket streaming is used when available for real-time events.
 */
async function waitForCompletion(
  baseUrl: string,
  conversationId: string,
  timeout: number,
  events: OpenHandsEvent[],
  onEvent: ((event: OpenHandsEvent) => void) | undefined,
  ctx: ActionContext
): Promise<{ status: OpenHandsResult['status']; text: string }> {
  const deadline = Date.now() + timeout;
  const pollInterval = 5_000;
  let lastText = '';

  // Try WebSocket for event streaming (non-blocking)
  const wsCleanup = tryWebSocketStream(baseUrl, conversationId, events, onEvent);

  try {
    while (Date.now() < deadline) {
      // Poll conversation status
      const statusRes = await fetchWithTimeout(
        `${baseUrl}/api/conversations/${conversationId}`,
        { method: 'GET' },
        10_000
      ).catch(() => null);

      if (statusRes?.ok) {
        const statusData = await statusRes.json().catch(() => ({}));
        const state = statusData.status ?? statusData.state;

        if (state === 'finished' || state === 'completed' || state === 'done') {
          lastText = extractFinalText(statusData, events);
          return { status: 'finished', text: lastText };
        }

        if (state === 'error' || state === 'failed') {
          lastText = extractFinalText(statusData, events);
          return { status: 'error', text: lastText || 'Agent encountered an error' };
        }

        if (state === 'stopped') {
          lastText = extractFinalText(statusData, events);
          return { status: 'stopped', text: lastText || 'Agent was stopped' };
        }
      }

      // Wait before next poll
      await sleep(pollInterval);
    }

    // Timeout
    return { status: 'timeout', text: lastText || 'Agent timed out' };
  } finally {
    wsCleanup();
  }
}

/**
 * Try to connect a WebSocket for event streaming.
 * Non-blocking — if WebSocket connection fails, we fall back to polling only.
 * Returns a cleanup function.
 */
function tryWebSocketStream(
  baseUrl: string,
  conversationId: string,
  events: OpenHandsEvent[],
  onEvent: ((event: OpenHandsEvent) => void) | undefined
): () => void {
  let ws: any = null;

  try {
    // Convert http(s) to ws(s) URL
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `/ws/${conversationId}`;

    // Dynamic import WebSocket (Node.js built-in from v21+, or ws package)
    const WebSocketImpl = globalThis.WebSocket;
    if (!WebSocketImpl) return () => {};

    ws = new WebSocketImpl(wsUrl);

    ws.onmessage = (msg: any) => {
      try {
        const event: OpenHandsEvent = JSON.parse(
          typeof msg.data === 'string' ? msg.data : msg.data.toString()
        );
        events.push(event);
        if (onEvent) {
          try { onEvent(event); } catch { /* swallow callback errors */ }
        }
      } catch { /* ignore parse errors */ }
    };

    ws.onerror = () => { /* swallow — polling is the fallback */ };
  } catch { /* WebSocket not available — polling only */ }

  return () => {
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
    }
  };
}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

/** Extract the agent's final text from status data or event history. */
function extractFinalText(
  statusData: Record<string, unknown>,
  events: OpenHandsEvent[]
): string {
  // Try status data first
  if (typeof statusData.summary === 'string') return statusData.summary;
  if (typeof statusData.result === 'string') return statusData.result;

  // Fall back to last agent message from events
  const agentMessages = events.filter(
    e => e.source === 'agent' && (e.message || e.content)
  );
  if (agentMessages.length > 0) {
    const last = agentMessages[agentMessages.length - 1];
    return last.message ?? last.content ?? '';
  }

  return '';
}

/** DELETE the conversation to free resources. */
async function cleanupConversation(baseUrl: string, conversationId: string): Promise<void> {
  await fetchWithTimeout(
    `${baseUrl}/api/conversations/${conversationId}`,
    { method: 'DELETE' },
    10_000
  );
}

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
