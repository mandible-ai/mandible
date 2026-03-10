// PURPOSE: Tests for the withLLM provider (plain text LLM generation)
// PURPOSE: Covers prompt resolution, routing, auto-withdraw, causality, provider dispatch, missing SDK errors

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Signal, ActionContext } from '../../src/core/types.js';

// ── Helpers ─────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig_test_001',
    type: 'article:ready',
    payload: { content: 'Some article text' },
    meta: {
      deposited_at: Date.now(),
      deposited_by: 'test',
      concentration: 1.0,
    },
    ...overrides,
  };
}

function makeContext(): ActionContext & {
  deposits: Array<{ type: string; payload: any; options: any }>;
  withdrawals: string[];
  logs: string[];
} {
  const deposits: Array<{ type: string; payload: any; options: any }> = [];
  const withdrawals: string[] = [];
  const logs: string[] = [];

  return {
    colony: 'test-colony',
    deposits,
    withdrawals,
    logs,
    async deposit(type, payload, options) {
      deposits.push({ type, payload, options });
      return {
        id: `sig_deposited_${deposits.length}`,
        type,
        payload: payload ?? {},
        meta: { deposited_at: Date.now(), deposited_by: 'test-colony', concentration: 1.0 },
      };
    },
    async withdraw(signalId) {
      withdrawals.push(signalId);
    },
    log(message) {
      logs.push(message);
    },
  };
}

// ── Mocks ───────────────────────────────────────────────────

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'Generated summary text' }],
  });
  return {
    default: class Anthropic {
      messages = { create: mockCreate };
      static _mockCreate = mockCreate;
    },
  };
});

// Mock OpenAI SDK
vi.mock('openai', () => {
  const mockCreate = vi.fn().mockResolvedValue({
    choices: [{ message: { content: 'OpenAI generated text' } }],
  });
  return {
    default: class OpenAI {
      chat = { completions: { create: mockCreate } };
      static _mockCreate = mockCreate;
    },
  };
});

// Mock Bedrock SDK
vi.mock('@anthropic-ai/bedrock-sdk', () => {
  const mockCreate = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'Bedrock generated text' }],
  });
  return {
    default: class AnthropicBedrock {
      constructor(_opts: any) {}
      messages = { create: mockCreate };
      static _mockCreate = mockCreate;
    },
  };
});

// Mock Vercel AI SDK
vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({ text: 'Vercel AI generated text' }),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn().mockReturnValue('mock-anthropic-model'),
}));

vi.mock('@ai-sdk/openai', () => ({
  openai: vi.fn().mockReturnValue('mock-openai-model'),
}));

vi.mock('@ai-sdk/google', () => ({
  google: vi.fn().mockReturnValue('mock-google-model'),
}));

// ── Tests ───────────────────────────────────────────────────

describe('withLLM', () => {
  let withLLM: typeof import('../../src/providers/llm.js').withLLM;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../src/providers/llm.js');
    withLLM = mod.withLLM;
  });

  // -- Prompt resolution --

  describe('prompt resolution', () => {
    it('uses a static string prompt', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Summarize this',
        route: 'summary:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const mockCreate = (Anthropic as any)._mockCreate;
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: 'user', content: 'Summarize this' }],
        })
      );
    });

    it('uses an async function prompt', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: async (signal) => `Summarize: ${(signal.payload as any).content}`,
        route: 'summary:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const mockCreate = (Anthropic as any)._mockCreate;
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: 'user', content: 'Summarize: Some article text' }],
        })
      );
    });
  });

  // -- Route as string --

  describe('route as string', () => {
    it('deposits signal with { text } payload', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Generate text',
        route: 'summary:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      expect(ctx.deposits).toHaveLength(1);
      expect(ctx.deposits[0].type).toBe('summary:ready');
      expect(ctx.deposits[0].payload).toEqual({ text: 'Generated summary text' });
    });
  });

  // -- Route as function --

  describe('route as function', () => {
    it('deposits custom payload from route function', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Generate text',
        route: (text, signal) => ({
          type: 'custom:output',
          payload: { summary: text, sourceId: signal.id },
          tags: ['processed'],
        }),
      });

      const ctx = makeContext();
      const signal = makeSignal();
      await handler(signal, ctx);

      expect(ctx.deposits).toHaveLength(1);
      expect(ctx.deposits[0].type).toBe('custom:output');
      expect(ctx.deposits[0].payload).toEqual({
        summary: 'Generated summary text',
        sourceId: 'sig_test_001',
      });
      expect(ctx.deposits[0].options.tags).toEqual(['processed']);
    });

    it('supports returning multiple deposits', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Generate text',
        route: (text) => [
          { type: 'primary:output', payload: { text } },
          { type: 'audit:log', payload: { generated: true } },
        ],
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      expect(ctx.deposits).toHaveLength(2);
      expect(ctx.deposits[0].type).toBe('primary:output');
      expect(ctx.deposits[1].type).toBe('audit:log');
    });
  });

  // -- Auto-withdraw --

  describe('auto-withdraw', () => {
    it('withdraws triggering signal by default', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Generate text',
        route: 'output:ready',
      });

      const ctx = makeContext();
      const signal = makeSignal();
      await handler(signal, ctx);

      expect(ctx.withdrawals).toEqual(['sig_test_001']);
    });

    it('skips withdrawal when autoWithdraw is false', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Generate text',
        route: 'output:ready',
        autoWithdraw: false,
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      expect(ctx.withdrawals).toHaveLength(0);
    });
  });

  // -- Causality tracking --

  describe('causality tracking', () => {
    it('sets causedBy on deposited signals', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Generate text',
        route: 'output:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal({ id: 'sig_cause_123' }), ctx);

      expect(ctx.deposits[0].options.causedBy).toEqual(['sig_cause_123']);
    });
  });

  // -- Custom provider function --

  describe('custom provider function', () => {
    it('passes through to custom function', async () => {
      const customFn = vi.fn().mockResolvedValue('Custom LLM output');

      const handler = withLLM({
        model: 'custom-model',
        provider: customFn,
        prompt: 'Do something',
        route: 'result:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      expect(customFn).toHaveBeenCalledWith('Do something', {
        systemPrompt: undefined,
        maxTokens: 4096,
        temperature: 0,
      });
      expect(ctx.deposits[0].payload).toEqual({ text: 'Custom LLM output' });
    });

    it('respects systemPrompt, maxTokens, temperature in custom function', async () => {
      const customFn = vi.fn().mockResolvedValue('output');

      const handler = withLLM({
        model: 'custom-model',
        provider: customFn,
        prompt: 'Prompt',
        systemPrompt: 'You are helpful',
        maxTokens: 2048,
        temperature: 0.7,
        route: 'result:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      expect(customFn).toHaveBeenCalledWith('Prompt', {
        systemPrompt: 'You are helpful',
        maxTokens: 2048,
        temperature: 0.7,
      });
    });
  });

  // -- Provider dispatch --

  describe('provider dispatch', () => {
    it('calls Anthropic provider', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Test prompt',
        route: 'output:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const mockCreate = (Anthropic as any)._mockCreate;
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 4096,
        })
      );
      expect(ctx.deposits[0].payload).toEqual({ text: 'Generated summary text' });
    });

    it('calls OpenAI provider without response_format', async () => {
      const handler = withLLM({
        model: 'gpt-4o',
        provider: 'openai',
        prompt: 'Test prompt',
        route: 'output:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const { default: OpenAI } = await import('openai');
      const mockCreate = (OpenAI as any)._mockCreate;
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4o',
          max_tokens: 4096,
        })
      );
      // Verify NO response_format (unlike structured-output)
      expect(mockCreate).toHaveBeenCalledWith(
        expect.not.objectContaining({
          response_format: expect.anything(),
        })
      );
      expect(ctx.deposits[0].payload).toEqual({ text: 'OpenAI generated text' });
    });

    it('calls Bedrock provider', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'bedrock',
        prompt: 'Test prompt',
        bedrockConfig: { region: 'us-east-1' },
        route: 'output:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      expect(ctx.deposits[0].payload).toEqual({ text: 'Bedrock generated text' });
    });

    it('throws when bedrock provider has no bedrockConfig', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'bedrock',
        prompt: 'Test prompt',
        route: 'output:ready',
      });

      const ctx = makeContext();
      await expect(handler(makeSignal(), ctx)).rejects.toThrow('bedrockConfig');
    });

    it('calls Vercel AI provider with generateText', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'vercel-ai',
        prompt: 'Test prompt',
        route: 'output:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const { generateText } = await import('ai');
      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Test prompt',
        })
      );
      expect(ctx.deposits[0].payload).toEqual({ text: 'Vercel AI generated text' });
    });

    it('defaults to anthropic when no provider specified', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        prompt: 'Test prompt',
        route: 'output:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const mockCreate = (Anthropic as any)._mockCreate;
      expect(mockCreate).toHaveBeenCalled();
    });
  });

  // -- System prompt --

  describe('system prompt', () => {
    it('passes system prompt to Anthropic', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Generate text',
        systemPrompt: 'You are a helpful summarizer.',
        route: 'output:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const mockCreate = (Anthropic as any)._mockCreate;
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'You are a helpful summarizer.',
        })
      );
    });

    it('passes system prompt to OpenAI as system message', async () => {
      const handler = withLLM({
        model: 'gpt-4o',
        provider: 'openai',
        prompt: 'Generate text',
        systemPrompt: 'You are a helpful summarizer.',
        route: 'output:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const { default: OpenAI } = await import('openai');
      const mockCreate = (OpenAI as any)._mockCreate;
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: 'You are a helpful summarizer.' },
            { role: 'user', content: 'Generate text' },
          ],
        })
      );
    });
  });

  // -- Logging --

  describe('logging', () => {
    it('logs completion message', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Generate text',
        route: 'output:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      expect(ctx.logs).toContain('LLM text generation completed. Deposited 1 signal(s).');
    });
  });

  // -- Format --

  describe('format', () => {
    it('omits format from payload by default', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Generate text',
        route: 'output:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      expect(ctx.deposits[0].payload).toEqual({ text: 'Generated summary text' });
      expect(ctx.deposits[0].payload).not.toHaveProperty('format');
    });

    it('omits format from payload when format is "text"', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Generate text',
        format: 'text',
        route: 'output:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      expect(ctx.deposits[0].payload).toEqual({ text: 'Generated summary text' });
      expect(ctx.deposits[0].payload).not.toHaveProperty('format');
    });

    it('includes format in payload when format is "markdown"', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Generate text',
        format: 'markdown',
        route: 'output:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      expect(ctx.deposits[0].payload).toEqual({
        text: 'Generated summary text',
        format: 'markdown',
      });
    });

    it('appends markdown instruction to prompt', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Summarize this',
        format: 'markdown',
        route: 'output:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const mockCreate = (Anthropic as any)._mockCreate;
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{
            role: 'user',
            content: 'Summarize this\n\nRespond using well-structured markdown.',
          }],
        })
      );
    });

    it('does not append instruction when format is "text"', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Summarize this',
        format: 'text',
        route: 'output:ready',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const mockCreate = (Anthropic as any)._mockCreate;
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: 'user', content: 'Summarize this' }],
        })
      );
    });

    it('does not affect route function payload', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Generate text',
        format: 'markdown',
        route: (text) => ({
          type: 'custom:output',
          payload: { body: text },
        }),
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      // Route function controls the payload — format is not injected
      expect(ctx.deposits[0].payload).toEqual({ body: 'Generated summary text' });
    });
  });

  // -- Tags and TTL passthrough --

  describe('tags and TTL from route function', () => {
    it('passes tags and ttl through to deposit', async () => {
      const handler = withLLM({
        model: 'claude-sonnet-4-5-20250929',
        provider: 'anthropic',
        prompt: 'Generate text',
        route: () => ({
          type: 'output:ready',
          payload: { text: 'hi' },
          tags: ['important'],
          ttl: 60000,
        }),
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      expect(ctx.deposits[0].options.tags).toEqual(['important']);
      expect(ctx.deposits[0].options.ttl).toBe(60000);
    });
  });
});
