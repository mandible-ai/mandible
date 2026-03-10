// PURPOSE: Tests for the vLLM provider (local inference via OpenAI-compatible API)
// PURPOSE: Covers vllmProvider, vllmStructuredProvider, health check, model auto-detect,
//          retry logic, error handling, JSON mode, env-based factory

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  vllmProvider,
  vllmStructuredProvider,
  vllmFromEnv,
  vllmStructuredFromEnv,
  VLLMError,
} from '../../src/providers/vllm.js';

// ── Mock fetch ──────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VLLM_ENDPOINT;
  delete process.env.VLLM_MODEL;
  delete process.env.VLLM_API_KEY;
});

// ── Helpers ─────────────────────────────────────────────────

function mockModelsResponse(models: string[] = ['Qwen3-Coder-Next']) {
  return new Response(
    JSON.stringify({ data: models.map(id => ({ id, object: 'model' })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function mockCompletionResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function mock503Response() {
  return new Response('Model loading', { status: 503, statusText: 'Service Unavailable' });
}

function mock429Response(retryAfter?: string) {
  const headers: Record<string, string> = {};
  if (retryAfter) headers['retry-after'] = retryAfter;
  return new Response('Rate limited', { status: 429, statusText: 'Too Many Requests', headers });
}

// ── vllmProvider (text generation) ──────────────────────────

describe('vllmProvider', () => {
  it('calls /v1/models then /v1/chat/completions on first call', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse(['Qwen3-Coder-Next']))
      .mockResolvedValueOnce(mockCompletionResponse('Hello world'));

    const provider = vllmProvider({ endpoint: 'http://localhost:8001' });
    const result = await provider('Say hello', { maxTokens: 100, temperature: 0 });

    expect(result).toBe('Hello world');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Check models call
    const modelsCall = mockFetch.mock.calls[0];
    expect(modelsCall[0]).toBe('http://localhost:8001/v1/models');

    // Check completions call
    const completionsCall = mockFetch.mock.calls[1];
    expect(completionsCall[0]).toBe('http://localhost:8001/v1/chat/completions');
    const body = JSON.parse(completionsCall[1].body);
    expect(body.model).toBe('Qwen3-Coder-Next');
    expect(body.messages).toEqual([{ role: 'user', content: 'Say hello' }]);
    expect(body.max_tokens).toBe(100);
  });

  it('skips health check on second call (model cached)', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockCompletionResponse('First'))
      .mockResolvedValueOnce(mockCompletionResponse('Second'));

    const provider = vllmProvider({ endpoint: 'http://localhost:8001' });
    await provider('First', {});
    const result = await provider('Second', {});

    expect(result).toBe('Second');
    // 1 models call + 2 completion calls = 3
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('uses explicit model name and skips auto-detect', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse(['Qwen3-Coder-Next', 'other-model']))
      .mockResolvedValueOnce(mockCompletionResponse('Done'));

    const provider = vllmProvider({
      endpoint: 'http://localhost:8001',
      model: 'my-custom-model',
    });
    const result = await provider('Test', {});

    expect(result).toBe('Done');
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.model).toBe('my-custom-model');
  });

  it('skips health check when healthCheckOnInit is false', async () => {
    mockFetch.mockResolvedValueOnce(mockCompletionResponse('Fast'));

    const provider = vllmProvider({
      endpoint: 'http://localhost:8001',
      model: 'Qwen3-Coder-Next',
      healthCheckOnInit: false,
    });
    const result = await provider('Test', {});

    expect(result).toBe('Fast');
    // Only 1 call (completion), no models call
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('includes system prompt in messages', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockCompletionResponse('OK'));

    const provider = vllmProvider({ endpoint: 'http://localhost:8001' });
    await provider('User prompt', { systemPrompt: 'You are a helpful assistant' });

    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'user', content: 'User prompt' },
    ]);
  });

  it('sends API key as Bearer token', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockCompletionResponse('Secure'));

    const provider = vllmProvider({
      endpoint: 'http://localhost:8001',
      apiKey: 'my-secret-key',
    });
    await provider('Test', {});

    // Check both calls have auth header
    for (const call of mockFetch.mock.calls) {
      expect(call[1].headers['Authorization']).toBe('Bearer my-secret-key');
    }
  });

  it('strips trailing slash from endpoint', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockCompletionResponse('OK'));

    const provider = vllmProvider({ endpoint: 'http://localhost:8001/' });
    await provider('Test', {});

    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:8001/v1/models');
    expect(mockFetch.mock.calls[1][0]).toBe('http://localhost:8001/v1/chat/completions');
  });

  it('sends extra headers', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockCompletionResponse('OK'));

    const provider = vllmProvider({
      endpoint: 'http://localhost:8001',
      headers: { 'X-Custom': 'value' },
    });
    await provider('Test', {});

    expect(mockFetch.mock.calls[1][1].headers['X-Custom']).toBe('value');
  });
});

// ── vllmStructuredProvider (JSON mode) ──────────────────────

describe('vllmStructuredProvider', () => {
  it('sends response_format: json_object and parses JSON', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockCompletionResponse('{"approved": true, "feedback": "LGTM"}'));

    const provider = vllmStructuredProvider<{ approved: boolean; feedback: string }>({
      endpoint: 'http://localhost:8001',
    });
    const result = await provider('Review this code', {});

    expect(result).toEqual({ approved: true, feedback: 'LGTM' });

    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('handles markdown-wrapped JSON in response', async () => {
    const wrappedJson = '```json\n{"score": 95, "pass": true}\n```';
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockCompletionResponse(wrappedJson));

    const provider = vllmStructuredProvider<{ score: number; pass: boolean }>({
      endpoint: 'http://localhost:8001',
    });
    const result = await provider('Grade this', {});

    expect(result).toEqual({ score: 95, pass: true });
  });

  it('throws VLLMError on invalid JSON', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockCompletionResponse('This is not JSON at all'));

    const provider = vllmStructuredProvider({ endpoint: 'http://localhost:8001' });

    try {
      await provider('Parse this', {});
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(VLLMError);
      expect(err.code).toBe('JSON_PARSE_ERROR');
      expect(err.message).toMatch(/Failed to parse vLLM response as JSON/);
    }
  });
});

// ── Health check and model detection ────────────────────────

describe('health check & model detection', () => {
  it('throws CONNECTION_FAILED when server is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    const provider = vllmProvider({ endpoint: 'http://localhost:9999' });

    try {
      await provider('Test', {});
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(VLLMError);
      expect(err.code).toBe('CONNECTION_FAILED');
    }
  });

  it('throws NO_MODELS when no models are loaded', async () => {
    mockFetch.mockResolvedValueOnce(mockModelsResponse([]));

    const provider = vllmProvider({ endpoint: 'http://localhost:8001' });

    try {
      await provider('Test', {});
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(VLLMError);
      expect(err.code).toBe('NO_MODELS');
    }
  });

  it('auto-detects first model from /v1/models', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse(['model-a', 'model-b']))
      .mockResolvedValueOnce(mockCompletionResponse('OK'));

    const provider = vllmProvider({ endpoint: 'http://localhost:8001' });
    await provider('Test', {});

    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.model).toBe('model-a');
  });

  it('throws HEALTH_CHECK_FAILED on non-200 models response', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
    );

    const provider = vllmProvider({ endpoint: 'http://localhost:8001' });

    try {
      await provider('Test', {});
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(VLLMError);
      expect(err.code).toBe('HEALTH_CHECK_FAILED');
    }
  });
});

// ── Retry logic ─────────────────────────────────────────────

describe('retry logic', () => {
  it('retries on 503 and succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mock503Response())
      .mockResolvedValueOnce(mockCompletionResponse('Eventually worked'));

    const provider = vllmProvider({
      endpoint: 'http://localhost:8001',
      retryDelayMs: 1, // fast for tests
    });
    const result = await provider('Test', {});

    expect(result).toBe('Eventually worked');
    // 1 models + 2 completions (1 retry + 1 success) = 3
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('retries on 429 and respects retry-after header', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mock429Response('1'))
      .mockResolvedValueOnce(mockCompletionResponse('OK'));

    const provider = vllmProvider({
      endpoint: 'http://localhost:8001',
      retryDelayMs: 1,
    });
    const result = await provider('Test', {});

    expect(result).toBe('OK');
  });

  it('throws after max retries exceeded on persistent 503', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValue(mock503Response());

    const provider = vllmProvider({
      endpoint: 'http://localhost:8001',
      maxRetries: 2,
      retryDelayMs: 1,
    });

    try {
      await provider('Test', {});
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(VLLMError);
      expect(err.code).toBe('API_ERROR');
      expect(err.statusCode).toBe(503);
    }
  });

  it('retries on network errors and eventually succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockRejectedValueOnce(new TypeError('network timeout'))
      .mockResolvedValueOnce(mockCompletionResponse('Recovered'));

    const provider = vllmProvider({
      endpoint: 'http://localhost:8001',
      retryDelayMs: 1,
    });
    const result = await provider('Test', {});

    expect(result).toBe('Recovered');
  });

  it('throws MAX_RETRIES_EXCEEDED on persistent network errors', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockRejectedValue(new TypeError('Connection refused'));

    const provider = vllmProvider({
      endpoint: 'http://localhost:8001',
      maxRetries: 1,
      retryDelayMs: 1,
    });

    try {
      await provider('Test', {});
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(VLLMError);
      expect(err.code).toBe('MAX_RETRIES_EXCEEDED');
    }
  });
});

// ── API error handling ──────────────────────────────────────

describe('API errors', () => {
  it('throws API_ERROR with status code on 400', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(
        new Response('{"error": "invalid request"}', { status: 400, statusText: 'Bad Request' })
      );

    const provider = vllmProvider({ endpoint: 'http://localhost:8001' });

    try {
      await provider('Test', {});
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(VLLMError);
      expect(err.code).toBe('API_ERROR');
      expect(err.statusCode).toBe(400);
    }
  });

  it('throws PARSE_ERROR when response has no content', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: {} }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    const provider = vllmProvider({ endpoint: 'http://localhost:8001' });

    await expect(provider('Test', {})).rejects.toThrow(VLLMError);
  });
});

// ── Environment-based factories ─────────────────────────────

describe('vllmFromEnv', () => {
  it('returns null when VLLM_ENDPOINT is not set', () => {
    expect(vllmFromEnv()).toBeNull();
  });

  it('returns a provider when VLLM_ENDPOINT is set', () => {
    process.env.VLLM_ENDPOINT = 'http://localhost:8001';
    const provider = vllmFromEnv();
    expect(provider).toBeTypeOf('function');
  });

  it('uses VLLM_MODEL and VLLM_API_KEY from env', async () => {
    process.env.VLLM_ENDPOINT = 'http://localhost:8001';
    process.env.VLLM_MODEL = 'custom-model';
    process.env.VLLM_API_KEY = 'test-key';

    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockCompletionResponse('OK'));

    const provider = vllmFromEnv()!;
    await provider('Test', {});

    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.model).toBe('custom-model');
    expect(mockFetch.mock.calls[1][1].headers['Authorization']).toBe('Bearer test-key');
  });
});

describe('vllmStructuredFromEnv', () => {
  it('returns null when VLLM_ENDPOINT is not set', () => {
    expect(vllmStructuredFromEnv()).toBeNull();
  });

  it('returns a provider with JSON mode when VLLM_ENDPOINT is set', async () => {
    process.env.VLLM_ENDPOINT = 'http://localhost:8001';

    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockCompletionResponse('{"ok": true}'));

    const provider = vllmStructuredFromEnv<{ ok: boolean }>()!;
    const result = await provider('Test', {});

    expect(result).toEqual({ ok: true });
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });
});

// ── VLLMError ───────────────────────────────────────────────

describe('VLLMError', () => {
  it('has name, code, and optional statusCode', () => {
    const err = new VLLMError('test error', 'API_ERROR', 500);
    expect(err.name).toBe('VLLMError');
    expect(err.code).toBe('API_ERROR');
    expect(err.statusCode).toBe(500);
    expect(err.message).toBe('test error');
    expect(err).toBeInstanceOf(Error);
  });
});
