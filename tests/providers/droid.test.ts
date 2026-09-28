// PURPOSE: Tests for withDroid provider (subprocess wrapper for Factory's droid exec)
// PURPOSE: Covers argv/env construction, BYOK settings, stream-json parsing, stop reasons, output mapping

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { Signal, ActionContext } from '../../src/core/types.js';
import type { DroidResult, DroidMessage } from '../../src/providers/droid.js';

// ── Controllable subprocess mock ────────────────────────────

let mockStdout: string[] = [];
let mockStderr = '';
let mockExitCode: number | null = 0;
let mockSpawnError: Error | null = null;
/** The --settings file as it existed while the subprocess ran. */
let settingsSeen: { path: string; content: any } | undefined;

vi.mock('node:child_process', () => ({
  spawn: vi.fn((_binary: string, args: string[]) => {
    const settingsIndex = args.indexOf('--settings');
    if (settingsIndex >= 0) {
      const path = args[settingsIndex + 1];
      settingsSeen = { path, content: JSON.parse(readFileSync(path, 'utf8')) };
    }

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

/** A representative `droid exec -o stream-json` run, as droid 0.228 emits it. */
function streamSession(overrides: { finalText?: string } = {}): string[] {
  const events = [
    { type: 'system', subtype: 'init', cwd: '/repo', session_id: 'sess_abc', tools: ['Read', 'LS'], model: 'custom:mandible-byok', reasoning_effort: 'none' },
    { type: 'message', role: 'user', id: 'm1', text: 'review', timestamp: 1, session_id: 'sess_abc' },
    { type: 'tool_call', id: 'call_1', messageId: 'm2', toolId: 'LS', toolName: 'LS', parameters: {}, timestamp: 2, session_id: 'sess_abc' },
    { type: 'tool_result', id: 'call_1', messageId: 'm3', toolId: 'LS', isError: false, value: 'src\n', timestamp: 3, session_id: 'sess_abc' },
    { type: 'message', role: 'assistant', id: 'm4', text: 'Looks fine.', timestamp: 4, session_id: 'sess_abc' },
    {
      type: 'completion',
      finalText: overrides.finalText ?? 'Looks fine.',
      numTurns: 2,
      durationMs: 358,
      session_id: 'sess_abc',
      timestamp: 5,
      usage: { input_tokens: 50, output_tokens: 8, cache_read_input_tokens: 4, cache_creation_input_tokens: 0, factory_credits: 0 },
    },
  ];
  return events.map((event) => JSON.stringify(event) + '\n');
}

/** What droid emits when the model endpoint is unreachable. */
function failedSession(): string[] {
  return [
    { type: 'system', subtype: 'init', session_id: 'sess_err', model: 'custom:mandible-byok' },
    { type: 'error', source: 'agent_loop', message: 'Connection error.', session_id: 'sess_err' },
    { type: 'error', source: 'cli', message: 'Exec failed', session_id: 'sess_err' },
  ].map((event) => JSON.stringify(event) + '\n');
}

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig_test_001',
    type: 'pr:needs-review',
    payload: { pr: 42 },
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

/** Get the most recent spawn call */
function lastSpawn(): { binary: string; args: string[]; options: any } {
  const calls = vi.mocked(spawn).mock.calls;
  const [binary, args, options] = calls[calls.length - 1] as [string, string[], any];
  return { binary, args, options };
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const GATEWAY_ENV = ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'MANDIBLE_MODEL_GROUPS', 'FACTORY_API_KEY'];

// ── Tests ───────────────────────────────────────────────────

describe('withDroid', () => {
  let withDroid: typeof import('../../src/providers/droid.js').withDroid;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    vi.mocked(spawn).mockClear();
    mockStdout = streamSession();
    mockStderr = '';
    mockExitCode = 0;
    mockSpawnError = null;
    settingsSeen = undefined;
    for (const name of GATEWAY_ENV) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    ({ withDroid } = await import('../../src/providers/droid.js'));
  });

  afterEach(() => {
    for (const name of GATEWAY_ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  describe('argv', () => {
    it('runs droid exec with stream-json, the resolved model, cwd and prompt last', async () => {
      const handler = withDroid({ prompt: 'Review this', workingDirectory: '/repo', model: 'opus' });
      await handler(makeSignal(), makeContext());

      const { binary, args, options } = lastSpawn();
      expect(binary).toBe('droid');
      expect(args[0]).toBe('exec');
      expect(flag(args, '--output-format')).toBe('stream-json');
      expect(flag(args, '--model')).toBe('claude-opus-5');
      expect(flag(args, '--cwd')).toBe('/repo');
      expect(options.cwd).toBe('/repo');
      expect(args.slice(-2)).toEqual(['--', 'Review this']);
    });

    it('builds prompt, working directory and model from the signal', async () => {
      const handler = withDroid({
        prompt: async (s) => `Review PR #${(s.payload as any).pr}`,
        workingDirectory: (s) => `/work/${(s.payload as any).pr}`,
        model: (s) => ((s.payload as any).pr > 10 ? 'fable' : 'haiku'),
      });
      await handler(makeSignal(), makeContext());

      const { args } = lastSpawn();
      expect(args[args.length - 1]).toBe('Review PR #42');
      expect(flag(args, '--cwd')).toBe('/work/42');
      expect(flag(args, '--model')).toBe('claude-fable-5-1');
    });

    it.each([
      ['read-only', [], []],
      ['low', ['--auto', 'low'], []],
      ['medium', ['--auto', 'medium'], []],
      ['high', ['--auto', 'high'], []],
      ['unsafe', ['--skip-permissions-unsafe'], ['--auto']],
    ] as const)('maps autonomy %s', async (autonomy, present, absent) => {
      await withDroid({ prompt: 'x', autonomy })(makeSignal(), makeContext());
      const { args } = lastSpawn();
      for (const part of present) expect(args).toContain(part);
      for (const part of absent) expect(args).not.toContain(part);
      if (autonomy === 'read-only') {
        expect(args).not.toContain('--auto');
        expect(args).not.toContain('--skip-permissions-unsafe');
      }
    });

    it("defaults autonomy to 'medium'", async () => {
      await withDroid({ prompt: 'x' })(makeSignal(), makeContext());
      expect(flag(lastSpawn().args, '--auto')).toBe('medium');
    });

    it('passes tool selection, reasoning, system prompt, spec mode and session', async () => {
      await withDroid({
        prompt: 'x',
        tools: { only: ['Read', 'LS'], add: ['MCP:github'], remove: ['Execute'] },
        reasoningEffort: 'high',
        appendSystemPrompt: 'Be terse.',
        spec: { model: 'opus', reasoningEffort: 'low' },
        sessionId: (s) => `sess_${(s.payload as any).pr}`,
      })(makeSignal(), makeContext());

      const { args } = lastSpawn();
      expect(flag(args, '--only-tools')).toBe('Read,LS');
      expect(flag(args, '--add-tools')).toBe('MCP:github');
      expect(flag(args, '--remove-tools')).toBe('Execute');
      expect(flag(args, '--reasoning-effort')).toBe('high');
      expect(flag(args, '--append-system-prompt')).toBe('Be terse.');
      expect(args).toContain('--use-spec');
      expect(flag(args, '--spec-model')).toBe('claude-opus-5');
      expect(flag(args, '--spec-reasoning-effort')).toBe('low');
      expect(flag(args, '--session-id')).toBe('sess_42');
    });

    it('keeps a prompt that starts with a dash out of flag parsing', async () => {
      await withDroid({ prompt: '--skip-permissions-unsafe' })(makeSignal(), makeContext());
      const { args } = lastSpawn();
      expect(args.slice(-2)).toEqual(['--', '--skip-permissions-unsafe']);
    });
  });

  describe('Factory-hosted models', () => {
    it('writes no settings file, stays online, and passes the Factory key', async () => {
      await withDroid({ prompt: 'x', apiKey: 'fk-test' })(makeSignal(), makeContext());

      const { args, options } = lastSpawn();
      expect(args).not.toContain('--settings');
      expect(settingsSeen).toBeUndefined();
      expect(options.env.FACTORY_API_KEY).toBe('fk-test');
      expect(options.env.FACTORY_AIRGAP_ENABLED).toBeUndefined();
      expect(options.env.FACTORY_DROID_AUTO_UPDATE_ENABLED).toBe('0');
    });

    it('refuses airgap without a BYOK model', async () => {
      const handler = withDroid({ prompt: 'x', airgap: true });
      await expect(handler(makeSignal(), makeContext())).rejects.toThrow(/airgap/);
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe('BYOK', () => {
    it('writes a custom model into a per-run settings file and selects it', async () => {
      await withDroid({
        prompt: 'x',
        model: 'local',
        byok: {
          provider: 'generic-chat-completion-api',
          baseUrl: 'http://localhost:8001/v1',
          apiKey: 'sekrit',
          headers: { 'X-Colony': 'reviewers' },
          maxOutputTokens: 4096,
        },
      })(makeSignal(), makeContext());

      const { args, options } = lastSpawn();
      expect(flag(args, '--model')).toBe('custom:mandible-byok');
      expect(settingsSeen?.content.customModels).toEqual([{
        id: 'custom:mandible-byok',
        displayName: 'mandible-byok',
        model: 'nemotron',
        provider: 'generic-chat-completion-api',
        baseUrl: 'http://localhost:8001/v1',
        apiKey: '${MANDIBLE_DROID_BYOK_KEY}',
        extraHeaders: { 'X-Colony': 'reviewers' },
        maxOutputTokens: 4096,
      }]);
      expect(options.env.MANDIBLE_DROID_BYOK_KEY).toBe('sekrit');
      expect(options.env.FACTORY_AIRGAP_ENABLED).toBe('1');
    });

    it('never writes the endpoint key to disk', async () => {
      await withDroid({
        prompt: 'x',
        byok: { provider: 'anthropic', baseUrl: 'https://proxy.internal', apiKey: 'sekrit' },
      })(makeSignal(), makeContext());

      expect(JSON.stringify(settingsSeen?.content)).not.toContain('sekrit');
    });

    it('removes the settings file once the run ends', async () => {
      await withDroid({
        prompt: 'x',
        byok: { provider: 'openai', baseUrl: 'https://api.example/v1' },
      })(makeSignal(), makeContext());

      expect(settingsSeen).toBeDefined();
      expect(existsSync(settingsSeen!.path)).toBe(false);
    });

    it('omits apiKey for a keyless endpoint', async () => {
      await withDroid({
        prompt: 'x',
        byok: { provider: 'generic-chat-completion-api', baseUrl: 'http://localhost:8001/v1' },
      })(makeSignal(), makeContext());

      expect(settingsSeen?.content.customModels[0]).not.toHaveProperty('apiKey');
      expect(lastSpawn().options.env.MANDIBLE_DROID_BYOK_KEY).toBeUndefined();
    });

    it('lets the BYOK model id override the model option', async () => {
      await withDroid({
        prompt: 'x',
        model: 'opus',
        byok: { provider: 'anthropic', baseUrl: 'https://proxy.internal', model: 'haiku' },
      })(makeSignal(), makeContext());

      expect(settingsSeen?.content.customModels[0].model).toBe('claude-haiku-4-5');
    });

    it('merges extra runtime settings and keeps caller custom models', async () => {
      await withDroid({
        prompt: 'x',
        settings: { customModels: [{ model: 'other', provider: 'openai' }], autoUpdateEnabled: false },
        byok: { provider: 'openai', baseUrl: 'https://api.example/v1' },
      })(makeSignal(), makeContext());

      expect(settingsSeen?.content.autoUpdateEnabled).toBe(false);
      expect(settingsSeen?.content.customModels.map((m: any) => m.model)).toEqual(['other', 'claude-sonnet-5']);
    });

    it('can stay online when airgap is turned off', async () => {
      await withDroid({
        prompt: 'x',
        airgap: false,
        byok: { provider: 'openai', baseUrl: 'https://api.example/v1' },
      })(makeSignal(), makeContext());

      expect(lastSpawn().options.env.FACTORY_AIRGAP_ENABLED).toBeUndefined();
    });
  });

  describe('model gateway', () => {
    it('routes through the zone gateway by default and resolves the model group', async () => {
      process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4000/v1';
      process.env.OPENAI_API_KEY = 'zone-key';
      process.env.MANDIBLE_MODEL_GROUPS = 'nemotron,proj_x/claude-sonnet-5';

      await withDroid({ prompt: 'x' })(makeSignal(), makeContext());

      const { args, options } = lastSpawn();
      expect(flag(args, '--model')).toBe('custom:mandible-byok');
      expect(settingsSeen?.content.customModels[0]).toMatchObject({
        provider: 'generic-chat-completion-api',
        baseUrl: 'http://127.0.0.1:4000/v1',
        model: 'proj_x/claude-sonnet-5',
        apiKey: '${MANDIBLE_DROID_BYOK_KEY}',
      });
      expect(options.env.MANDIBLE_DROID_BYOK_KEY).toBe('zone-key');
      expect(options.env.FACTORY_AIRGAP_ENABLED).toBe('1');
    });

    it('opts out of the gateway with byok: false', async () => {
      process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4000/v1';
      process.env.OPENAI_API_KEY = 'zone-key';

      await withDroid({ prompt: 'x', byok: false })(makeSignal(), makeContext());

      const { args } = lastSpawn();
      expect(flag(args, '--model')).toBe('claude-sonnet-5');
      expect(args).not.toContain('--settings');
    });

    it("fails fast when 'gateway' is requested outside a zone", async () => {
      const handler = withDroid({ prompt: 'x', byok: 'gateway' });
      await expect(handler(makeSignal(), makeContext())).rejects.toThrow(/model gateway/);
    });
  });

  describe('result parsing', () => {
    it('extracts final text, session, model, usage and tool calls from the stream', async () => {
      const ctx = makeContext();
      await withDroid({ prompt: 'x' })(makeSignal(), ctx);

      const result: DroidResult = ctx.deposits[0].payload;
      expect(result.success).toBe(true);
      expect(result.stopReason).toBe('success');
      expect(result.text).toBe('Looks fine.');
      expect(result.sessionId).toBe('sess_abc');
      expect(result.model).toBe('custom:mandible-byok');
      expect(result.numTurns).toBe(2);
      expect(result.toolCalls).toBe(1);
      expect(result.usage).toEqual({
        input_tokens: 50,
        output_tokens: 8,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
        factory_credits: 0,
      });
      expect(result.messages).toHaveLength(6);
    });

    it('reassembles events split across stdout chunks', async () => {
      const whole = streamSession().join('');
      mockStdout = [whole.slice(0, 37), whole.slice(37, 400), whole.slice(400)];

      const messages: DroidMessage[] = [];
      const ctx = makeContext();
      await withDroid({ prompt: 'x', onMessage: (m) => messages.push(m) })(makeSignal(), ctx);

      expect(messages.map((m) => m.type)).toEqual([
        'system', 'message', 'tool_call', 'tool_result', 'message', 'completion',
      ]);
      expect(ctx.deposits[0].payload.text).toBe('Looks fine.');
    });

    it('reports the root error when the run fails', async () => {
      mockStdout = failedSession();
      mockExitCode = 1;
      const ctx = makeContext();
      await withDroid({ prompt: 'x' })(makeSignal(), ctx);

      const result: DroidResult = ctx.deposits[0].payload;
      expect(result.success).toBe(false);
      expect(result.stopReason).toBe('error');
      expect(result.text).toBe('Connection error.');
      expect(result.errors).toEqual(['Connection error.', 'Exec failed']);
      expect(ctx.logs.some((l) => l.includes('Connection error.'))).toBe(true);
    });

    it('treats a clean exit without a completion event as an error', async () => {
      mockStdout = ['not json\n'];
      const ctx = makeContext();
      await withDroid({ prompt: 'x' })(makeSignal(), ctx);

      const result: DroidResult = ctx.deposits[0].payload;
      expect(result.stopReason).toBe('error');
      expect(result.text).toBe('not json');
    });

    it('reports interrupts', async () => {
      mockStdout = [];
      mockExitCode = 130;
      const ctx = makeContext();
      await withDroid({ prompt: 'x' })(makeSignal(), ctx);
      expect(ctx.deposits[0].payload.stopReason).toBe('interrupted');
    });

    it('explains how to install droid when the binary is missing', async () => {
      mockSpawnError = new Error('spawn droid ENOENT');
      const ctx = makeContext();
      await withDroid({ prompt: 'x' })(makeSignal(), ctx);

      const result: DroidResult = ctx.deposits[0].payload;
      expect(result.stopReason).toBe('spawn-failed');
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain('npm install -g @factory/cli');
    });
  });

  describe('environment and deposits', () => {
    it('passes binary, factory home and extra env through', async () => {
      await withDroid({
        prompt: 'x',
        binary: '/opt/droid',
        factoryHome: '/var/droid-home',
        env: { FACTORY_OTEL_ENABLED: '1' },
      })(makeSignal(), makeContext());

      const { binary, options } = lastSpawn();
      expect(binary).toBe('/opt/droid');
      expect(options.env.FACTORY_HOME_OVERRIDE).toBe('/var/droid-home');
      expect(options.env.FACTORY_OTEL_ENABLED).toBe('1');
    });

    it("deposits 'droid:completed' and withdraws the trigger by default", async () => {
      const ctx = makeContext();
      await withDroid({ prompt: 'x' })(makeSignal(), ctx);

      expect(ctx.deposits).toHaveLength(1);
      expect(ctx.deposits[0].type).toBe('droid:completed');
      expect(ctx.deposits[0].options.causedBy).toEqual(['sig_test_001']);
      expect(ctx.withdrawals).toEqual(['sig_test_001']);
    });

    it('maps the result through an output function', async () => {
      const ctx = makeContext();
      await withDroid({
        prompt: 'x',
        autoWithdraw: false,
        output: (result: any, signal) => ({
          type: result.success ? 'review:done' : 'review:failed',
          payload: { pr: (signal.payload as any).pr, review: result.text },
          tags: ['droid'],
        }),
      })(makeSignal(), ctx);

      expect(ctx.deposits[0]).toMatchObject({
        type: 'review:done',
        payload: { pr: 42, review: 'Looks fine.' },
        options: { tags: ['droid'] },
      });
      expect(ctx.withdrawals).toEqual([]);
    });

    it('maps the result through a static output', async () => {
      const ctx = makeContext();
      await withDroid({ prompt: 'x', output: { type: 'droid:ran', ttl: 60_000 } })(makeSignal(), ctx);

      expect(ctx.deposits[0].type).toBe('droid:ran');
      expect(ctx.deposits[0].payload.text).toBe('Looks fine.');
      expect(ctx.deposits[0].options.ttl).toBe(60_000);
    });
  });
});
