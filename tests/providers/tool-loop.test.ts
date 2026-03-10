// PURPOSE: Tests for withToolLoop provider (native tool-calling loop against vLLM)
// PURPOSE: Covers turn loop, tool execution, token budget, max turns, error handling,
//          observability hooks, built-in tools

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  withToolLoop,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  bashTool,
  grepTool,
  globTool,
  listDirTool,
} from '../../src/providers/tool-loop.js';
import type { Signal, ActionContext } from '../../src/core/types.js';
import type { ToolDefinition, ToolLoopResult } from '../../src/providers/tool-loop.js';

// ── Mock fetch ──────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Helpers ─────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig_test_001',
    type: 'ci:failed',
    payload: { logs: 'Build failed: missing import' },
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

function mockModelsResponse(model = 'Qwen3-Coder-Next') {
  return new Response(
    JSON.stringify({ data: [{ id: model }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function mockChatResponse(content: string, toolCalls?: any[], usage?: any) {
  return new Response(
    JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
      }],
      usage: usage ?? { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function makeToolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

// Simple echo tool for testing
const echoTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'echo',
    description: 'Echo the input back.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: ['message'],
    },
  },
  execute: async (args) => `Echo: ${args.message}`,
};

// ── Core loop behavior ──────────────────────────────────────

describe('withToolLoop', () => {
  it('completes immediately when LLM returns no tool calls', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockChatResponse('All done, no tools needed.'));

    const handler = withToolLoop({
      endpoint: 'http://localhost:8001',
      tools: [echoTool],
      prompt: 'Fix the bug',
    });

    const signal = makeSignal();
    const ctx = makeContext();
    await handler(signal, ctx);

    // Should deposit a result
    expect(ctx.deposits).toHaveLength(1);
    expect(ctx.deposits[0].type).toBe('tool-loop:completed');
    const result = ctx.deposits[0].payload as ToolLoopResult;
    expect(result.text).toBe('All done, no tools needed.');
    expect(result.success).toBe(true);
    expect(result.stopReason).toBe('complete');
    expect(result.turns).toBe(1);
    expect(result.totalToolCalls).toBe(0);
  });

  it('executes tool calls and feeds results back', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      // Turn 1: LLM wants to call echo tool
      .mockResolvedValueOnce(mockChatResponse('Let me check...', [
        makeToolCall('call_1', 'echo', { message: 'hello' }),
      ]))
      // Turn 2: LLM gets tool result, responds with final answer
      .mockResolvedValueOnce(mockChatResponse('The echo returned: hello'));

    const handler = withToolLoop({
      endpoint: 'http://localhost:8001',
      tools: [echoTool],
      prompt: 'Test the echo',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const result = ctx.deposits[0].payload as ToolLoopResult;
    expect(result.success).toBe(true);
    expect(result.turns).toBe(2);
    expect(result.totalToolCalls).toBe(1);

    // Verify the tool result was sent back to vLLM
    const thirdCall = mockFetch.mock.calls[2]; // models, turn1, turn2
    const body = JSON.parse(thirdCall[1].body);
    // Should have: system(optional), user, assistant(with tool_calls), tool(result)
    const toolMsg = body.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toBe('Echo: hello');
    expect(toolMsg.tool_call_id).toBe('call_1');
  });

  it('handles unknown tool gracefully', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockChatResponse('', [
        makeToolCall('call_1', 'nonexistent_tool', {}),
      ]))
      .mockResolvedValueOnce(mockChatResponse('Oh, that tool does not exist.'));

    const handler = withToolLoop({
      endpoint: 'http://localhost:8001',
      tools: [echoTool],
      prompt: 'Test',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const result = ctx.deposits[0].payload as ToolLoopResult;
    expect(result.toolErrors).toHaveLength(1);
    expect(result.toolErrors[0].tool).toBe('nonexistent_tool');
  });

  it('stops at max turns', async () => {
    // Always returns a tool call — should hit max turns
    // Use mockImplementation so each call creates a fresh Response (body can only be read once)
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockImplementation(() => Promise.resolve(mockChatResponse('Still working...', [
        makeToolCall('call_n', 'echo', { message: 'loop' }),
      ])));

    const handler = withToolLoop({
      endpoint: 'http://localhost:8001',
      tools: [echoTool],
      prompt: 'Test',
      maxTurns: 3,
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const result = ctx.deposits[0].payload as ToolLoopResult;
    expect(result.stopReason).toBe('max_turns');
    expect(result.success).toBe(false);
    expect(result.turns).toBe(3);
  });

  it('stops when token budget is exhausted', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockChatResponse('Working...', [
        makeToolCall('c1', 'echo', { message: 'a' }),
      ], { prompt_tokens: 500, completion_tokens: 500, total_tokens: 1000 }))
      // This turn shouldn't happen — budget should be exhausted
      .mockResolvedValueOnce(mockChatResponse('Done'));

    const handler = withToolLoop({
      endpoint: 'http://localhost:8001',
      tools: [echoTool],
      prompt: 'Test',
      maxBudget: { tokens: 900 },
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const result = ctx.deposits[0].payload as ToolLoopResult;
    expect(result.stopReason).toBe('token_budget');
    expect(result.success).toBe(false);
  });

  it('uses custom output mapping', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockChatResponse('Fixed it!'));

    const handler = withToolLoop({
      endpoint: 'http://localhost:8001',
      tools: [echoTool],
      prompt: 'Fix the thing',
      output: (result: ToolLoopResult) => ({
        type: result.success ? 'fix:applied' : 'fix:failed',
        payload: { summary: result.text } as any,
      }),
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.deposits[0].type).toBe('fix:applied');
    expect(ctx.deposits[0].payload.summary).toBe('Fixed it!');
  });

  it('auto-withdraws triggering signal', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockChatResponse('Done'));

    const handler = withToolLoop({
      endpoint: 'http://localhost:8001',
      tools: [],
      prompt: 'Test',
    });

    const signal = makeSignal();
    const ctx = makeContext();
    await handler(signal, ctx);

    expect(ctx.withdrawals).toContain('sig_test_001');
  });

  it('skips withdrawal when autoWithdraw is false', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockChatResponse('Done'));

    const handler = withToolLoop({
      endpoint: 'http://localhost:8001',
      tools: [],
      prompt: 'Test',
      autoWithdraw: false,
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(ctx.withdrawals).toHaveLength(0);
  });

  it('resolves prompt from function', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockChatResponse('Done'));

    const handler = withToolLoop({
      endpoint: 'http://localhost:8001',
      tools: [],
      prompt: (signal) => `Fix: ${(signal.payload as any).logs}`,
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.messages[0].content).toBe('Fix: Build failed: missing import');
  });

  it('includes system prompt in messages', async () => {
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockChatResponse('Done'));

    const handler = withToolLoop({
      endpoint: 'http://localhost:8001',
      tools: [],
      prompt: 'Fix it',
      systemPrompt: 'You are a DevOps agent.',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a DevOps agent.' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Fix it' });
  });

  it('fires onToolCall hook', async () => {
    const toolCallEvents: any[] = [];

    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockChatResponse('', [
        makeToolCall('c1', 'echo', { message: 'test' }),
      ]))
      .mockResolvedValueOnce(mockChatResponse('Done'));

    const handler = withToolLoop({
      endpoint: 'http://localhost:8001',
      tools: [echoTool],
      prompt: 'Test',
      onToolCall: (event) => toolCallEvents.push(event),
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0].tool).toBe('echo');
    expect(toolCallEvents[0].result).toBe('Echo: test');
  });

  it('fires onTurn hook', async () => {
    const turnEvents: any[] = [];

    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockChatResponse('Done'));

    const handler = withToolLoop({
      endpoint: 'http://localhost:8001',
      tools: [],
      prompt: 'Test',
      onTurn: (event) => turnEvents.push(event),
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(turnEvents).toHaveLength(1);
    expect(turnEvents[0].turn).toBe(1);
    expect(turnEvents[0].hasMoreToolCalls).toBe(false);
  });

  it('sends API key as Bearer token', async () => {
    // When model is explicit, no /v1/models call — chat is the only fetch
    mockFetch
      .mockResolvedValueOnce(mockChatResponse('Done'));

    const handler = withToolLoop({
      endpoint: 'http://localhost:8001',
      apiKey: 'test-key',
      tools: [],
      prompt: 'Test',
      model: 'test-model',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    expect(mockFetch.mock.calls[0][1].headers['Authorization']).toBe('Bearer test-key');
  });
});

// ── Built-in tool definitions ───────────────────────────────

describe('built-in tools', () => {
  it('exports all expected tool definitions', () => {
    expect(fileReadTool.function.name).toBe('file_read');
    expect(fileWriteTool.function.name).toBe('file_write');
    expect(fileEditTool.function.name).toBe('file_edit');
    expect(bashTool.function.name).toBe('bash');
    expect(grepTool.function.name).toBe('grep');
    expect(globTool.function.name).toBe('glob');
    expect(listDirTool.function.name).toBe('list_dir');
  });

  it('all tools have type: function', () => {
    const allTools = [fileReadTool, fileWriteTool, fileEditTool, bashTool, grepTool, globTool, listDirTool];
    for (const tool of allTools) {
      expect(tool.type).toBe('function');
    }
  });

  it('all tools have execute functions', () => {
    const allTools = [fileReadTool, fileWriteTool, fileEditTool, bashTool, grepTool, globTool, listDirTool];
    for (const tool of allTools) {
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('all tools have required parameter schemas', () => {
    const allTools = [fileReadTool, fileWriteTool, fileEditTool, bashTool, grepTool, globTool, listDirTool];
    for (const tool of allTools) {
      expect(tool.function.parameters).toBeDefined();
      expect(tool.function.parameters.type).toBe('object');
    }
  });
});
