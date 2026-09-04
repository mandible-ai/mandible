// PURPOSE: Tests for withQwenCode provider (subprocess wrapper for the qwen CLI)
// PURPOSE: Covers arg/env construction, structured output parsing, stop reasons, output mapping

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import type { Signal, ActionContext } from '../../src/core/types.js';
import type { QwenCodeResult, QwenMessage } from '../../src/providers/qwen-code.js';

// ── Controllable subprocess mock ────────────────────────────

let mockStdout: string[] = [];
let mockStderr = '';
let mockExitCode: number | null = 0;
let mockSpawnError: Error | null = null;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const closeHandlers: Function[] = [];
    const errorHandlers: Function[] = [];

    const child = {
      stdout: {
        on: vi.fn((event: string, handler: Function) => {
          if (event !== 'data') return;
          setTimeout(() => {
            for (const chunk of mockStdout) handler(Buffer.from(chunk));
          }, 5);
        }),
      },
      stderr: {
        on: vi.fn((event: string, handler: Function) => {
          if (event !== 'data' || !mockStderr) return;
          setTimeout(() => handler(Buffer.from(mockStderr)), 5);
        }),
      },
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'close') closeHandlers.push(handler);
        if (event === 'error') errorHandlers.push(handler);
      }),
      kill: vi.fn(),
      killed: false,
    };

    setTimeout(() => {
      if (mockSpawnError) {
        for (const handler of errorHandlers) handler(mockSpawnError);
      } else {
        for (const handler of closeHandlers) handler(mockExitCode);
      }
    }, 20);

    return child;
  }),
}));

// ── Fixtures ────────────────────────────────────────────────

/** A representative `--output-format json` payload from the qwen CLI. */
function jsonSessionOutput(overrides: { result?: string; isError?: boolean } = {}): string {
  return JSON.stringify([
    {
      type: 'system',
      subtype: 'session_start',
      uuid: 'u1',
      session_id: 'sess_abc',
      model: 'Qwen3-Coder-Next',
    },
    {
      type: 'assistant',
      uuid: 'u2',
      session_id: 'sess_abc',
      message: {
        role: 'assistant',
        model: 'Qwen3-Coder-Next',
        content: [
          { type: 'text', text: 'Reading the failing test.' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
        ],
      },
    },
    {
      type: 'result',
      subtype: overrides.isError ? 'error_during_execution' : 'success',
      uuid: 'u3',
      session_id: 'sess_abc',
      is_error: overrides.isError ?? false,
      duration_ms: 1234,
      result: overrides.result ?? 'Fixed the null check in auth.ts.',
      usage: { input_tokens: 900, output_tokens: 120 },
    },
  ]);
}

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

/** Read the value following a flag in the spawned argv. */
function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx === -1 ? undefined : args[idx + 1];
}

// ── Tests ───────────────────────────────────────────────────

describe('withQwenCode', () => {
  let withQwenCode: typeof import('../../src/providers/qwen-code.js').withQwenCode;

  beforeEach(async () => {
    (spawn as any).mockClear();
    mockStdout = [jsonSessionOutput()];
    mockStderr = '';
    mockExitCode = 0;
    mockSpawnError = null;
    const mod = await import('../../src/providers/qwen-code.js');
    withQwenCode = mod.withQwenCode;
  });

  // ── CLI contract ──────────────────────────────────────────

  describe('CLI invocation', () => {
    it('spawns the `qwen` binary with headless flags', async () => {
      const handler = withQwenCode({
        endpoint: 'http://localhost:8001',
        model: 'Qwen3-Coder-Next',
        prompt: 'Fix the build',
        workingDirectory: '/workspace',
      });

      await handler(makeSignal(), makeContext());

      const [binary, args, options] = lastSpawnCall();
      expect(binary).toBe('qwen');
      expect(argValue(args, '-p')).toBe('Fix the build');
      expect(argValue(args, '--model')).toBe('Qwen3-Coder-Next');
      expect(argValue(args, '--output-format')).toBe('json');
      expect(argValue(args, '--max-session-turns')).toBe('20');
      expect(options.cwd).toBe('/workspace');
    });

    it('defaults to yolo approval so headless tool calls are not blocked', async () => {
      const handler = withQwenCode({ endpoint: 'http://localhost:8001', prompt: 'Fix it' });

      await handler(makeSignal(), makeContext());

      const [, args] = lastSpawnCall();
      expect(argValue(args, '--approval-mode')).toBe('yolo');
    });

    it('honours an explicit approval mode', async () => {
      const handler = withQwenCode({
        endpoint: 'http://localhost:8001',
        prompt: 'Review it',
        approvalMode: 'plan',
      });

      await handler(makeSignal(), makeContext());

      const [, args] = lastSpawnCall();
      expect(argValue(args, '--approval-mode')).toBe('plan');
    });

    it('emits run budget flags when configured', async () => {
      const handler = withQwenCode({
        endpoint: 'http://localhost:8001',
        prompt: 'Audit deps',
        maxSessionTurns: 30,
        maxToolCalls: 50,
        maxWallTime: '10m',
      });

      await handler(makeSignal(), makeContext());

      const [, args] = lastSpawnCall();
      expect(argValue(args, '--max-session-turns')).toBe('30');
      expect(argValue(args, '--max-tool-calls')).toBe('50');
      expect(argValue(args, '--max-wall-time')).toBe('10m');
    });

    it('omits budget flags that are not configured', async () => {
      const handler = withQwenCode({ endpoint: 'http://localhost:8001', prompt: 'Test' });

      await handler(makeSignal(), makeContext());

      const [, args] = lastSpawnCall();
      expect(args).not.toContain('--max-tool-calls');
      expect(args).not.toContain('--max-wall-time');
    });

    it('passes tool restrictions, directories, prompts and sandbox', async () => {
      const handler = withQwenCode({
        endpoint: 'http://localhost:8001',
        prompt: 'Test',
        excludeTools: ['shell', 'write'],
        includeDirectories: ['src', 'docs'],
        systemPrompt: 'You are a terse reviewer.',
        appendSystemPrompt: 'Focus on concrete findings.',
        sandbox: true,
      });

      await handler(makeSignal(), makeContext());

      const [, args] = lastSpawnCall();
      expect(argValue(args, '--exclude-tools')).toBe('shell,write');
      expect(argValue(args, '--include-directories')).toBe('src,docs');
      expect(argValue(args, '--system-prompt')).toBe('You are a terse reviewer.');
      expect(argValue(args, '--append-system-prompt')).toBe('Focus on concrete findings.');
      expect(args).toContain('--sandbox');
    });

    it('uses a custom binary path', async () => {
      const handler = withQwenCode({
        endpoint: 'http://localhost:8001',
        prompt: 'Test',
        binary: '/opt/bin/qwen',
      });

      await handler(makeSignal(), makeContext());

      expect(lastSpawnCall()[0]).toBe('/opt/bin/qwen');
    });

    it('resolves prompt and working directory from functions', async () => {
      const handler = withQwenCode({
        endpoint: 'http://localhost:8001',
        prompt: (signal) => `Fix PR #${(signal.payload as any).pr}`,
        workingDirectory: (signal) => `/repos/pr-${(signal.payload as any).pr}`,
      });

      await handler(makeSignal(), makeContext());

      const [, args, options] = lastSpawnCall();
      expect(argValue(args, '-p')).toBe('Fix PR #42');
      expect(options.cwd).toBe('/repos/pr-42');
    });
  });

  // ── Environment ───────────────────────────────────────────

  describe('environment', () => {
    it('points the CLI at the endpoint via OpenAI-compatible env vars', async () => {
      const handler = withQwenCode({
        endpoint: 'http://localhost:8001',
        model: 'Qwen3-Coder-Next',
        apiKey: 'my-key',
        prompt: 'Test',
      });

      await handler(makeSignal(), makeContext());

      const [, , options] = lastSpawnCall();
      expect(options.env.OPENAI_BASE_URL).toBe('http://localhost:8001/v1');
      expect(options.env.OPENAI_API_KEY).toBe('my-key');
      expect(options.env.OPENAI_MODEL).toBe('Qwen3-Coder-Next');
    });

    it('strips trailing slashes and does not double the /v1 suffix', async () => {
      const handler = withQwenCode({ endpoint: 'http://localhost:8001/v1/', prompt: 'Test' });

      await handler(makeSignal(), makeContext());

      expect(lastSpawnCall()[2].env.OPENAI_BASE_URL).toBe('http://localhost:8001/v1');
    });

    it('defaults the API key for keyless local servers', async () => {
      const handler = withQwenCode({ endpoint: 'http://localhost:8001', prompt: 'Test' });

      await handler(makeSignal(), makeContext());

      expect(lastSpawnCall()[2].env.OPENAI_API_KEY).toBe('not-needed');
    });

    it('opts into persistent retry only when requested', async () => {
      const off = withQwenCode({ endpoint: 'http://localhost:8001', prompt: 'Test' });
      await off(makeSignal(), makeContext());
      expect(lastSpawnCall()[2].env.QWEN_CODE_UNATTENDED_RETRY).toBeUndefined();

      const on = withQwenCode({
        endpoint: 'http://localhost:8001',
        prompt: 'Test',
        unattendedRetry: true,
      });
      await on(makeSignal(), makeContext());
      expect(lastSpawnCall()[2].env.QWEN_CODE_UNATTENDED_RETRY).toBe('1');
    });

    it('passes extra env vars to the subprocess', async () => {
      const handler = withQwenCode({
        endpoint: 'http://localhost:8001',
        prompt: 'Test',
        env: { MY_VAR: 'custom-value' },
      });

      await handler(makeSignal(), makeContext());

      expect(lastSpawnCall()[2].env.MY_VAR).toBe('custom-value');
    });
  });

  // ── Structured output parsing ─────────────────────────────

  describe('structured output', () => {
    it('parses the JSON session into a structured result', async () => {
      const handler = withQwenCode({ endpoint: 'http://localhost:8001', prompt: 'Fix it' });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const result = ctx.deposits[0].payload as QwenCodeResult;
      expect(result.text).toBe('Fixed the null check in auth.ts.');
      expect(result.sessionId).toBe('sess_abc');
      expect(result.model).toBe('Qwen3-Coder-Next');
      expect(result.usage).toEqual({ input_tokens: 900, output_tokens: 120 });
      expect(result.toolCalls).toBe(1);
      expect(result.isError).toBe(false);
      expect(result.messages).toHaveLength(3);
      expect(result.stopReason).toBe('success');
    });

    it('keeps raw stdout available alongside the parsed result', async () => {
      const handler = withQwenCode({ endpoint: 'http://localhost:8001', prompt: 'Fix it' });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const result = ctx.deposits[0].payload as QwenCodeResult;
      expect(result.stdout).toBe(jsonSessionOutput());
    });

    it('flags a result message that reports an error', async () => {
      mockStdout = [jsonSessionOutput({ isError: true, result: 'Could not apply the patch.' })];
      const handler = withQwenCode({ endpoint: 'http://localhost:8001', prompt: 'Fix it' });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const result = ctx.deposits[0].payload as QwenCodeResult;
      expect(result.isError).toBe(true);
      expect(result.success).toBe(false);
      expect(result.stopReason).toBe('error');
      expect(result.subtype).toBe('error_during_execution');
    });

    it('falls back to raw stdout when the payload is not parseable', async () => {
      mockStdout = ['not json at all'];
      const handler = withQwenCode({ endpoint: 'http://localhost:8001', prompt: 'Fix it' });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const result = ctx.deposits[0].payload as QwenCodeResult;
      expect(result.text).toBe('not json at all');
      expect(result.messages).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('skips parsing entirely in text mode', async () => {
      mockStdout = ['plain text answer'];
      const handler = withQwenCode({
        endpoint: 'http://localhost:8001',
        prompt: 'Fix it',
        outputFormat: 'text',
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const [, args] = lastSpawnCall();
      expect(argValue(args, '--output-format')).toBe('text');
      const result = ctx.deposits[0].payload as QwenCodeResult;
      expect(result.text).toBe('plain text answer');
      expect(result.messages).toEqual([]);
    });

    it('streams stream-json messages to onMessage across chunk boundaries', async () => {
      const lines = [
        '{"type":"system","subtype":"session_start","session_id":"sess_stream"}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
        '{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"input_tokens":5,"output_tokens":2}}',
      ];
      const whole = lines.join('\n') + '\n';
      // Split mid-message to prove the line buffer reassembles partial chunks.
      mockStdout = [whole.slice(0, 40), whole.slice(40, 150), whole.slice(150)];

      const seen: QwenMessage[] = [];
      const handler = withQwenCode({
        endpoint: 'http://localhost:8001',
        prompt: 'Fix it',
        outputFormat: 'stream-json',
        onMessage: (msg) => seen.push(msg),
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const [, args] = lastSpawnCall();
      expect(argValue(args, '--output-format')).toBe('stream-json');
      expect(seen.map((m) => m.type)).toEqual(['system', 'assistant', 'result']);

      const result = ctx.deposits[0].payload as QwenCodeResult;
      expect(result.sessionId).toBe('sess_stream');
      expect(result.text).toBe('done');
      expect(result.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
    });

    it('forwards raw stdout chunks to onOutput', async () => {
      const chunks: string[] = [];
      const handler = withQwenCode({
        endpoint: 'http://localhost:8001',
        prompt: 'Fix it',
        onOutput: (chunk) => chunks.push(chunk),
      });

      await handler(makeSignal(), makeContext());

      expect(chunks.join('')).toBe(jsonSessionOutput());
    });
  });

  // ── Stop reasons ──────────────────────────────────────────

  describe('stop reasons', () => {
    async function runWithExit(code: number | null): Promise<QwenCodeResult> {
      mockExitCode = code;
      mockStdout = ['{}'];
      const handler = withQwenCode({ endpoint: 'http://localhost:8001', prompt: 'Test' });
      const ctx = makeContext();
      await handler(makeSignal(), ctx);
      return ctx.deposits[0].payload as QwenCodeResult;
    }

    it('maps exit 53 to a turn-cap overrun', async () => {
      const result = await runWithExit(53);
      expect(result.stopReason).toBe('max-turns');
      expect(result.success).toBe(false);
    });

    it('maps exit 55 to a budget overrun', async () => {
      expect((await runWithExit(55)).stopReason).toBe('budget');
    });

    it('maps exit 130 to an interrupt', async () => {
      expect((await runWithExit(130)).stopReason).toBe('interrupted');
    });

    it('maps other non-zero exits to a generic error', async () => {
      expect((await runWithExit(1)).stopReason).toBe('error');
    });

    it('reports a spawn failure with install guidance', async () => {
      mockSpawnError = new Error('spawn qwen ENOENT');
      const handler = withQwenCode({ endpoint: 'http://localhost:8001', prompt: 'Test' });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const result = ctx.deposits[0].payload as QwenCodeResult;
      expect(result.stopReason).toBe('spawn-failed');
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain('@qwen-code/qwen-code');
    });

    it('reports a timeout when the subprocess overruns', async () => {
      mockExitCode = null;
      const handler = withQwenCode({
        endpoint: 'http://localhost:8001',
        prompt: 'Test',
        timeout: 1,
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      const result = ctx.deposits[0].payload as QwenCodeResult;
      expect(result.timedOut).toBe(true);
      expect(result.stopReason).toBe('timeout');
      expect(result.exitCode).toBe(124);
    });
  });

  // ── Signal wiring ─────────────────────────────────────────

  describe('signal wiring', () => {
    it('deposits qwen-code:completed by default', async () => {
      const handler = withQwenCode({ endpoint: 'http://localhost:8001', prompt: 'Fix it' });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      expect(ctx.deposits).toHaveLength(1);
      expect(ctx.deposits[0].type).toBe('qwen-code:completed');
      expect(ctx.deposits[0].options.causedBy).toEqual(['sig_test_001']);
    });

    it('uses a custom output mapping', async () => {
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
      expect(ctx.deposits[0].payload.summary).toBe('Fixed the null check in auth.ts.');
    });

    it('lets output mappings branch on the stop reason', async () => {
      mockExitCode = 55;
      const handler = withQwenCode({
        endpoint: 'http://localhost:8001',
        prompt: 'Fix it',
        output: (result: QwenCodeResult) => ({
          type: result.stopReason === 'budget' ? 'budget:exceeded' : 'fix:applied',
        }),
      });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

      expect(ctx.deposits[0].type).toBe('budget:exceeded');
    });

    it('auto-withdraws the triggering signal', async () => {
      const handler = withQwenCode({ endpoint: 'http://localhost:8001', prompt: 'Test' });

      const ctx = makeContext();
      await handler(makeSignal(), ctx);

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
  });
});