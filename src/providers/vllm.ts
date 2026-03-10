// ============================================================
// vLLM Provider — Local inference via vLLM's OpenAI-compatible API
// ============================================================
// Produces LLMCallFunction instances that call a local vLLM server.
// No external API calls. No cloud dependencies. Everything on localhost.
//
// Two factory functions:
//   vllmProvider()           → LLMCallFunction<string>  (for withLLM)
//   vllmStructuredProvider() → LLMCallFunction<R>       (for withStructuredOutput)
//
// Usage:
//   import { vllmProvider, vllmStructuredProvider } from '@mandible-ai/mandible/providers';
//
//   // Text generation
//   withLLM({
//     model: 'Qwen3-Coder-Next',
//     provider: vllmProvider({ endpoint: 'http://localhost:8001' }),
//     prompt: (signal) => `Summarize: ${signal.payload.text}`,
//     route: 'summary:ready',
//   })
//
//   // Structured output (JSON mode)
//   withStructuredOutput({
//     model: 'Qwen3-Coder-Next',
//     provider: vllmStructuredProvider({ endpoint: 'http://localhost:8001' }),
//     schema: reviewSchema,
//     prompt: (signal) => `Review: ${signal.payload.diff}`,
//     route: (r) => r.approved ? { type: 'review:approved' } : { type: 'review:changes-needed' },
//   })
// ============================================================

import type { LLMCallFunction } from './types.js';

// ----------------------------------------------------------
// Configuration
// ----------------------------------------------------------

export interface VLLMConfig {
  /** vLLM server endpoint, e.g. 'http://localhost:8001'. No trailing slash. */
  endpoint: string;

  /**
   * Model name to use. If not provided, auto-detects from GET /v1/models.
   * The auto-detected model is cached after the first call.
   */
  model?: string;

  /** Optional API key for vLLM (if configured with --api-key). */
  apiKey?: string;

  /**
   * Enable JSON mode via response_format: { type: "json_object" }.
   * Automatically enabled by vllmStructuredProvider().
   * When true, vLLM uses guided decoding to guarantee valid JSON output.
   */
  jsonMode?: boolean;

  /** Maximum retries on 503 (model loading) and 429 (rate limited). Default: 3. */
  maxRetries?: number;

  /** Base delay in ms between retries (exponential backoff). Default: 1000. */
  retryDelayMs?: number;

  /**
   * Whether to verify the vLLM server is reachable on the first call.
   * Calls GET /v1/models and fails fast if the server is down. Default: true.
   */
  healthCheckOnInit?: boolean;

  /** Request timeout in ms. Default: 120_000 (2 minutes). */
  timeoutMs?: number;

  /** Extra headers to include in every request. */
  headers?: Record<string, string>;
}

// ----------------------------------------------------------
// Internal state
// ----------------------------------------------------------

interface VLLMClientState {
  resolvedModel: string | null;
  healthChecked: boolean;
}

// ----------------------------------------------------------
// Factory: text generation (for withLLM)
// ----------------------------------------------------------

/**
 * Creates a LLMCallFunction<string> that calls vLLM for plain text generation.
 * Plug directly into withLLM({ provider: vllmProvider({ endpoint }) }).
 */
export function vllmProvider(config: VLLMConfig): LLMCallFunction<string> {
  const state: VLLMClientState = { resolvedModel: config.model ?? null, healthChecked: false };
  const endpoint = config.endpoint.replace(/\/+$/, '');

  return async (prompt, options) => {
    await ensureReady(endpoint, config, state);

    const messages = buildMessages(prompt, options.systemPrompt);
    const body: Record<string, unknown> = {
      model: state.resolvedModel!,
      messages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0,
    };

    const data = await callVLLM(endpoint, '/v1/chat/completions', body, config);
    return extractText(data);
  };
}

// ----------------------------------------------------------
// Factory: structured output (for withStructuredOutput)
// ----------------------------------------------------------

/**
 * Creates a LLMCallFunction<R> that calls vLLM with JSON mode enabled.
 * The response is parsed as JSON and returned as type R.
 * Plug into withStructuredOutput({ provider: vllmStructuredProvider({ endpoint }) }).
 */
export function vllmStructuredProvider<R = Record<string, unknown>>(
  config: VLLMConfig
): LLMCallFunction<R> {
  const state: VLLMClientState = { resolvedModel: config.model ?? null, healthChecked: false };
  const endpoint = config.endpoint.replace(/\/+$/, '');

  return async (prompt, options) => {
    await ensureReady(endpoint, config, state);

    const messages = buildMessages(prompt, options.systemPrompt);
    const body: Record<string, unknown> = {
      model: state.resolvedModel!,
      messages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0,
      response_format: { type: 'json_object' },
    };

    const data = await callVLLM(endpoint, '/v1/chat/completions', body, config);
    const text = extractText(data);
    return parseJsonResponse<R>(text);
  };
}

// ----------------------------------------------------------
// Health check & model auto-detection
// ----------------------------------------------------------

/**
 * Check that vLLM is reachable and resolve the model name if needed.
 * Both checks happen at most once per provider instance.
 */
async function ensureReady(
  endpoint: string,
  config: VLLMConfig,
  state: VLLMClientState
): Promise<void> {
  const shouldHealthCheck = (config.healthCheckOnInit ?? true) && !state.healthChecked;
  const needsModel = !state.resolvedModel;

  if (!shouldHealthCheck && !needsModel) return;

  const models = await listModels(endpoint, config);
  state.healthChecked = true;

  if (needsModel) {
    if (models.length === 0) {
      throw new VLLMError(
        'No models loaded on vLLM server. Ensure a model is loaded before calling the provider.',
        'NO_MODELS'
      );
    }
    state.resolvedModel = models[0];
  }
}

/**
 * GET /v1/models — returns the list of loaded model IDs.
 */
async function listModels(endpoint: string, config: VLLMConfig): Promise<string[]> {
  const url = `${endpoint}/v1/models`;
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    ...config.headers,
  };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    });
  } catch (err: any) {
    throw new VLLMError(
      `Cannot reach vLLM server at ${endpoint}. Is vLLM running?\n  ${err.message}`,
      'CONNECTION_FAILED'
    );
  }

  if (!response.ok) {
    throw new VLLMError(
      `vLLM health check failed: ${response.status} ${response.statusText}`,
      'HEALTH_CHECK_FAILED'
    );
  }

  const data = await response.json() as { data?: Array<{ id: string }> };
  return (data.data ?? []).map(m => m.id);
}

// ----------------------------------------------------------
// Core HTTP call with retry
// ----------------------------------------------------------

async function callVLLM(
  endpoint: string,
  path: string,
  body: Record<string, unknown>,
  config: VLLMConfig
): Promise<any> {
  const url = `${endpoint}${path}`;
  const maxRetries = config.maxRetries ?? 3;
  const baseDelay = config.retryDelayMs ?? 1000;
  const timeoutMs = config.timeoutMs ?? 120_000;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...config.headers,
  };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      // Retry on 503 (model loading) and 429 (rate limited)
      if ((response.status === 503 || response.status === 429) && attempt < maxRetries) {
        const retryAfter = response.headers.get('retry-after');
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : baseDelay * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new VLLMError(
          `vLLM API error: ${response.status} ${response.statusText}\n${errorBody}`,
          'API_ERROR',
          response.status
        );
      }

      return await response.json();
    } catch (err: any) {
      if (err instanceof VLLMError) throw err;

      lastError = err;
      if (attempt < maxRetries) {
        await sleep(baseDelay * Math.pow(2, attempt));
        continue;
      }
    }
  }

  throw new VLLMError(
    `vLLM request failed after ${maxRetries + 1} attempts: ${lastError?.message}`,
    'MAX_RETRIES_EXCEEDED'
  );
}

// ----------------------------------------------------------
// Response parsing
// ----------------------------------------------------------

function extractText(data: any): string {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new VLLMError(
      `Unexpected vLLM response format: missing choices[0].message.content\n${JSON.stringify(data).slice(0, 500)}`,
      'PARSE_ERROR'
    );
  }
  return content;
}

function parseJsonResponse<R>(text: string): R {
  // Handle markdown-wrapped JSON (```json ... ```)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  const jsonStr = (jsonMatch[1] ?? text).trim();

  try {
    return JSON.parse(jsonStr);
  } catch {
    throw new VLLMError(
      `Failed to parse vLLM response as JSON.\nResponse:\n${text.slice(0, 500)}`,
      'JSON_PARSE_ERROR'
    );
  }
}

// ----------------------------------------------------------
// Message building
// ----------------------------------------------------------

function buildMessages(
  prompt: string,
  systemPrompt?: string
): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });
  return messages;
}

// ----------------------------------------------------------
// Error class
// ----------------------------------------------------------

export type VLLMErrorCode =
  | 'CONNECTION_FAILED'
  | 'HEALTH_CHECK_FAILED'
  | 'NO_MODELS'
  | 'API_ERROR'
  | 'MAX_RETRIES_EXCEEDED'
  | 'PARSE_ERROR'
  | 'JSON_PARSE_ERROR';

export class VLLMError extends Error {
  readonly code: VLLMErrorCode;
  readonly statusCode?: number;

  constructor(message: string, code: VLLMErrorCode, statusCode?: number) {
    super(message);
    this.name = 'VLLMError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ----------------------------------------------------------
// Utilities
// ----------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ----------------------------------------------------------
// Convenience: auto-configured provider from environment
// ----------------------------------------------------------

/**
 * Creates a vllmProvider using VLLM_ENDPOINT environment variable.
 * Returns null if VLLM_ENDPOINT is not set (graceful fallback).
 *
 * Usage:
 *   const provider = vllmFromEnv() ?? 'anthropic';
 */
export function vllmFromEnv(): LLMCallFunction<string> | null {
  const endpoint = process.env.VLLM_ENDPOINT;
  if (!endpoint) return null;
  return vllmProvider({
    endpoint,
    model: process.env.VLLM_MODEL,
    apiKey: process.env.VLLM_API_KEY,
  });
}

/**
 * Creates a vllmStructuredProvider using VLLM_ENDPOINT environment variable.
 * Returns null if VLLM_ENDPOINT is not set.
 */
export function vllmStructuredFromEnv<R = Record<string, unknown>>(): LLMCallFunction<R> | null {
  const endpoint = process.env.VLLM_ENDPOINT;
  if (!endpoint) return null;
  return vllmStructuredProvider<R>({
    endpoint,
    model: process.env.VLLM_MODEL,
    apiKey: process.env.VLLM_API_KEY,
  });
}
