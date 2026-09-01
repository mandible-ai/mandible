// PURPOSE: Tests for the withOpenCode provider (OpenCode SDK integration)
// PURPOSE: Covers SDK consumption, session lifecycle, prompt resolution, output mapping, error handling

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Signal, ActionContext } from '../../src/core/types.js';
import type { OpenCodeResult } from '../../src/providers/opencode.js';

// ── Mock SDK ─────────────────────────────────────────────────

function makeMockClient(overrides: Record<string, any> = {}) {
  const sessionId = overrides.sessionId ?? 'sess_mock_001';

  const mockClient = {
    session: {
      create: vi.fn(async () => ({
        data: { id: sessionId, title: 'test' },
      })),
      prompt: vi.fn(async () => ({
        data: {
          parts: [{ type: 'text', text: 'Agent completed the task.' }],
          info: {},
        },
      })),
      delete: vi.fn(async () => true),
      messages: vi.fn(async () => ({ data: [] })),
    },
    event: {
      subscribe: vi.fn(async () => ({
        stream: (async function* () {
          // Empty by default
        })(),
      })),
    },
    ...overrides,
  };

  return mockClient;
}

/** A minimal mock signal */
function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig_test_001',
    type: 'task:ready',
    payload: { name: 'test-task', description: 'Do something' },
    meta: {
      deposited_at: Date.now(),
      deposited_by: 'test',
      concentration: 1.0,
    },
    ...overrides,
  };
}

/** A mock ActionContext that records calls */
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

// ── Tests ────────────────────────────────────────────────────

describe('withOpenCode', () => {
  let mockClient: ReturnType<typeof makeMockClient>;
  let mockCreateClient: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockClient = makeMockClient();
    mockCreateClient = vi.fn(() => mockClient);
    vi.resetModules();

    vi.doMock('@opencode-ai/sdk', () => ({
      createOpencodeClient: mockCreateClient,
    }));
  });

  async function loadWithOpenCode() {
    const mod = await import('../../src/providers/opencode.js');
    return mod.withOpenCode;
  }

  // ── Core lifecycle ────────────────────────────────────────

  it('creates client with correct serverUrl', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'Do the task',
      serverUrl: 'http://my-server:9000',
      output: { type: 'task:completed' },
    });

    await handler(makeSignal(), makeContext());

    expect(mockCreateClient).toHaveBeenCalledWith({ baseUrl: 'http://my-server:9000' });
  });

  it('uses default serverUrl when not specified', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'Do the task',
      output: { type: 'task:completed' },
    });

    await handler(makeSignal(), makeContext());

    expect(mockCreateClient).toHaveBeenCalledWith({ baseUrl: 'http://localhost:4096' });
  });

  it('creates session with agent and model config', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'Do the task',
      agent: 'plan',
      model: 'anthropic/claude-sonnet-4-5-20250929',
      output: { type: 'task:completed' },
    });

    await handler(makeSignal(), makeContext());

    expect(mockClient.session.create).toHaveBeenCalledWith({
      body: {
        agent: 'plan',
        model: 'anthropic/claude-sonnet-4-5-20250929',
      },
    });
  });

  it('sends prompt and deposits result', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'Do the task',
      output: { type: 'task:completed' },
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    // Verify prompt was sent
    expect(mockClient.session.prompt).toHaveBeenCalled();
    const promptCall = mockClient.session.prompt.mock.calls.find(
      (c: any[]) => !c[0].body.noReply
    );
    expect(promptCall[0].body.parts).toEqual([{ type: 'text', text: 'Do the task' }]);

    // Verify deposit
    expect(ctx.deposits).toHaveLength(1);
    expect(ctx.deposits[0].type).toBe('task:completed');
    expect(ctx.deposits[0].payload.text).toBe('Agent completed the task.');
    expect(ctx.deposits[0].payload.sessionId).toBe('sess_mock_001');
    expect(ctx.deposits[0].options.causedBy).toEqual(['sig_test_001']);
  });

  it('extracts text from response parts', async () => {
    mockClient.session.prompt.mockResolvedValueOnce({
      data: {
        parts: [
          { type: 'text', text: 'Part 1.' },
          { type: 'tool_call', name: 'bash' },
          { type: 'text', text: 'Part 2.' },
        ],
        info: {},
      },
    });

    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'test',
      output: { type: 'done' },
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].payload.text).toBe('Part 1.\nPart 2.');
  });

  it('deletes session after completion (cleanup)', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'test',
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    expect(mockClient.session.delete).toHaveBeenCalledWith({
      path: { id: 'sess_mock_001' },
    });
  });

  it('auto-withdraws triggering signal', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'test',
      output: { type: 'done' },
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.withdrawals).toEqual(['sig_test_001']);
  });

  // ── Prompt resolution ─────────────────────────────────────

  it('resolves prompt from a function', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: (signal) => `Implement: ${(signal.payload as any).name}`,
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    const promptCall = mockClient.session.prompt.mock.calls.find(
      (c: any[]) => !c[0].body.noReply
    );
    expect(promptCall[0].body.parts[0].text).toBe('Implement: test-task');
  });

  it('resolves async prompt function', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: async (signal) => `Async: ${(signal.payload as any).name}`,
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    const promptCall = mockClient.session.prompt.mock.calls.find(
      (c: any[]) => !c[0].body.noReply
    );
    expect(promptCall[0].body.parts[0].text).toBe('Async: test-task');
  });

  // ── System prompt ─────────────────────────────────────────

  it('sends systemPrompt as noReply message before main prompt', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'Do the task',
      systemPrompt: 'You are a scout agent.',
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    // First prompt call should be the system prompt with noReply
    const calls = mockClient.session.prompt.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].body.parts[0].text).toBe('You are a scout agent.');
    expect(calls[0][0].body.noReply).toBe(true);

    // Second call is the main prompt
    expect(calls[1][0].body.parts[0].text).toBe('Do the task');
    expect(calls[1][0].body.noReply).toBeUndefined();
  });

  it('skips noReply call when no systemPrompt', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'Do the task',
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    expect(mockClient.session.prompt).toHaveBeenCalledTimes(1);
    expect(mockClient.session.prompt.mock.calls[0][0].body.noReply).toBeUndefined();
  });

  // ── Configuration ─────────────────────────────────────────

  it('passes working directory to session.create', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'test',
      workingDirectory: '/workspace/repo',
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    expect(mockClient.session.create).toHaveBeenCalledWith({
      body: expect.objectContaining({ path: '/workspace/repo' }),
    });
  });

  it('resolves workingDirectory from function', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'test',
      workingDirectory: (signal) => `/workspace/${(signal.payload as any).name}`,
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    expect(mockClient.session.create).toHaveBeenCalledWith({
      body: expect.objectContaining({ path: '/workspace/test-task' }),
    });
  });

  it('passes agent type to session.create', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'test',
      agent: 'explore',
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    expect(mockClient.session.create).toHaveBeenCalledWith({
      body: expect.objectContaining({ agent: 'explore' }),
    });
  });

  // ── Structured output ─────────────────────────────────────

  it('extracts structured_output from response when schema provided', async () => {
    mockClient.session.prompt.mockResolvedValueOnce({
      data: {
        parts: [{ type: 'text', text: '{"company":"Anthropic"}' }],
        info: { structured_output: { company: 'Anthropic', founded: 2021 } },
      },
    });

    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'Research Anthropic',
      schema: {
        name: 'company_info',
        schema: {
          type: 'object',
          properties: {
            company: { type: 'string' },
            founded: { type: 'number' },
          },
        },
      },
      output: { type: 'research:done' },
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].payload.structuredOutput).toEqual({
      company: 'Anthropic',
      founded: 2021,
    });
  });

  it('passes json_schema format to prompt body', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'test',
      schema: {
        name: 'my_schema',
        schema: { type: 'object', properties: { x: { type: 'number' } } },
      },
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    const promptCall = mockClient.session.prompt.mock.calls.find(
      (c: any[]) => !c[0].body.noReply
    );
    expect(promptCall[0].body.format).toEqual({
      type: 'json_schema',
      schema: { type: 'object', properties: { x: { type: 'number' } } },
    });
  });

  // ── Output mapping ────────────────────────────────────────

  it('custom output mapping function', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'scan',
      output: (result: OpenCodeResult) => ({
        type: 'scan:done',
        payload: { summary: result.text } as any,
      }),
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits).toHaveLength(1);
    expect(ctx.deposits[0].type).toBe('scan:done');
    expect(ctx.deposits[0].payload).toEqual({ summary: 'Agent completed the task.' });
  });

  it('deposits default {type}:completed when no output mapping', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({ prompt: 'test' });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits).toHaveLength(1);
    expect(ctx.deposits[0].type).toBe('task:ready:completed');
  });

  it('static output type with tags and ttl', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'test',
      output: { type: 'result:done', tags: ['important'], ttl: 60_000 },
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].type).toBe('result:done');
    expect(ctx.deposits[0].options.tags).toEqual(['important']);
    expect(ctx.deposits[0].options.ttl).toBe(60_000);
  });

  // ── Error handling ────────────────────────────────────────

  it('wraps MODULE_NOT_FOUND with install instructions', async () => {
    vi.resetModules();
    vi.doMock('@opencode-ai/sdk', () => ({
      createOpencodeClient: () => {
        const err = new Error('Cannot find module something');
        (err as any).code = 'MODULE_NOT_FOUND';
        throw err;
      },
    }));

    const { withOpenCode } = await import('../../src/providers/opencode.js');
    const handler = withOpenCode({ prompt: 'test', output: { type: 'done' } });

    await expect(handler(makeSignal(), makeContext())).rejects.toThrow(
      'withOpenCode requires @opencode-ai/sdk'
    );
  });

  it('wraps ERR_MODULE_NOT_FOUND with install instructions', async () => {
    vi.resetModules();
    vi.doMock('@opencode-ai/sdk', () => ({
      createOpencodeClient: () => {
        const err = new Error('Cannot find module something');
        (err as any).code = 'ERR_MODULE_NOT_FOUND';
        throw err;
      },
    }));

    const { withOpenCode } = await import('../../src/providers/opencode.js');
    const handler = withOpenCode({ prompt: 'test', output: { type: 'done' } });

    await expect(handler(makeSignal(), makeContext())).rejects.toThrow(
      'withOpenCode requires @opencode-ai/sdk'
    );
  });

  it('re-throws non-module errors', async () => {
    vi.resetModules();
    vi.doMock('@opencode-ai/sdk', () => ({
      createOpencodeClient: () => { throw new Error('Network failure'); },
    }));

    const { withOpenCode } = await import('../../src/providers/opencode.js');
    const handler = withOpenCode({ prompt: 'test', output: { type: 'done' } });

    await expect(handler(makeSignal(), makeContext())).rejects.toThrow('Network failure');
  });

  it('cleans up session even on error (finally block)', async () => {
    mockClient.session.prompt.mockRejectedValueOnce(new Error('Prompt failed'));

    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'test',
      output: { type: 'done' },
    });

    await expect(handler(makeSignal(), makeContext())).rejects.toThrow('Prompt failed');

    expect(mockClient.session.delete).toHaveBeenCalledWith({
      path: { id: 'sess_mock_001' },
    });
  });

  // ── Observability ─────────────────────────────────────────

  it('calls onEvent for each SSE event until aborted', async () => {
    const received: unknown[] = [];
    let streamAborted = false;

    // Mock the event stream that checks abortSignal before yielding
    mockClient.event.subscribe.mockResolvedValueOnce({
      stream: (async function* () {
        // First event - always delivered
        yield { type: 'message.start', properties: {} };

        // Simulate that more events would come but abort signal stops them
        await new Promise((r) => setTimeout(r, 10));

        // By now the handler has likely completed and aborted
        // In real scenario, stream would check abort and stop
        streamAborted = true;
      })(),
    });

    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'test',
      onEvent: (event) => received.push(event),
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    // Give the background event consumer a tick to process
    await new Promise((r) => setTimeout(r, 50));

    // Should receive at least the first event before abort
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]).toEqual({ type: 'message.start', properties: {} });
  });

  it('onEvent callback errors do not crash the agent', async () => {
    mockClient.event.subscribe.mockResolvedValueOnce({
      stream: (async function* () {
        yield { type: 'test', properties: {} };
      })(),
    });

    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'test',
      onEvent: () => { throw new Error('callback boom'); },
      output: { type: 'done' },
    });

    // Should not throw
    await handler(makeSignal(), makeContext());
  });

  // ── Auto-withdraw ─────────────────────────────────────────

  it('skips withdrawal when autoWithdraw is false', async () => {
    const withOpenCode = await loadWithOpenCode();
    const handler = withOpenCode({
      prompt: 'test',
      autoWithdraw: false,
      output: { type: 'done' },
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.withdrawals).toHaveLength(0);
  });
});

describe('buildOpenCodeSystemPrompt', () => {
  it('includes colony name and task instructions', async () => {
    vi.resetModules();
    vi.doMock('@opencode-ai/sdk', () => ({
      createOpencodeClient: vi.fn(),
    }));

    const { buildOpenCodeSystemPrompt } = await import('../../src/providers/opencode.js');
    const prompt = buildOpenCodeSystemPrompt('my-colony');

    expect(prompt).toContain('my-colony');
    expect(prompt).toContain('Complete the task');
    expect(prompt).toContain('compile/pass tests');
  });
});
