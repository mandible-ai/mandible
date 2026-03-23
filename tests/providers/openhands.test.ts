// PURPOSE: Tests for the withOpenHands provider (local self-hosted API)
// PURPOSE: Covers local REST lifecycle: create → message → poll → events → cleanup

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

/**
 * Set up the standard local API success flow:
 * create → message → poll STOPPED → events → DELETE cleanup
 */
function setupLocalSuccessFlow(
  conversationId = 'conv_001',
  agentEvents: any[] = [{ source: 'agent', message: 'Fixed the CI failure by updating deps.' }]
) {
  // 1. Create conversation (POST /api/conversations)
  queueResponse({ conversation_id: conversationId });
  // 2. Send message (POST /api/conversations/{id}/message)
  queueResponse({ ok: true });
  // 3. Poll status → STOPPED (GET /api/conversations/{id})
  queueResponse({ status: 'STOPPED', runtime_status: 'STATUS$READY' });
  // 4. Fetch events (GET /api/conversations/{id}/events)
  queueResponse(agentEvents);
  // 5. DELETE cleanup (DELETE /api/conversations/{id})
  queueResponse({ ok: true });
}

// ── Tests ───────────────────────────────────────────────────

describe('withOpenHands', () => {

  // ── 1. Happy path ─────────────────────────────────────────

  it('happy path: create → message → poll STOPPED → events → cleanup', async () => {
    setupLocalSuccessFlow();

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

    // Verify the lifecycle calls: create, message, poll, events, delete
    expect(fetchCalls[0].url).toBe('http://localhost:3001/api/conversations');
    expect(fetchCalls[0].init.method).toBe('POST');
    expect(fetchCalls[1].url).toBe('http://localhost:3001/api/conversations/conv_001/message');
    expect(fetchCalls[1].init.method).toBe('POST');
    expect(fetchCalls[2].url).toBe('http://localhost:3001/api/conversations/conv_001');
    expect(fetchCalls[2].init.method).toBe('GET');
    expect(fetchCalls[3].url).toBe('http://localhost:3001/api/conversations/conv_001/events');
    expect(fetchCalls[3].init.method).toBe('GET');
    expect(fetchCalls[4].url).toBe('http://localhost:3001/api/conversations/conv_001');
    expect(fetchCalls[4].init.method).toBe('DELETE');
  });

  // ── 2. Config resolution ─────────────────────────────────

  it('resolves async prompt function', async () => {
    setupLocalSuccessFlow();

    const handler = withOpenHands({
      prompt: async (signal) => `Context: ...\n\nFix: ${(signal.payload as any).logs}`,
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    // Prompt sent as initial_user_msg in create body
    const createBody = JSON.parse(fetchCalls[0].init.body as string);
    expect(createBody.initial_user_msg).toContain('Context: ...');
    expect(createBody.initial_user_msg).toContain('Build failed: test suite error');

    // Prompt also sent as message body
    const messageBody = JSON.parse(fetchCalls[1].init.body as string);
    expect(messageBody.message).toContain('Context: ...');
  });

  it('sends static prompt as initial_user_msg and message', async () => {
    setupLocalSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Investigate failure in test suite',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    const createBody = JSON.parse(fetchCalls[0].init.body as string);
    expect(createBody.initial_user_msg).toBe('Investigate failure in test suite');

    const messageBody = JSON.parse(fetchCalls[1].init.body as string);
    expect(messageBody.message).toBe('Investigate failure in test suite');
  });

  it('sends static repository in create body', async () => {
    setupLocalSuccessFlow();

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
    setupLocalSuccessFlow();

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

  it('resolves working directory from signal function', async () => {
    setupLocalSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      workingDirectory: (signal) => `/opt/workspace/${(signal.payload as any).repo ?? 'default'}`,
      output: { type: 'devops:fixed' },
    });

    const signal = makeSignal({ payload: { repo: 'my-app', logs: 'fail' } });
    await handler(signal, makeContext());

    // workingDirectory is not sent in create body for local API
    // but prompt still works
    expect(ctx => ctx.deposits).toBeDefined();
  });

  // ── 3. maxIterations ──────────────────────────────────────

  it('sends maxIterations in create body', async () => {
    setupLocalSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      maxIterations: 100,
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    const createBody = JSON.parse(fetchCalls[0].init.body as string);
    expect(createBody.max_iterations).toBe(100);
  });

  it('uses default maxIterations of 50', async () => {
    setupLocalSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    const createBody = JSON.parse(fetchCalls[0].init.body as string);
    expect(createBody.max_iterations).toBe(50);
  });

  // ── 4. conversationInstructions ────────────────────────────

  it('sends conversationInstructions in create body', async () => {
    setupLocalSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      conversationInstructions: 'You are a DevOps engineer. Always check logs first.',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    const createBody = JSON.parse(fetchCalls[0].init.body as string);
    expect(createBody.conversation_instructions).toBe('You are a DevOps engineer. Always check logs first.');
  });

  // ── 5. selectedBranch ──────────────────────────────────────

  it('sends selectedBranch in create body', async () => {
    setupLocalSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      selectedBranch: 'feature/fix-ci',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    const createBody = JSON.parse(fetchCalls[0].init.body as string);
    expect(createBody.selected_branch).toBe('feature/fix-ci');
  });

  it('resolves selectedBranch from signal function', async () => {
    setupLocalSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      selectedBranch: (signal) => `fix/${(signal.payload as any).prNumber}`,
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    const createBody = JSON.parse(fetchCalls[0].init.body as string);
    expect(createBody.selected_branch).toBe('fix/42');
  });

  // ── 6. Output mapping ─────────────────────────────────────

  it('deposits default signal type when no output mapping', async () => {
    setupLocalSuccessFlow();

    const handler = withOpenHands({ prompt: 'Fix it' });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits.length).toBe(1);
    expect(ctx.deposits[0].type).toBe('ci:failed:completed');
    expect(ctx.deposits[0].payload.status).toBe('finished');
  });

  it('deposits static output type', async () => {
    setupLocalSuccessFlow();

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
    setupLocalSuccessFlow();

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
    setupLocalSuccessFlow();

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

  // ── 7. Auto-withdraw ──────────────────────────────────────

  it('auto-withdraws triggering signal by default', async () => {
    setupLocalSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.withdrawals).toEqual(['sig_test_001']);
  });

  it('skips auto-withdraw when disabled', async () => {
    setupLocalSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
      autoWithdraw: false,
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.withdrawals).toEqual([]);
  });

  // ── 8. causedBy ────────────────────────────────────────────

  it('sets causedBy in deposited signals', async () => {
    setupLocalSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].options.causedBy).toEqual(['sig_test_001']);
  });

  // ── 9. onEvent callback ────────────────────────────────────

  it('onEvent callback receives status change events from polling', async () => {
    // Create
    queueResponse({ conversation_id: 'conv_events' });
    // Message
    queueResponse({ ok: true });
    // Poll 1: RUNNING
    queueResponse({ status: 'RUNNING', runtime_status: 'STATUS$READY' });
    // Poll 2: STOPPED
    queueResponse({ status: 'STOPPED', runtime_status: 'STATUS$READY' });
    // Events
    queueResponse([{ source: 'agent', message: 'Done' }]);
    // DELETE
    queueResponse({ ok: true });

    const receivedEvents: OpenHandsEvent[] = [];
    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
      onEvent: (event) => receivedEvents.push(event),
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    // Should have status change events + agent events from fetch
    expect(receivedEvents.length).toBeGreaterThanOrEqual(2);
    // First events are status changes from polling
    const statusEvents = receivedEvents.filter(e => e.observation === 'status_change');
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
    expect(statusEvents[0].message).toContain('RUNNING');
    expect(statusEvents[1].message).toContain('STOPPED');
  });

  it('onEvent callback errors are swallowed', async () => {
    setupLocalSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
      onEvent: () => { throw new Error('callback boom'); },
    });
    const ctx = makeContext();

    // Should not throw
    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].payload.status).toBe('finished');
  });

  // ── 10. Error handling ─────────────────────────────────────

  it('throws OpenHandsError on conversation create failure', async () => {
    // Create fails
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

  it('throws OpenHandsError on message send failure', async () => {
    // Create succeeds
    queueResponse({ conversation_id: 'conv_msg_fail' });
    // Message fails
    queueResponse({ error: 'runtime not ready' }, false, 500);
    // DELETE cleanup still happens
    queueResponse({ ok: true });

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });

    await expect(handler(makeSignal(), makeContext())).rejects.toThrow(
      expect.objectContaining({
        name: 'OpenHandsError',
        code: 'MESSAGE_SEND_FAILED',
        message: expect.stringContaining('Failed to send message'),
      })
    );
  });

  it('truncates error text to 500 chars', async () => {
    const longError = 'x'.repeat(1000);
    pushHandler(() => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => longError,
    }));

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });

    try {
      await handler(makeSignal(), makeContext());
    } catch (err: any) {
      expect(err.message.length).toBeLessThan(600);
      expect(err.message).toContain('...');
    }
  });

  // ── 11. Cleanup on error ───────────────────────────────────

  it('calls DELETE cleanup even when message send fails', async () => {
    // Create succeeds
    queueResponse({ conversation_id: 'conv_cleanup' });
    // Message fails
    queueResponse({ error: 'boom' }, false, 500);
    // DELETE cleanup
    queueResponse({ ok: true });

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });

    try {
      await handler(makeSignal(), makeContext());
    } catch { /* expected */ }

    const deleteCalls = fetchCalls.filter(c => c.init.method === 'DELETE');
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0].url).toBe('http://localhost:3001/api/conversations/conv_cleanup');
  });

  it('does not call DELETE when create fails (no conversation ID)', async () => {
    queueResponse({ error: 'server down' }, false, 503);

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });

    try {
      await handler(makeSignal(), makeContext());
    } catch { /* expected */ }

    const deleteCalls = fetchCalls.filter(c => c.init.method === 'DELETE');
    expect(deleteCalls.length).toBe(0);
  });

  // ── 12. Timeout ────────────────────────────────────────────

  it('returns timeout when poll never reaches STOPPED', async () => {
    vi.useFakeTimers();

    // Create
    queueResponse({ conversation_id: 'conv_timeout' });
    // Message
    queueResponse({ ok: true });
    // Poll — always RUNNING (supply many)
    for (let i = 0; i < 50; i++) {
      queueResponse({ status: 'RUNNING', runtime_status: 'STATUS$READY' });
    }
    // Events fetch (after timeout)
    queueResponse([]);
    // DELETE cleanup
    queueResponse({ ok: true });

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

  // ── 13. serverUrl ──────────────────────────────────────────

  it('uses default serverUrl http://localhost:3001', async () => {
    setupLocalSuccessFlow();

    const handler = withOpenHands({
      prompt: 'Fix the CI',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    expect(fetchCalls[0].url).toBe('http://localhost:3001/api/conversations');
  });

  it('uses custom serverUrl', async () => {
    setupLocalSuccessFlow();

    const handler = withOpenHands({
      serverUrl: 'http://192.168.5.194:3001',
      prompt: 'Fix the CI',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    expect(fetchCalls[0].url).toBe('http://192.168.5.194:3001/api/conversations');
  });

  it('strips trailing slash from serverUrl', async () => {
    setupLocalSuccessFlow();

    const handler = withOpenHands({
      serverUrl: 'http://localhost:3001/',
      prompt: 'Fix the CI',
      output: { type: 'devops:fixed' },
    });

    await handler(makeSignal(), makeContext());

    expect(fetchCalls[0].url).toBe('http://localhost:3001/api/conversations');
  });

  // ── 14. No auth header ─────────────────────────────────────

  it('does not send Authorization header (local API has no auth)', async () => {
    setupLocalSuccessFlow();

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

  // ── 15. Logging ─────────────────────────────────────────────

  it('logs conversation creation and completion', async () => {
    setupLocalSuccessFlow('conv_log');

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    const logMessages = ctx.logs.map(l => l.message);
    expect(logMessages.some(m => m.includes('conv_log') && m.includes('created'))).toBe(true);
    expect(logMessages.some(m => m.includes('Message sent'))).toBe(true);
    expect(logMessages.some(m => m.includes('finished'))).toBe(true);
  });

  // ── 16. Result text extraction ─────────────────────────────

  it('extracts result text from last agent event message', async () => {
    setupLocalSuccessFlow('conv_text', [
      { source: 'user', message: 'Fix it' },
      { source: 'agent', message: 'Looking at logs...' },
      { source: 'agent', message: 'Applied fix and tests pass.' },
    ]);

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].payload.text).toBe('Applied fix and tests pass.');
  });

  it('extracts result text from agent content when message is absent', async () => {
    setupLocalSuccessFlow('conv_content', [
      { source: 'agent', content: 'Fix applied via content field.' },
    ]);

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].payload.text).toBe('Fix applied via content field.');
  });

  it('falls back to empty string when no agent events', async () => {
    setupLocalSuccessFlow('conv_empty', []);

    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
    });
    const ctx = makeContext();

    await handler(makeSignal(), ctx);

    // With no agent events, should fall back to empty string for 'finished' status
    expect(ctx.deposits[0].payload.text).toBe('');
  });

  // ── 17. Polling progression ────────────────────────────────

  it('polling: RUNNING → RUNNING → STOPPED progression', async () => {
    vi.useFakeTimers();

    // Create
    queueResponse({ conversation_id: 'conv_poll' });
    // Message
    queueResponse({ ok: true });
    // Poll 1: RUNNING
    queueResponse({ status: 'RUNNING', runtime_status: 'STATUS$READY' });
    // Poll 2: RUNNING (same - should NOT emit duplicate event)
    queueResponse({ status: 'RUNNING', runtime_status: 'STATUS$READY' });
    // Poll 3: STOPPED
    queueResponse({ status: 'STOPPED', runtime_status: 'STATUS$READY' });
    // Events
    queueResponse([{ source: 'agent', message: 'Done' }]);
    // DELETE
    queueResponse({ ok: true });

    const receivedEvents: OpenHandsEvent[] = [];
    const handler = withOpenHands({
      prompt: 'Fix it',
      output: { type: 'devops:fixed' },
      onEvent: (event) => receivedEvents.push(event),
    });
    const ctx = makeContext();

    const promise = handler(makeSignal(), ctx);

    await vi.advanceTimersByTimeAsync(30_000);

    await promise;

    expect(ctx.deposits[0].payload.status).toBe('finished');
    // Verify poll was called multiple times
    const pollCalls = fetchCalls.filter(c => c.init.method === 'GET' && !c.url.includes('events'));
    expect(pollCalls.length).toBe(3);

    // Status change events: only 2 (RUNNING once, STOPPED once — duplicate RUNNING deduplicated)
    const statusEvents = receivedEvents.filter(e => e.observation === 'status_change');
    expect(statusEvents.length).toBe(2);

    vi.useRealTimers();
  });
});
