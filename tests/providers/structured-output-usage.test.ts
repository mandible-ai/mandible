// PURPOSE: generateStructured reports the token usage each client gave it,
// normalised to one shape, so a colony can account for spend per call
// without estimating — and reports none for a custom provider function.

import { describe, it, expect, vi } from 'vitest';
import type { Signal, ActionContext } from '../../src/core/types.js';

const calls = vi.hoisted(() => ({ anthropic: [] as any[], openai: [] as any[] }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (req: any) => {
        calls.anthropic.push(req);
        return {
          content: [{ type: 'text', text: '{"answer": 42}' }],
          usage: { input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
        };
      },
    };
  },
}));

vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: async (req: any) => {
          calls.openai.push(req);
          return {
            choices: [{ message: { content: '{"answer": 7}' } }],
            usage: { prompt_tokens: 90, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 64 } },
          };
        },
      },
    };
  },
}));

vi.mock('ai', () => ({
  generateObject: async () => ({ object: { answer: 1 }, usage: { promptTokens: 30, completionTokens: 3 } }),
  generateText: async () => ({ text: '{"answer": 2}', usage: { inputTokens: 40, outputTokens: 4 } }),
}));
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: (id: string) => ({ id }) }));

const signal = { id: 's1', type: 'task:ready', payload: {}, meta: { deposited_at: 0, deposited_by: 't', concentration: 1 } } as unknown as Signal;
const ctx = { colony: 'c', log: () => {} } as unknown as ActionContext;

describe('generateStructured usage', () => {
  it('normalises Anthropic usage, cache fields included', async () => {
    const { generateStructured } = await import('../../src/providers/structured-output.js');
    const r = await generateStructured({ model: 'claude-opus-5-5', provider: 'anthropic', prompt: 'p' }, signal, ctx);
    expect(r.result).toEqual({ answer: 42 });
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 8, cacheReadTokens: 100, cacheWriteTokens: 0 });
  });

  it('normalises OpenAI-compatible usage, cached prompt tokens included', async () => {
    const { generateStructured } = await import('../../src/providers/structured-output.js');
    const r = await generateStructured({ model: 'proj_x/claude-opus-5-5', provider: 'openai', prompt: 'p' }, signal, ctx);
    expect(r.result).toEqual({ answer: 7 });
    expect(r.usage).toEqual({ inputTokens: 90, outputTokens: 5, cacheReadTokens: 64 });
  });

  it('normalises Vercel AI usage under both the v4 and v5 field names', async () => {
    const { generateStructured } = await import('../../src/providers/structured-output.js');
    const withSchema = await generateStructured({ model: 'claude-opus-5-5', provider: 'vercel-ai', prompt: 'p', schema: { parse: (x: unknown) => x } }, signal, ctx);
    expect(withSchema.usage).toEqual({ inputTokens: 30, outputTokens: 3 });
    const text = await generateStructured({ model: 'claude-opus-5-5', provider: 'vercel-ai', prompt: 'p' }, signal, ctx);
    expect(text.usage).toEqual({ inputTokens: 40, outputTokens: 4 });
  });

  it('reports no usage for a custom provider function, and the result is unchanged', async () => {
    const { generateStructured } = await import('../../src/providers/structured-output.js');
    const r = await generateStructured({ model: 'm', provider: async () => ({ answer: 3 }), prompt: 'p' }, signal, ctx);
    expect(r).toEqual({ result: { answer: 3 }, model: 'm' });
    expect('usage' in r).toBe(false);
  });
});
