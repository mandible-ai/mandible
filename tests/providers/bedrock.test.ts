// PURPOSE: Tests for AWS Bedrock integration in withClaudeCode and withStructuredOutput providers.
// PURPOSE: Covers env var building, merging, guardrail headers, SDK error handling.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Signal, ActionContext } from '../../src/core/types.js';
import type { BedrockConfig } from '../../src/providers/types.js';

// ── Helpers ─────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig_bedrock_001',
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

function createMockGenerator(messages: any[]): AsyncGenerator<any, void> {
  return (async function* () {
    for (const msg of messages) {
      yield msg;
    }
  })();
}

function makeResultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    result: 'Done.',
    is_error: false,
    duration_ms: 1000,
    total_cost_usd: 0.01,
    num_turns: 1,
    usage: { input_tokens: 100, output_tokens: 50 },
    ...overrides,
  };
}

// ── buildBedrockEnv tests ───────────────────────────────────

describe('buildBedrockEnv', () => {
  let buildBedrockEnv: (config: BedrockConfig) => Record<string, string>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/providers/claude-code.js');
    buildBedrockEnv = mod.buildBedrockEnv;
  });

  it('produces required env vars from minimal config', () => {
    const env = buildBedrockEnv({ region: 'us-east-1' });

    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.AWS_REGION).toBe('us-east-1');
    expect(Object.keys(env)).toHaveLength(2);
  });

  it('includes model override as ANTHROPIC_MODEL', () => {
    const env = buildBedrockEnv({
      region: 'us-west-2',
      model: 'us.anthropic.claude-sonnet-4-6',
    });

    expect(env.ANTHROPIC_MODEL).toBe('us.anthropic.claude-sonnet-4-6');
  });

  it('includes explicit AWS credentials', () => {
    const env = buildBedrockEnv({
      region: 'eu-west-1',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret123',
      sessionToken: 'session456',
    });

    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIATEST');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('secret123');
    expect(env.AWS_SESSION_TOKEN).toBe('session456');
  });

  it('includes AWS profile', () => {
    const env = buildBedrockEnv({
      region: 'us-east-1',
      profile: 'my-sso-profile',
    });

    expect(env.AWS_PROFILE).toBe('my-sso-profile');
  });

  it('includes guardrail headers when configured', () => {
    const env = buildBedrockEnv({
      region: 'us-east-1',
      guardrailId: 'guard-123',
      guardrailVersion: '2',
    });

    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeDefined();
    const headers = JSON.parse(env.ANTHROPIC_CUSTOM_HEADERS);
    expect(headers['x-amzn-bedrock-guardrail-identifier']).toBe('guard-123');
    expect(headers['x-amzn-bedrock-guardrail-version']).toBe('2');
  });

  it('includes guardrail ID without version', () => {
    const env = buildBedrockEnv({
      region: 'us-east-1',
      guardrailId: 'guard-456',
    });

    const headers = JSON.parse(env.ANTHROPIC_CUSTOM_HEADERS);
    expect(headers['x-amzn-bedrock-guardrail-identifier']).toBe('guard-456');
    expect(headers['x-amzn-bedrock-guardrail-version']).toBeUndefined();
  });

  it('omits undefined optional fields', () => {
    const env = buildBedrockEnv({ region: 'us-east-1' });

    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });
});

// ── withClaudeCode Bedrock integration ──────────────────────

describe('withClaudeCode + Bedrock', () => {
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockQuery = vi.fn();
    vi.resetModules();

    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: mockQuery,
    }));
  });

  async function loadWithClaudeCode() {
    const mod = await import('../../src/providers/claude-code.js');
    return mod.withClaudeCode;
  }

  it('passes Bedrock env vars to SDK queryOptions.env', async () => {
    mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({
      prompt: 'test',
      bedrock: { region: 'us-east-1' },
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(opts.env.AWS_REGION).toBe('us-east-1');
  });

  it('merges Bedrock env with user-provided env (user takes precedence)', async () => {
    mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({
      prompt: 'test',
      bedrock: { region: 'us-east-1', model: 'default-model' },
      env: { AWS_REGION: 'eu-west-1', CUSTOM_VAR: 'hello' },
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    const opts = mockQuery.mock.calls[0][0].options;
    // User-provided AWS_REGION should override Bedrock config
    expect(opts.env.AWS_REGION).toBe('eu-west-1');
    expect(opts.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(opts.env.ANTHROPIC_MODEL).toBe('default-model');
    expect(opts.env.CUSTOM_VAR).toBe('hello');
  });

  it('includes full Bedrock config with guardrails', async () => {
    mockQuery.mockReturnValue(createMockGenerator([makeResultMessage()]));

    const withClaudeCode = await loadWithClaudeCode();
    const handler = withClaudeCode({
      prompt: 'test',
      bedrock: {
        region: 'us-west-2',
        model: 'us.anthropic.claude-sonnet-4-6',
        accessKeyId: 'AKIA123',
        secretAccessKey: 'secret',
        guardrailId: 'guard-1',
        guardrailVersion: '3',
      },
      output: { type: 'done' },
    });

    await handler(makeSignal(), makeContext());

    const env = mockQuery.mock.calls[0][0].options.env;
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.AWS_REGION).toBe('us-west-2');
    expect(env.ANTHROPIC_MODEL).toBe('us.anthropic.claude-sonnet-4-6');
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA123');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('secret');

    const headers = JSON.parse(env.ANTHROPIC_CUSTOM_HEADERS);
    expect(headers['x-amzn-bedrock-guardrail-identifier']).toBe('guard-1');
    expect(headers['x-amzn-bedrock-guardrail-version']).toBe('3');
  });

  it('does not set env when no bedrock config and no user env', async () => {
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

// ── withStructuredOutput Bedrock integration ────────────────

describe('withStructuredOutput + Bedrock', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('routes to callBedrock when provider is bedrock', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"approved": true}' }],
    });

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
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(mockCreate).toHaveBeenCalledOnce();
    expect(ctx.deposits).toHaveLength(1);
    expect(ctx.deposits[0].type).toBe('review:done');
    expect(ctx.deposits[0].payload).toEqual({ approved: true });
  });

  it('passes Bedrock model override to the SDK', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"ok": true}' }],
    });

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
      bedrockConfig: {
        region: 'us-west-2',
        model: 'us.anthropic.claude-sonnet-4-6',
      },
      prompt: 'test',
      route: 'done',
    });

    await handler(makeSignal(), makeContext());

    // The Bedrock model override should be used instead of the top-level model
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('us.anthropic.claude-sonnet-4-6');
  });

  it('throws helpful error when bedrock SDK is not installed', async () => {
    // Mock the SDK to simulate MODULE_NOT_FOUND at import time
    vi.doMock('@anthropic-ai/bedrock-sdk', () => {
      // Return a module whose default export throws MODULE_NOT_FOUND when used
      return {
        default: new Proxy(function() {}, {
          construct() {
            const err = new Error('Cannot find module @anthropic-ai/bedrock-sdk');
            (err as any).code = 'ERR_MODULE_NOT_FOUND';
            throw err;
          },
        }),
      };
    });

    const { withStructuredOutput } = await import('../../src/providers/structured-output.js');
    const handler = withStructuredOutput({
      model: 'claude-sonnet-4-5-20250929',
      provider: 'bedrock',
      bedrockConfig: { region: 'us-east-1' },
      prompt: 'test',
      route: 'done',
    });

    await expect(handler(makeSignal(), makeContext())).rejects.toThrow(
      'Bedrock provider requires @anthropic-ai/bedrock-sdk'
    );
  });

  it('throws when bedrock provider is used without bedrockConfig', async () => {
    vi.doMock('@anthropic-ai/bedrock-sdk', () => ({
      default: class AnthropicBedrock {},
    }));

    const { withStructuredOutput } = await import('../../src/providers/structured-output.js');
    const handler = withStructuredOutput({
      model: 'claude-sonnet-4-5-20250929',
      provider: 'bedrock',
      // bedrockConfig intentionally omitted
      prompt: 'test',
      route: 'done',
    });

    await expect(handler(makeSignal(), makeContext())).rejects.toThrow(
      'bedrockConfig'
    );
  });

  it('passes AWS credentials to AnthropicBedrock client', async () => {
    let capturedOpts: any;
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{}' }],
    });

    vi.doMock('@anthropic-ai/bedrock-sdk', () => ({
      default: class AnthropicBedrock {
        messages = { create: mockCreate };
        constructor(opts: any) { capturedOpts = opts; }
      },
    }));

    const { withStructuredOutput } = await import('../../src/providers/structured-output.js');
    const handler = withStructuredOutput({
      model: 'claude-sonnet-4-5-20250929',
      provider: 'bedrock',
      bedrockConfig: {
        region: 'us-east-1',
        accessKeyId: 'AKIATEST',
        secretAccessKey: 'secret123',
        sessionToken: 'tok456',
        profile: 'dev',
      },
      prompt: 'test',
      route: 'done',
    });

    await handler(makeSignal(), makeContext());

    expect(capturedOpts.awsRegion).toBe('us-east-1');
    expect(capturedOpts.awsAccessKey).toBe('AKIATEST');
    expect(capturedOpts.awsSecretKey).toBe('secret123');
    expect(capturedOpts.awsSessionToken).toBe('tok456');
    expect(capturedOpts.awsProfile).toBe('dev');
  });
});
