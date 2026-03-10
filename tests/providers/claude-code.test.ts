// PURPOSE: Tests for the withClaudeCode provider (Claude Code SDK integration)
// PURPOSE: Covers SDK consumption, prompt resolution, options passing, output mapping, error handling

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Signal, ActionContext } from '../../src/core/types.js';
import type { AgentResult } from '../../src/providers/types.js';

// ── Mock SDK ─────────────────────────────────────────────────

/** Creates a fake AsyncGenerator that yields messages then returns */
function createMockGenerator(messages: any[]): AsyncGenerator<any, void> {
  return (async function* () {
    for (const msg of messages) {
      yield msg;
    }
  })();
}

/** Standard success result message matching SDKResultMessage shape */
function makeResultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    result: 'Agent completed the task successfully.',
    is_error: false,
    duration_ms: 1500,
    total_cost_usd: 0.0042,
    num_turns: 3,
    usage: { input_tokens: 1000, output_tokens: 500 },
    ...overrides,
  };
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

describe('withClaudeCode', () => {
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockQuery = vi.fn();
    vi.resetModules();

    // Mock the SDK module
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: mockQuery,
    }));
  });

  async function loadWithClaudeCode() {
    const mod = await import('../../src/providers/claude-code.js');
    return mod.withClaudeCode;
  }

  it('consumes the AsyncGenerator and deposits the result', async () => {
    const resultMsg = makeResultMessage();
    mockQuery.mockReturnValue(createMockGenerator([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: 'Working...' } },
      resultMsg,
    ]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({
      prompt: 'Do the task',
      output: { type: 'task:completed' },
    });

    const signal = makeSignal();
    const ctx = makeContext();
    await handler(signal, ctx);

    // Verify SDK was called correctly
    expect(mockQuery).toHaveBeenCalledOnce();
    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.prompt).toBe('Do the task');
    expect(callArgs.options.model).toBe('claude-sonnet-4-5-20250929');
    expect(callArgs.options.permissionMode).toBe('bypassPermissions');
    expect(callArgs.options.allowDangerouslySkipPermissions).toBe(true);
    expect(callArgs.options.maxBudgetUsd).toBe(1.0);

    // Verify deposit
    expect(ctx.deposits).toHaveLength(1);
    expect(ctx.deposits[0].type).toBe('task:completed');
    expect(ctx.deposits[0].payload.text).toBe('Agent completed the task successfully.');
    expect(ctx.deposits[0].payload.costUsd).toBe(0.0042);
    expect(ctx.deposits[0].options.causedBy).toEqual(['sig_test_001']);

    // Verify withdrawal
    expect(ctx.withdrawals).toEqual(['sig_test_001']);
  });

  it('resolves prompt from a function', async () => {
    mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({
      prompt: (signal) => `Implement: ${(signal.payload as any).name}`,
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    expect(mockQuery.mock.calls[0][0].prompt).toBe('Implement: test-task');
  });

  it('resolves async prompt function', async () => {
    mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({
      prompt: async (signal) => `Async: ${(signal.payload as any).name}`,
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    expect(mockQuery.mock.calls[0][0].prompt).toBe('Async: test-task');
  });

  it('passes allowedTools and disallowedTools to SDK', async () => {
    mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({
      prompt: 'test',
      allowedTools: ['Read', 'Glob', 'Grep'],
      disallowedTools: ['Edit', 'Write'],
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    expect(opts.disallowedTools).toEqual(['Edit', 'Write']);
  });

  it('calls onMessage callback for each SDK message', async () => {
    const messages = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: 'Thinking...' } },
      makeResultMessage(),
    ];
    mockQuery.mockReturnValue(createMockGenerator(messages));

    const received: unknown[] = [];
    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({
      prompt: 'test',
      onMessage: (msg) => received.push(msg),
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    expect(received).toHaveLength(3);
    expect(received[0]).toEqual(messages[0]);
    expect(received[1]).toEqual(messages[1]);
    expect((received[2] as any).type).toBe('result');
  });

  it('onMessage callback errors do not crash the agent', async () => {
    mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({
      prompt: 'test',
      onMessage: () => { throw new Error('callback boom'); },
      output: { type: 'done' },
    });

    // Should not throw
    await handler(makeSignal(), makeContext());
  });

  it('uses custom output mapping function', async () => {
    mockQuery.mockReturnValue(createMockGenerator([
      makeResultMessage({ result: JSON.stringify({ issues: ['a', 'b'] }) }),
    ]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({
      prompt: 'scan',
      output: (result: AgentResult) => {
        const parsed = JSON.parse(result.text);
        return parsed.issues.map((issue: string) => ({
          type: 'issue:detected',
          payload: { title: issue },
        }));
      },
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits).toHaveLength(2);
    expect(ctx.deposits[0].type).toBe('issue:detected');
    expect(ctx.deposits[0].payload).toEqual({ title: 'a' });
    expect(ctx.deposits[1].type).toBe('issue:detected');
    expect(ctx.deposits[1].payload).toEqual({ title: 'b' });
  });

  it('deposits default {type}:completed when no output mapping', async () => {
    mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({ prompt: 'test' });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits).toHaveLength(1);
    expect(ctx.deposits[0].type).toBe('task:ready:completed');
  });

  it('skips withdrawal when autoWithdraw is false', async () => {
    mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({
      prompt: 'test',
      autoWithdraw: false,
      output: { type: 'done' },
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.withdrawals).toHaveLength(0);
  });

  it('wraps MODULE_NOT_FOUND errors with install instructions', async () => {
    // When the SDK import succeeds but query() throws a module-not-found
    // (can happen if the SDK itself has missing transitive deps)
    mockQuery.mockImplementation(() => {
      const err = new Error('Cannot find module something');
      (err as any).code = 'MODULE_NOT_FOUND';
      throw err;
    });

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({ prompt: 'test', output: { type: 'done' } });

    await expect(handler(makeSignal(), makeContext())).rejects.toThrow(
      'withClaudeCode requires @anthropic-ai/claude-agent-sdk'
    );
  });

  it('wraps ERR_MODULE_NOT_FOUND errors with install instructions', async () => {
    mockQuery.mockImplementation(() => {
      const err = new Error('Cannot find module something');
      (err as any).code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    });

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({ prompt: 'test', output: { type: 'done' } });

    await expect(handler(makeSignal(), makeContext())).rejects.toThrow(
      'withClaudeCode requires @anthropic-ai/claude-agent-sdk'
    );
  });

  it('passes custom model, maxTurns, env, and working directory', async () => {
    mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({
      prompt: 'test',
      model: 'claude-opus-4-6',
      maxTurns: 50,
      maxBudgetUsd: 0.5,
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      workingDirectory: '/tmp/workspace',
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts.model).toBe('claude-opus-4-6');
    expect(opts.maxTurns).toBe(50);
    expect(opts.maxBudgetUsd).toBe(0.5);
    expect(opts.env).toEqual({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(opts.cwd).toBe('/tmp/workspace');
  });

  it('resolves workingDirectory from a function', async () => {
    mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({
      prompt: 'test',
      workingDirectory: (signal) => `/workspace/${(signal.payload as any).name}`,
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    expect(mockQuery.mock.calls[0][0].options.cwd).toBe('/workspace/test-task');
  });

  it('passes custom systemPrompt to SDK', async () => {
    mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({
      prompt: 'test',
      systemPrompt: 'You are a scout agent.',
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    expect(mockQuery.mock.calls[0][0].options.systemPrompt).toBe('You are a scout agent.');
  });

  it('uses default system prompt when none provided', async () => {
    mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({ prompt: 'test', output: { type: 'done' } });

    await handler(makeSignal(), makeContext());

    const sysPrompt = mockQuery.mock.calls[0][0].options.systemPrompt;
    expect(sysPrompt).toContain('test-colony');
    expect(sysPrompt).toContain('Complete the task');
  });

  it('handles generator with no result message gracefully', async () => {
    mockQuery.mockReturnValue(createMockGenerator([
      { type: 'system', subtype: 'init' },
    ]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({ prompt: 'test', output: { type: 'done' } });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits).toHaveLength(1);
    expect(ctx.deposits[0].payload.text).toBe('');
    expect(ctx.deposits[0].payload.subtype).toBe('error_during_execution');
  });

  it('handles error result subtype', async () => {
    mockQuery.mockReturnValue(createMockGenerator([
      makeResultMessage({
        subtype: 'error_max_turns',
        result: undefined,
        errors: ['Max turns reached'],
        is_error: true,
      }),
    ]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({ prompt: 'test', output: { type: 'done' } });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].payload.text).toBe('Max turns reached');
    expect(ctx.deposits[0].payload.subtype).toBe('error_max_turns');
  });

  it('passes permissionMode acceptEdits correctly', async () => {
    mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({
      prompt: 'test',
      permissionMode: 'acceptEdits',
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts.permissionMode).toBe('acceptEdits');
    expect(opts.allowDangerouslySkipPermissions).toBe(false);
  });

  it('log line includes cost and duration', async () => {
    mockQuery.mockReturnValue(createMockGenerator([
      makeResultMessage({ total_cost_usd: 0.1234, duration_ms: 5000 }),
    ]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({ prompt: 'test', output: { type: 'done' } });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const logLine = ctx.logs.find(l => l.includes('Agent completed'));
    expect(logLine).toBeDefined();
    expect(logLine).toContain('$0.1234');
    expect(logLine).toContain('5000ms');
  });

  describe('apiBaseUrl', () => {
    it('sets ANTHROPIC_BASE_URL in SDK env', async () => {
      mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

      const withClaudeCode = await loadWithClaudeCode();
      const handler = withClaudeCode({
        prompt: 'test',
        apiBaseUrl: 'http://localhost:11434',
        output: { type: 'done' },
      });

      await handler(makeSignal(), makeContext());

      const opts = mockQuery.mock.calls[0][0].options;
      expect(opts.env.ANTHROPIC_BASE_URL).toBe('http://localhost:11434');
    });

    it('explicit env overrides apiBaseUrl', async () => {
      mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

      const withClaudeCode = await loadWithClaudeCode();
      const handler = withClaudeCode({
        prompt: 'test',
        apiBaseUrl: 'http://localhost:11434',
        env: { ANTHROPIC_BASE_URL: 'http://custom:8080' },
        output: { type: 'done' },
      });

      await handler(makeSignal(), makeContext());

      const opts = mockQuery.mock.calls[0][0].options;
      expect(opts.env.ANTHROPIC_BASE_URL).toBe('http://custom:8080');
    });

    it('merges with Bedrock env vars', async () => {
      mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

      const withClaudeCode = await loadWithClaudeCode();
      const handler = withClaudeCode({
        prompt: 'test',
        apiBaseUrl: 'http://localhost:11434',
        bedrock: { region: 'us-west-2' },
        output: { type: 'done' },
      });

      await handler(makeSignal(), makeContext());

      const opts = mockQuery.mock.calls[0][0].options;
      expect(opts.env.ANTHROPIC_BASE_URL).toBe('http://localhost:11434');
      expect(opts.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
      expect(opts.env.AWS_REGION).toBe('us-west-2');
    });

    it('does not set env when apiBaseUrl is absent', async () => {
      mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

      const withClaudeCode = await loadWithClaudeCode();
      const handler = withClaudeCode({
        prompt: 'test',
        output: { type: 'done' },
      });

      await handler(makeSignal(), makeContext());

      const opts = mockQuery.mock.calls[0][0].options;
      expect(opts.env).toBeUndefined();
    });
  });

  it('re-throws non-module errors from SDK', async () => {
    vi.resetModules();
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: () => { throw new Error('API key invalid'); },
    }));

    const { withClaudeCode } = await import('../../src/providers/claude-code.js');
    const handler = withClaudeCode({ prompt: 'test', output: { type: 'done' } });

    await expect(handler(makeSignal(), makeContext())).rejects.toThrow('API key invalid');
  });
});
