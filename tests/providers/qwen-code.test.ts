// PURPOSE: Tests for withQwenCode provider (subprocess wrapper for qwen-code CLI)
// PURPOSE: Covers subprocess spawning, env setup, timeout, output mapping, error handling

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import type { Signal, ActionContext } from '../../src/core/types.js';
import type { QwenCodeResult } from '../../src/providers/qwen-code.js';

// ── Mock child_process ──────────────────────────────────────

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const handlers: Record<string, Function> = {};
    const child = {
      stdout: {
        on: vi.fn((event: string, handler: Function) => {
          if (event === 'data') {
            setTimeout(() => handler(Buffer.from('qwen-code output')), 10);
          }
        }),
      },
      stderr: {
        on: vi.fn((event: string, handler: Function) => {
          if (event === 'data') {
            setTimeout(() => handler(Buffer.from('')), 10);
          }
        }),
      },
      on: vi.fn((event: string, handler: Function) => {
        handlers[event] = handler;
      }),
      kill: vi.fn(),
      killed: false,
    };
    // Simulate successful exit after a short delay
    setTimeout(() => {
      if (handlers['close']) handlers['close'](0);
    }, 50);
    return child;
  }),
}));

// ── Helpers ─────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig_test_001',
    type: 'ci:failed',
    payload: { pr: 42, logs: 'test failure' },
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

/** Get the most recent spawn call args */
function lastSpawnCall() {
  const calls = (spawn as any).mock.calls;
  return calls[calls.length - 1];
}

// ── Tests ───────────────────────────────────────────────────

describe('withQwenCode', () => {
  let withQwenCode: typeof import('../../src/providers/qwen-code.js').withQwenCode;

  beforeEach(async () => {
    (spawn as any).mockClear();
    const mod = await import('../../src/providers/qwen-code.js');
    withQwenCode = mod.withQwenCode;
  });

  it('spawns qwen-code with correct environment', async () => {
    const handler = withQwenCode({
      endpoint: 'http://localhost:8001',
      model: 'Qwen3-Coder-Next',
      prompt: 'Fix the build',
      workingDirectory: '/workspace',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const [binary, args, options] = lastSpawnCall();
    expect(binary).toBe('qwen-code');

    expect(args).toContain('-p');
    expect(args).toContain('Fix the build');
    expect(args).toContain('--model');
    expect(args).toContain('Qwen3-Coder-Next');
    expect(args).toContain('--max-turns');
    expect(args).toContain('20');

    expect(options.env.OPENAI_BASE_URL).toBe('http://localhost:8001/v1');
    expect(options.env.OPENAI_API_KEY).toBe('not-needed');
  });

  it('deposits result with qwen-code:completed type by default', async () => {
    const handler = withQwenCode({
      endpoint: 'http://localhost:8001',
      prompt: 'Fix it',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits).toHaveLength(1);
    expect(ctx.deposits[0].type).toBe('qwen-code:completed');
    const result = ctx.deposits[0].payload as QwenCodeResult;
    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(typeof result.durationMs).toBe('number');
  });

  it('uses custom output mapping', async () => {
    const handler = withQwenCode({
      endpoint: 'http://localhost:8001',
      prompt: 'Fix it',
      output: (result: QwenCodeResult) => ({
        type: result.success ? 'fix:applied' : 'fix:failed',
        payload: { summary: result.text } as any,
      }),
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].type).toBe('fix:applied');
  });

  it('auto-withdraws triggering signal', async () => {
    const handler = withQwenCode({
      endpoint: 'http://localhost:8001',
      prompt: 'Test',
    });

    const signal = makeSignal();
    const ctx = makeContext();
    await handler(signal, ctx);

    expect(ctx.withdrawals).toContain('sig_test_001');
  });

  it('skips withdrawal when autoWithdraw is false', async () => {
    const handler = withQwenCode({
      endpoint: 'http://localhost:8001',
      prompt: 'Test',
      autoWithdraw: false,
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.withdrawals).toHaveLength(0);
  });

  it('resolves prompt from function', async () => {
    const handler = withQwenCode({
      endpoint: 'http://localhost:8001',
      prompt: (signal) => `Fix PR #${(signal.payload as any).pr}`,
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const [, args] = lastSpawnCall();
    const promptIdx = args.indexOf('-p');
    expect(args[promptIdx + 1]).toBe('Fix PR #42');
  });

  it('passes API key through OPENAI_API_KEY env', async () => {
    const handler = withQwenCode({
      endpoint: 'http://localhost:8001',
      apiKey: 'my-key',
      prompt: 'Test',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const [,, options] = lastSpawnCall();
    expect(options.env.OPENAI_API_KEY).toBe('my-key');
  });

  it('passes extra env vars to subprocess', async () => {
    const handler = withQwenCode({
      endpoint: 'http://localhost:8001',
      prompt: 'Test',
      env: { MY_VAR: 'custom-value' },
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const [,, options] = lastSpawnCall();
    expect(options.env.MY_VAR).toBe('custom-value');
  });

  it('strips trailing slash from endpoint', async () => {
    const handler = withQwenCode({
      endpoint: 'http://localhost:8001/',
      prompt: 'Test',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const [,, options] = lastSpawnCall();
    expect(options.env.OPENAI_BASE_URL).toBe('http://localhost:8001/v1');
  });

  it('uses custom binary path', async () => {
    const handler = withQwenCode({
      endpoint: 'http://localhost:8001',
      prompt: 'Test',
      binary: '/opt/bin/qwen-code',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const [binary] = lastSpawnCall();
    expect(binary).toBe('/opt/bin/qwen-code');
  });

  it('includes allowed commands in args', async () => {
    const handler = withQwenCode({
      endpoint: 'http://localhost:8001',
      prompt: 'Test',
      allowedCommands: ['npm', 'git', 'go'],
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const [, args] = lastSpawnCall();
    expect(args).toContain('--allowed-commands');
    expect(args).toContain('npm,git,go');
  });

  it('sets causedBy on deposited signal', async () => {
    const handler = withQwenCode({
      endpoint: 'http://localhost:8001',
      prompt: 'Test',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].options.causedBy).toEqual(['sig_test_001']);
  });
});
