// PURPOSE: Tests for the withOpenHands provider (OpenHands agent server integration)
// PURPOSE: Covers REST lifecycle, prompt resolution, output mapping, error handling, timeout

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Signal, ActionContext } from '../../src/core/types.js';
import { withOpenHands, OpenHandsError } from '../../src/providers/openhands.js';
import type { OpenHandsResult, OpenHandsEvent } from '../../src/providers/openhands.js';

// ── Mock fetch ──────────────────────────────────────────────

let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchResponses: Array<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }> = [];

function mockFetchResponse(data: any, ok = true, status = 200) {
  fetchResponses.push({
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
}

/** A minimal mock signal */
function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig_test_001',
    type: 'ci:failed',
    payload: { logs: 'Build failed: test suite error', prNumber: 42 },
    meta: {
      deposited_at: Date.now(),
      deposited_by: 'test-colony',
      concentration: 1.0,
    },
    ...overrides,
  };
}

/** A mock ActionContext that records calls */
function makeContext(): ActionContext & {
  deposits: Array<{ type: string; payload: any; options: any }>;
  withdrawals: string[];
  logs: Array<{ message: string; level?: string }>;
} {
  const deposits: Array<{ type: string; payload: any; options: any }> = [];
  const withdrawals: string[] = [];
  const logs: Array<{ message: string; level?: string }> = [];

  return {
    colony: 'test-devops',
    deposits,
    withdrawals,
    logs,
    async deposit(type, payload, options) {
      deposits.push({ type, payload, options });
      return {
        id: `sig_deposited_${deposits.length}`,
        type,
        payload: payload ?? {},
        meta: { deposited_at: Date.now(), deposited_by: 'test-devops', concentration: 1.0 },
      };
    },
    async withdraw(signalId) {
      withdrawals.push(signalId);
    },
    log(message, level) {
      logs.push({ message, level });
    },
    async enrich() { return makeSignal(); },
    async heartbeat() {},
  };
}

// ── Setup / Teardown ────────────────────────────────────────

const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];

  // Mock global fetch
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    fetchCalls.push({ url: url.toString(), init });
    const response = fetchResponses.shift();
    if (!response) {
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'no mock response' };
    }
    return response;
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────

describe('withOpenHands', () => {

  // Helper: set up standard successful flow
  function setupSuccessFlow(conversationId = 'conv_001') {
    // 1. Create conversation
    mockFetchResponse({ conversation_id: conversationId });
    // 2. Send message
    mockFetchResponse({ status: 'ok' });
    // 3. Poll status — finished
    mockFetchResponse({ status: 'finished', summary: 'Fixed the CI failure by updating deps.' });
    // 4. DELETE cleanup
    mockFetchResponse({}, true, 204);
  }

  // ── Core lifecycle ────────────────────────────────────────

  it('creates conversation with correct serverUrl', async () => {
    setupSuccessFlow();

    const handler = withOpenHands({
      serverUrl: 'http://my-openhands:3001',
      prompt: 'Fix the CI',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    expect(fetchCalls[0].url).toBe('http://my-openhands:3001/api/conversations');
  });

  it('uses default serverUrl when not specified', async () => {
    setupSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix the CI',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    expect(fetchCalls[0].url).toBe('http://localhost:3001/api/conversations');
  });

  it('sends model and llmBaseUrl in create body', async () => {
    setupSuccessFlow();

    const handler = withOpenHands({
      model: 'openai/qwen3-coder',
      llmBaseUrl: 'http://dgx-inference:8000/v1',
      prompt: 'Fix the CI',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    const createBody = JSON.parse(fetchCalls[0].init.body as string);
    expect(createBody.model).toBe('openai/qwen3-coder');
    expect(createBody.llm_base_url).toBe('http://dgx-inference:8000/v1');
  });

  it('sends resolved prompt as user message', async () => {
    setupSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Investigate failure in test suite',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    // Second fetch call is the message send
    const messageBody = JSON.parse(fetchCalls[1].init.body as string);
    expect(messageBody.role).toBe('user');
    expect(messageBody.content).toBe('Investigate failure in test suite');
  });

  // ── Prompt resolution ─────────────────────────────────────

  it('resolves prompt from function', async () => {
    setupSuccessFlow();

    const handler = withOpenHands({
      prompt: (signal) => `Fix PR #${(signal.payload as any).prNumber}: ${(signal.payload as any).logs}`,
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    const messageBody = JSON.parse(fetchCalls[1].init.body as string);
    expect(messageBody.content).toBe('Fix PR #42: Build failed: test suite error');
  });

  it('resolves async prompt function', async () => {
    setupSuccessFlow();

    const handler = withOpenHands({
      prompt: async (signal) => {
        // Simulates calling assembleContext in a closure
        return `Context: ...\n\nFix: ${(signal.payload as any).logs}`;
      },
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    const messageBody = JSON.parse(fetchCalls[1].init.body as string);
    expect(messageBody.content).toContain('Context: ...');
  });

  // ── Output mapping ────────────────────────────────────────

  it('deposits default signal type when no output mapping', async () => {
    setupSuccessFlow();

    const handler = withOpenHands({ prompt: 'Fix it' });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits.length).toBe(1);
    expect(ctx.deposits[0].type).toBe('ci:failed:completed');
    expect(ctx.deposits[0].payload.status).toBe('finished');
  });

  it('deposits static output type', async () => {
    setupSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed', tags: ['ci'] },
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].type).toBe('devops:fixed');
    expect(ctx.deposits[0].options.tags).toEqual(['ci']);
  });

  it('deposits via function output mapping', async () => {
    setupSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: (result: OpenHandsResult, signal) => ({
        type: result.status === 'finished' ? 'devops:fixed' : 'devops:investigated',
        payload: { summary: result.text, prNumber: (signal.payload as any).prNumber },
      }),
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].type).toBe('devops:fixed');
    expect(ctx.deposits[0].payload.summary).toBe('Fixed the CI failure by updating deps.');
    expect(ctx.deposits[0].payload.prNumber).toBe(42);
  });

  it('sets causedBy in deposited signals', async () => {
    setupSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].options.causedBy).toEqual(['sig_test_001']);
  });

  // ── Auto-withdraw ─────────────────────────────────────────

  it('auto-withdraws triggering signal by default', async () => {
    setupSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.withdrawals).toEqual(['sig_test_001']);
  });

  it('skips auto-withdraw when disabled', async () => {
    setupSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
      autoWithdraw: false,
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.withdrawals).toEqual([]);
  });

  // ── Working directory ─────────────────────────────────────

  it('sends working directory in create body', async () => {
    setupSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      workingDirectory: '/opt/workspace/my-repo',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    const createBody = JSON.parse(fetchCalls[0].init.body as string);
    expect(createBody.initial_cwd).toBe('/opt/workspace/my-repo');
  });

  it('resolves working directory from signal', async () => {
    setupSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      workingDirectory: (signal) => `/opt/workspace/${(signal.payload as any).repo ?? 'default'}`,
      output: { type: 'devops:fixed' },
    });

    const signal = makeSignal({ payload: { repo: 'my-app', logs: 'fail' } });
    await handler(signal, makeContext());

    const createBody = JSON.parse(fetchCalls[0].init.body as string);
    expect(createBody.initial_cwd).toBe('/opt/workspace/my-app');
  });

  // ── Error handling ────────────────────────────────────────

  it('throws OpenHandsError on conversation create failure', async () => {
    mockFetchResponse({ error: 'server down' }, false, 503);

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });

    await expect(handler(makeSignal(), makeContext())).rejects.toThrow(OpenHandsError);
    await expect(handler(makeSignal(), makeContext())).rejects.toThrow('Failed to create');
  });

  it('throws OpenHandsError when no conversation ID returned', async () => {
    mockFetchResponse({}, true, 200); // No conversation_id field

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });

    await expect(handler(makeSignal(), makeContext())).rejects.toThrow('no conversation ID');
  });

  it('handles error state from status poll', async () => {
    // Create conversation
    mockFetchResponse({ conversation_id: 'conv_err' });
    // Send message
    mockFetchResponse({ status: 'ok' });
    // Poll status — error
    mockFetchResponse({ status: 'error', summary: 'Agent crashed' });
    // DELETE cleanup
    mockFetchResponse({}, true, 204);

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: (result: OpenHandsResult) => ({
        type: result.status === 'finished' ? 'devops:fixed' : 'devops:error',
        payload: { status: result.status, text: result.text },
      }),
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].type).toBe('devops:error');
    expect(ctx.deposits[0].payload.status).toBe('error');
  });

  // ── Cleanup ───────────────────────────────────────────────

  it('cleans up conversation even on error', async () => {
    // Create conversation succeeds
    mockFetchResponse({ conversation_id: 'conv_cleanup' });
    // Send message fails
    mockFetchResponse({ error: 'bad request' }, false, 400);
    // DELETE cleanup
    mockFetchResponse({}, true, 204);

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });

    await expect(handler(makeSignal(), makeContext())).rejects.toThrow();

    // The last fetch call should be DELETE for cleanup
    const deleteCalls = fetchCalls.filter(c => c.init.method === 'DELETE');
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0].url).toContain('conv_cleanup');
  });

  // ── Logging ───────────────────────────────────────────────

  it('logs conversation creation and completion', async () => {
    setupSuccessFlow('conv_log');

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    const logMessages = ctx.logs.map(l => l.message);
    expect(logMessages.some(m => m.includes('conv_log') && m.includes('created'))).toBe(true);
    expect(logMessages.some(m => m.includes('finished'))).toBe(true);
  });

  // ── Max iterations ────────────────────────────────────────

  it('sends maxIterations in create body', async () => {
    setupSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      maxIterations: 100,
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    const createBody = JSON.parse(fetchCalls[0].init.body as string);
    expect(createBody.max_iterations).toBe(100);
  });
});
