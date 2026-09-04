// PURPOSE: Tests for the gemini provider — gateway-first routing inside
// Mandible zones, direct Google access with GEMINI_API_KEY elsewhere.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withLLM } from '../../src/providers/llm.js';
import type { Signal, ActionContext } from '../../src/core/types.js';

vi.mock('openai', () => {
  const mockCreate = vi.fn().mockResolvedValue({
    choices: [{ message: { content: 'gateway gemini text' } }],
  });
  return {
    default: class OpenAI {
      chat = { completions: { create: mockCreate } };
      static _mockCreate = mockCreate;
    },
  };
});

vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({ text: 'direct gemini text' }),
}));

vi.mock('@ai-sdk/google', () => {
  const modelFn = vi.fn().mockReturnValue('mock-google-model');
  return {
    createGoogleGenerativeAI: vi.fn().mockReturnValue(modelFn),
  };
});

function makeSignal(): Signal {
  return {
    id: 'sig_g_001',
    type: 'task:ready',
    payload: { content: 'hello' },
    meta: { deposited_at: Date.now(), deposited_by: 'test', concentration: 1.0 },
  };
}

function makeContext(): ActionContext & { deposits: any[] } {
  const deposits: any[] = [];
  return {
    colony: 'test',
    deposits,
    async deposit(type: string, payload: any, options: any) {
      deposits.push({ type, payload, options });
      return { id: 'sig_d', type, payload: payload ?? {}, meta: { deposited_at: Date.now(), deposited_by: 'test', concentration: 1.0 } };
    },
    async withdraw() {},
    log() {},
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('gemini provider', () => {
  it('routes through the Mandible gateway when zone env is present', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://gw.test/v1');
    vi.stubEnv('OPENAI_API_KEY', 'sk-zone-key');

    const handler = withLLM({
      provider: 'gemini',
      model: 'gemini-3.7-flash',
      prompt: 'Say hi',
      route: 'out:ready',
    });
    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const { default: OpenAI } = await import('openai');
    expect((OpenAI as any)._mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-3.7-flash' })
    );
    const { generateText } = await import('ai');
    expect(generateText).not.toHaveBeenCalled();
    expect(ctx.deposits[0].payload.text).toBe('gateway gemini text');
  });

  it('returns raw markdown when the gateway JSON-encodes Gemini text', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://gw.test/v1');
    vi.stubEnv('OPENAI_API_KEY', 'sk-zone-key');
    const markdown = '# The Barnyard Guide\n\nValid **Markdown**.';
    const { default: OpenAI } = await import('openai');
    (OpenAI as any)._mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(markdown) } }],
    });

    const handler = withLLM({
      provider: 'gemini',
      model: 'gemini-3.7-flash',
      prompt: 'Write a guide',
      format: 'markdown',
      route: 'out:ready',
    });
    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].payload).toEqual({
      text: markdown,
      format: 'markdown',
    });
  });

  it('normalizes gemini/ and google/ prefixes for the gateway model group', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://gw.test/v1');
    vi.stubEnv('OPENAI_API_KEY', 'sk-zone-key');

    const handler = withLLM({
      provider: 'gemini',
      model: 'gemini/gemini-3.7-flash',
      prompt: 'Say hi',
      route: 'out:ready',
    });
    await handler(makeSignal(), makeContext());

    const { default: OpenAI } = await import('openai');
    expect((OpenAI as any)._mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-3.7-flash' })
    );
  });

  it('talks to Google directly with GEMINI_API_KEY outside a zone', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'g-key');

    const handler = withLLM({
      provider: 'gemini',
      model: 'gemini-3.7-flash',
      prompt: 'Say hi',
      route: 'out:ready',
    });
    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
    expect(createGoogleGenerativeAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'g-key' })
    );
    expect(ctx.deposits[0].payload.text).toBe('direct gemini text');
  });

  it('fails with a pointed error when neither gateway nor key exists', async () => {
    vi.stubEnv('OPENAI_BASE_URL', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', '');
    const handler = withLLM({
      provider: 'gemini',
      model: 'gemini-3.7-flash',
      prompt: 'Say hi',
      route: 'out:ready',
      onError: 'rethrow',
    });
    await expect(handler(makeSignal(), makeContext())).rejects.toThrow(/GEMINI_API_KEY|gateway/);
  });
});

describe('gateway model-group resolution', () => {
  it('resolves a bare model to the project-scoped group when no exact group exists', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://gw.test/v1');
    vi.stubEnv('OPENAI_API_KEY', 'sk-zone-key');
    vi.stubEnv('MANDIBLE_MODEL_GROUPS', 'proj_abc/gemini-3.7-flash,proj_abc/claude-sonnet-5');

    const handler = withLLM({
      provider: 'gemini',
      model: 'gemini-3.7-flash',
      prompt: 'Say hi',
      route: 'out:ready',
    });
    await handler(makeSignal(), makeContext());

    const { default: OpenAI } = await import('openai');
    expect((OpenAI as any)._mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'proj_abc/gemini-3.7-flash' })
    );
  });

  it('prefers an exact group match over a suffix match', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://gw.test/v1');
    vi.stubEnv('OPENAI_API_KEY', 'sk-zone-key');
    vi.stubEnv('MANDIBLE_MODEL_GROUPS', 'gemini-3.7-flash,proj_abc/gemini-3.7-flash');

    const handler = withLLM({
      provider: 'gemini',
      model: 'gemini-3.7-flash',
      prompt: 'Say hi',
      route: 'out:ready',
    });
    await handler(makeSignal(), makeContext());

    const { default: OpenAI } = await import('openai');
    expect((OpenAI as any)._mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-3.7-flash' })
    );
  });

  it('passes the name through unchanged when no groups are declared', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://gw.test/v1');
    vi.stubEnv('OPENAI_API_KEY', 'sk-zone-key');
    vi.stubEnv('MANDIBLE_MODEL_GROUPS', '');

    const handler = withLLM({
      provider: 'gemini',
      model: 'gemini-3.7-flash',
      prompt: 'Say hi',
      route: 'out:ready',
    });
    await handler(makeSignal(), makeContext());

    const { default: OpenAI } = await import('openai');
    expect((OpenAI as any)._mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemini-3.7-flash' })
    );
  });
});
