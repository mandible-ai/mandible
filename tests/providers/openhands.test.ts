// PURPOSE: Tests for the withOpenHands provider (OpenHands V1 API)
// PURPOSE: Covers V1 REST lifecycle, startup polling, completion polling, error handling, status mapping

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Signal, ActionContext } from '../../src/core/types.js';
import { withOpenHands, OpenHandsError } from '../../src/providers/openhands.js';
import type { OpenHandsResult, OpenHandsEvent } from '../../src/providers/openhands.js';

// ── Mock fetch ──────────────────────────────────────────────

let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchHandlers: Array<(url: string, init: RequestInit) => { ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }> = [];

function pushHandler(handler: (url: string, init: RequestInit) => { ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }) {
  fetchHandlers.push(handler);
}

function mockResponse(data: any, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

/** Queue a simple response that will be consumed by the next matching fetch. */
function queueResponse(data: any, ok = true, status = 200) {
  pushHandler(() => mockResponse(data, ok, status));
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
  fetchHandlers = [];

  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    fetchCalls.push({ url: url.toString(), init });
    const handler = fetchHandlers.shift();
    if (!handler) {
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'no mock response' };
    }
    return handler(url.toString(), init);
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── Helpers ─────────────────────────────────────────────────

/** Set up the standard V1 success flow: create → startup READY → execution FINISHED */
function setupV1SuccessFlow(conversationId = 'conv_001', lastMessage = 'Fixed the CI failure by updating deps.') {
  // 1. Create conversation (POST /api/v1/app-conversations)
  queueResponse({ conversation_id: conversationId });
  // 2. Start-task poll → READY (GET /api/v1/app-conversations/start-tasks)
  queueResponse({ tasks: [{ conversation_id: conversationId, status: 'READY' }] });
  // 3. Completion poll → FINISHED (GET /api/v1/app-conversations)
  queueResponse({ conversations: [{ conversation_id: conversationId, execution_status: 'FINISHED', sandbox_status: 'RUNNING', last_message: lastMessage }] });
}

// ── Tests ───────────────────────────────────────────────────

describe('withOpenHands', () => {

  // ── 1. Happy path ─────────────────────────────────────────

  it('happy path: create → startup READY → execution FINISHED', async () => {
    setupV1SuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix the CI',
      output: { type: 'devops:fixed' },
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits.length).toBe(1);
    expect(ctx.deposits[0].type).toBe('devops:fixed');
    expect(ctx.deposits[0].payload.status).toBe('finished');
    expect(ctx.deposits[0].payload.text).toBe('Fixed the CI failure by updating deps.');
    expect(ctx.withdrawals).toEqual(['sig_test_001']);
  });

  // ── 2. Startup polling progression ─────────────────────────

  it('startup polling: QUEUED → RUNNING → READY progression', async () => {
    // Create
    queueResponse({ conversation_id: 'conv_startup' });
    // Start-task poll 1: QUEUED
    queueResponse({ tasks: [{ conversation_id: 'conv_startup', status: 'QUEUED' }] });
    // Start-task poll 2: RUNNING
    queueResponse({ tasks: [{ conversation_id: 'conv_startup', status: 'RUNNING' }] });
    // Start-task poll 3: READY
    queueResponse({ tasks: [{ conversation_id: 'conv_startup', status: 'READY' }] });
    // Completion poll → FINISHED
    queueResponse({ conversations: [{ conversation_id: 'conv_startup', execution_status: 'FINISHED', sandbox_status: 'RUNNING', last_message: 'Done' }] });

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].payload.status).toBe('finished');
    // Verify start-tasks was called multiple times
    const startTaskCalls = fetchCalls.filter(c => c.url.includes('start-tasks'));
    expect(startTaskCalls.length).toBe(3);
  });

  // ── 3. Startup timeout ────────────────────────────────────

  it('startup timeout: never reaches READY', async () => {
    vi.useFakeTimers();

    // Create
    queueResponse({ conversation_id: 'conv_st_timeout' });
    // Start-task polls: always QUEUED (supply plenty)
    for (let i = 0; i < 40; i++) {
      queueResponse({ tasks: [{ conversation_id: 'conv_st_timeout', status: 'QUEUED' }] });
    }

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });

    let caughtError: Error | undefined;
    const promise = handler(makeSignal(), makeContext()).catch((err) => {
      caughtError = err;
    });

    // Advance past 60s startup timeout
    await vi.advanceTimersByTimeAsync(70_000);

    await promise;

    expect(caughtError).toBeDefined();
    expect(caughtError!.name).toBe('OpenHandsError');
    expect((caughtError as any).code).toBe('STARTUP_TIMEOUT');

    vi.useRealTimers();
  });

  // ── 4. Startup error ──────────────────────────────────────

  it('startup error: start-task returns ERROR', async () => {
    // Create
    queueResponse({ conversation_id: 'conv_st_err' });
    // Start-task → ERROR
    queueResponse({ tasks: [{ conversation_id: 'conv_st_err', status: 'ERROR' }] });

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });

    await expect(handler(makeSignal(), makeContext())).rejects.toThrow(
      expect.objectContaining({
        name: 'OpenHandsError',
        code: 'STARTUP_FAILED',
      })
    );
  });

  // ── 5. Execution error ────────────────────────────────────

  it('execution error: execution_status ERROR', async () => {
    // Create
    queueResponse({ conversation_id: 'conv_exec_err' });
    // Startup → READY
    queueResponse({ tasks: [{ conversation_id: 'conv_exec_err', status: 'READY' }] });
    // Completion → ERROR
    queueResponse({ conversations: [{ conversation_id: 'conv_exec_err', execution_status: 'ERROR', sandbox_status: 'RUNNING', last_message: 'Agent crashed' }] });

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
    expect(ctx.deposits[0].payload.text).toBe('Agent crashed');
  });

  // ── 6. Execution stuck ────────────────────────────────────

  it('execution stuck: execution_status STUCK', async () => {
    // Create
    queueResponse({ conversation_id: 'conv_stuck' });
    // Startup → READY
    queueResponse({ tasks: [{ conversation_id: 'conv_stuck', status: 'READY' }] });
    // Completion → STUCK
    queueResponse({ conversations: [{ conversation_id: 'conv_stuck', execution_status: 'STUCK', sandbox_status: 'RUNNING', last_message: 'Cannot proceed' }] });

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: (result: OpenHandsResult) => ({
        type: `devops:${result.status}`,
        payload: { text: result.text },
      }),
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].type).toBe('devops:stuck');
    expect(ctx.deposits[0].payload.text).toBe('Cannot proceed');
  });

  // ── 7. Sandbox error ──────────────────────────────────────

  it('sandbox error: sandbox_status ERROR', async () => {
    // Create
    queueResponse({ conversation_id: 'conv_sandbox_err' });
    // Startup → READY
    queueResponse({ tasks: [{ conversation_id: 'conv_sandbox_err', status: 'READY' }] });
    // Completion → sandbox ERROR
    queueResponse({ conversations: [{ conversation_id: 'conv_sandbox_err', execution_status: 'RUNNING', sandbox_status: 'ERROR', last_message: 'Sandbox crashed' }] });

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: (result: OpenHandsResult) => ({
        type: `devops:${result.status}`,
        payload: { text: result.text },
      }),
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].type).toBe('devops:error');
    expect(ctx.deposits[0].payload.text).toBe('Sandbox crashed');
  });

  // ── 8. Stopped state ──────────────────────────────────────

  it('stopped state: PAUSED + STOPPED', async () => {
    // Create
    queueResponse({ conversation_id: 'conv_stop' });
    // Startup → READY
    queueResponse({ tasks: [{ conversation_id: 'conv_stop', status: 'READY' }] });
    // Completion → PAUSED + STOPPED
    queueResponse({ conversations: [{ conversation_id: 'conv_stop', execution_status: 'PAUSED', sandbox_status: 'STOPPED' }] });

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: (result: OpenHandsResult) => ({
        type: `devops:${result.status}`,
        payload: { text: result.text },
      }),
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].type).toBe('devops:stopped');
  });

  // ── 9. Timeout: execution never finishes ──────────────────

  it('timeout: execution never finishes', async () => {
    vi.useFakeTimers();

    // Create
    queueResponse({ conversation_id: 'conv_timeout' });
    // Startup → READY
    queueResponse({ tasks: [{ conversation_id: 'conv_timeout', status: 'READY' }] });
    // Completion polls — always RUNNING (supply many)
    for (let i = 0; i < 20; i++) {
      queueResponse({ conversations: [{ conversation_id: 'conv_timeout', execution_status: 'RUNNING', sandbox_status: 'RUNNING' }] });
    }

    const handler = withOpenHands({
      prompt: 'Fix it',
      timeout: 8_000,
      output: (result: OpenHandsResult) => ({
        type: result.status === 'timeout' ? 'devops:timeout' : 'devops:done',
        payload: { status: result.status },
      }),
    });
    const ctx = makeContext();

    const promise = handler(makeSignal(), ctx);

    await vi.advanceTimersByTimeAsync(70_000);

    await promise;

    expect(ctx.deposits[0].type).toBe('devops:timeout');
    expect(ctx.deposits[0].payload.status).toBe('timeout');

    vi.useRealTimers();
  });

  // ── 10. Auth header ───────────────────────────────────────

  it('includes Authorization header when apiKey is set', async () => {
    setupV1SuccessFlow();

    const handler = withOpenHands({
      apiKey: 'my-secret-key',
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    // All fetch calls should include the auth header
    for (const call of fetchCalls) {
      const authHeader = (call.init.headers as Record<string, string>)['Authorization'];
      expect(authHeader).toBe('Bearer my-secret-key');
    }
  });

  it('omits Authorization header when apiKey is not set', async () => {
    setupV1SuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    for (const call of fetchCalls) {
      const authHeader = (call.init.headers as Record<string, string>)['Authorization'];
      expect(authHeader).toBeUndefined();
    }
  });

  // ── 11. Repository ────────────────────────────────────────

  it('sends static repository in create body', async () => {
    setupV1SuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      repository: 'https://github.com/my-org/my-repo',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    const createBody = JSON.parse(fetchCalls[0].init.body as string);
    expect(createBody.repository).toBe('https://github.com/my-org/my-repo');
  });

  it('resolves repository from signal function', async () => {
    setupV1SuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      repository: (signal) => `https://github.com/org/${(signal.payload as any).repo ?? 'default'}`,
      output: { type: 'devops:fixed' },
    });

    const signal = makeSignal({ payload: { repo: 'my-app', logs: 'fail' } });
    await handler(signal, makeContext());

    const createBody = JSON.parse(fetchCalls[0].init.body as string);
    expect(createBody.repository).toBe('https://github.com/org/my-app');
  });

  // ── 12. Dynamic prompt resolution ─────────────────────────

  it('resolves async prompt function', async () => {
    setupV1SuccessFlow();

    const handler = withOpenHands({
      prompt: async (signal) => {
        return `Context: ...\n\nFix: ${(signal.payload as any).logs}`;
      },
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    const createBody = JSON.parse(fetchCalls[0].init.body as string);
    expect(createBody.initial_message).toContain('Context: ...');
    expect(createBody.initial_message).toContain('Build failed: test suite error');
  });

  it('sends static prompt as initial_message', async () => {
    setupV1SuccessFlow();

    const handler = withOpenHands({
      prompt: 'Investigate failure in test suite',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    const createBody = JSON.parse(fetchCalls[0].init.body as string);
    expect(createBody.initial_message).toBe('Investigate failure in test suite');
  });

  // ── 13. Output mapping ────────────────────────────────────

  it('deposits default signal type when no output mapping', async () => {
    setupV1SuccessFlow();

    const handler = withOpenHands({ prompt: 'Fix it' });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits.length).toBe(1);
    expect(ctx.deposits[0].type).toBe('ci:failed:completed');
    expect(ctx.deposits[0].payload.status).toBe('finished');
  });

  it('deposits static output type', async () => {
    setupV1SuccessFlow();

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
    setupV1SuccessFlow();

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

  it('deposits multiple signals from array output mapping', async () => {
    setupV1SuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: (result: OpenHandsResult, signal) => [
        { type: 'devops:fixed', payload: { summary: result.text } },
        { type: 'audit:action', payload: { action: 'ci-fix', signal: signal.id }, tags: ['audit'] },
      ],
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits.length).toBe(2);
    expect(ctx.deposits[0].type).toBe('devops:fixed');
    expect(ctx.deposits[1].type).toBe('audit:action');
    expect(ctx.deposits[1].options.tags).toEqual(['audit']);
  });

  // ── 14. Auto-withdraw ─────────────────────────────────────

  it('auto-withdraws triggering signal by default', async () => {
    setupV1SuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.withdrawals).toEqual(['sig_test_001']);
  });

  it('skips auto-withdraw when disabled', async () => {
    setupV1SuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
      autoWithdraw: false,
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.withdrawals).toEqual([]);
  });

  // ── 15. onEvent callback ──────────────────────────────────

  it('onEvent callback receives synthetic events on status changes', async () => {
    vi.useFakeTimers();

    // Create
    queueResponse({ conversation_id: 'conv_events' });
    // Startup → READY
    queueResponse({ tasks: [{ conversation_id: 'conv_events', status: 'READY' }] });
    // Completion poll 1 → RUNNING
    queueResponse({ conversations: [{ conversation_id: 'conv_events', execution_status: 'RUNNING', sandbox_status: 'RUNNING' }] });
    // Completion poll 2 → FINISHED
    queueResponse({ conversations: [{ conversation_id: 'conv_events', execution_status: 'FINISHED', sandbox_status: 'RUNNING', last_message: 'Done' }] });

    const receivedEvents: OpenHandsEvent[] = [];
    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
      onEvent: (event) => receivedEvents.push(event),
    });
    const ctx = makeContext();

    const promise = handler(makeSignal(), ctx);

    await vi.advanceTimersByTimeAsync(15_000);

    await promise;

    // Should have received at least 2 events (RUNNING→FINISHED status changes)
    expect(receivedEvents.length).toBeGreaterThanOrEqual(2);
    expect(receivedEvents[0].observation).toBe('status_change');
    expect(receivedEvents[0].message).toContain('RUNNING');

    vi.useRealTimers();
  });

  // ── 16. Create conversation failure ───────────────────────

  it('throws OpenHandsError on conversation create failure', async () => {
    queueResponse({ error: 'server down' }, false, 503);

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });

    await expect(handler(makeSignal(), makeContext())).rejects.toThrow(
      expect.objectContaining({
        name: 'OpenHandsError',
        code: 'CONVERSATION_CREATE_FAILED',
        message: expect.stringContaining('Failed to create'),
      })
    );
  });

  it('throws OpenHandsError when no conversation ID returned', async () => {
    queueResponse({}, true, 200);

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });

    await expect(handler(makeSignal(), makeContext())).rejects.toThrow('no conversation ID');
  });

  // ── V1-specific: serverUrl default port ───────────────────

  it('uses default serverUrl http://localhost:3000', async () => {
    setupV1SuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix the CI',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    expect(fetchCalls[0].url).toBe('http://localhost:3000/api/v1/app-conversations');
  });

  it('uses custom serverUrl', async () => {
    setupV1SuccessFlow();

    const handler = withOpenHands({
      serverUrl: 'http://my-openhands:3000',
      prompt: 'Fix the CI',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    expect(fetchCalls[0].url).toBe('http://my-openhands:3000/api/v1/app-conversations');
  });

  // ── V1-specific: model and working directory ──────────────

  it('sends model as selected_model in create body', async () => {
    setupV1SuccessFlow();

    const handler = withOpenHands({
      model: 'openai/qwen3-coder',
      prompt: 'Fix the CI',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    const createBody = JSON.parse(fetchCalls[0].init.body as string);
    expect(createBody.selected_model).toBe('openai/qwen3-coder');
  });

  it('sends working directory as initial_cwd in create body', async () => {
    setupV1SuccessFlow();

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
    setupV1SuccessFlow();

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

  // ── causedBy ──────────────────────────────────────────────

  it('sets causedBy in deposited signals', async () => {
    setupV1SuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].options.causedBy).toEqual(['sig_test_001']);
  });

  // ── Logging ───────────────────────────────────────────────

  it('logs conversation creation and completion', async () => {
    setupV1SuccessFlow('conv_log');

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
});
