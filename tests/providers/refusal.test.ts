// PURPOSE: Tests for model refusals as a first-class outcome.
// PURPOSE: Covers RefusalError detection (anthropic/bedrock/openai), refusalRoute
//          deposits in withStructuredOutput, and the tool-loop 'refusal' stop reason.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Signal, ActionContext } from '../../src/core/types.js';
import { RefusalError, isRefusal } from '../../src/providers/refusal.js';

// ── Helpers ─────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig_refusal_001',
    type: 'task:ready',
    payload: { name: 'test-task' },
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

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@anthropic-ai/bedrock-sdk');
  vi.unstubAllGlobals();
});

// ── RefusalError ────────────────────────────────────────────

describe('RefusalError', () => {
  it('is distinguishable from ordinary errors', () => {
    const refusal = new RefusalError('cannot help with that', 'anthropic');
    expect(isRefusal(refusal)).toBe(true);
    expect(isRefusal(new Error('cannot help with that'))).toBe(false);
    expect(refusal.reason).toBe('cannot help with that');
    expect(refusal.provider).toBe('anthropic');
  });

  it('survives serialization boundaries via the refusal discriminant', () => {
    const wireShaped = { refusal: true, reason: 'declined', message: 'Model refused: declined' };
    expect(isRefusal(wireShaped)).toBe(true);
  });
});

// ── withStructuredOutput refusal handling ───────────────────

describe('withStructuredOutput refusals', () => {
  function mockBedrockCreate(response: any) {
    const mockCreate = vi.fn().mockResolvedValue(response);
    vi.doMock('@anthropic-ai/bedrock-sdk', () => ({
      default: class AnthropicBedrock {
        messages = { create: mockCreate };
        constructor(public opts: any) {}
      },
    }));
    return mockCreate;
  }

  it('throws RefusalError on stop_reason refusal when no refusalRoute is set', async () => {
    mockBedrockCreate({
      content: [{ type: 'text', text: 'I cannot help with that.' }],
      stop_reason: 'refusal',
    });

    const { withStructuredOutput } = await import('../../src/providers/structured-output.js');
    const handler = withStructuredOutput({
      model: 'claude-sonnet-4-5-20250929',
      provider: 'bedrock',
      bedrockConfig: { region: 'us-east-1' },
      prompt: 'Review this',
      route: 'review:done',
    });

    const ctx = makeContext();
    let caught: unknown;
    try {
      await handler(makeSignal(), ctx);
    } catch (err) {
      caught = err;
    }
    expect(isRefusal(caught)).toBe(true);
    expect((caught as RefusalError).reason).toBe('I cannot help with that.');
    expect(ctx.deposits).toHaveLength(0);
    // The triggering signal was NOT withdrawn — the work is still there.
    expect(ctx.withdrawals).toHaveLength(0);
  });

  it('routes a refusal to a signal when refusalRoute is a string', async () => {
    mockBedrockCreate({
      content: [{ type: 'text', text: 'Declining this request.' }],
      stop_reason: 'refusal',
    });

    const { withStructuredOutput } = await import('../../src/providers/structured-output.js');
    const handler = withStructuredOutput({
      model: 'claude-sonnet-4-5-20250929',
      provider: 'bedrock',
      bedrockConfig: { region: 'us-east-1' },
      prompt: 'Review this',
      route: 'review:done',
      refusalRoute: 'review:refused',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits).toHaveLength(1);
    expect(ctx.deposits[0].type).toBe('review:refused');
    expect(ctx.deposits[0].payload).toEqual({ reason: 'Declining this request.', provider: 'bedrock' });
    expect(ctx.deposits[0].options.causedBy).toEqual(['sig_refusal_001']);
    expect(ctx.withdrawals).toEqual(['sig_refusal_001']);
  });

  it('routes a refusal through a mapping function', async () => {
    mockBedrockCreate({
      content: [],
      stop_reason: 'refusal',
    });

    const { withStructuredOutput } = await import('../../src/providers/structured-output.js');
    const handler = withStructuredOutput({
      model: 'claude-sonnet-4-5-20250929',
      provider: 'bedrock',
      bedrockConfig: { region: 'us-east-1' },
      prompt: 'Review this',
      route: 'review:done',
      refusalRoute: (reason, signal) => ({
        type: 'agent:refused',
        payload: { reason, subject: signal.payload.name },
      }),
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].type).toBe('agent:refused');
    expect(ctx.deposits[0].payload.subject).toBe('test-task');
  });

  it('does not treat an ordinary error as a refusal', async () => {
    const mockCreate = vi.fn().mockRejectedValue(new Error('rate limited'));
    vi.doMock('@anthropic-ai/bedrock-sdk', () => ({
      default: class AnthropicBedrock {
        messages = { create: mockCreate };
        constructor(public opts: any) {}
      },
    }));

    const { withStructuredOutput } = await import('../../src/providers/structured-output.js');
    const handler = withStructuredOutput({
      model: 'claude-sonnet-4-5-20250929',
      provider: 'bedrock',
      bedrockConfig: { region: 'us-east-1' },
      prompt: 'Review this',
      route: 'review:done',
      refusalRoute: 'review:refused',
    });

    const ctx = makeContext();
    await expect(handler(makeSignal(), ctx)).rejects.toThrow('rate limited');
    expect(ctx.deposits).toHaveLength(0);
  });
});

// ── withToolLoop refusal stop reason ────────────────────────

describe('withToolLoop refusals', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  it('stops with stopReason refusal on finish_reason content_filter', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ data: [{ id: 'test-model' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          choices: [{
            message: { role: 'assistant', content: 'I will not do that.' },
            finish_reason: 'content_filter',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ));

    const { withToolLoop } = await import('../../src/providers/tool-loop.js');
    const handler = withToolLoop({
      endpoint: 'http://localhost:8001',
      tools: [],
      prompt: 'Do the thing',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits).toHaveLength(1);
    const result = ctx.deposits[0].payload;
    expect(result.stopReason).toBe('refusal');
    expect(result.success).toBe(false);
    expect(result.refusal).toBe('I will not do that.');
  });
});
