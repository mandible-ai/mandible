# Local Inference Providers

Run Mandible colonies entirely on local hardware with vLLM. No cloud APIs, no external dependencies — everything on localhost.

## Overview

Mandible ships three providers for local inference:

| Provider | Purpose | Use When |
|----------|---------|----------|
| `vllmProvider()` | Text generation via vLLM | Plug into `withLLM` for summaries, docs, prose |
| `vllmStructuredProvider()` | JSON-validated output via vLLM | Plug into `withStructuredOutput` for reviews, classifications |
| `withToolLoop()` | Agentic tool-calling loop via vLLM | Code investigation, multi-step fixes, file editing |
| `withQwenCode()` | Subprocess wrapper for qwen-code CLI | Quick agentic coding tasks via qwen-code binary |

All providers talk to a local vLLM server (OpenAI-compatible API) and work with any model vLLM supports — Qwen3-Coder-Next is the recommended default for coding tasks.

## Prerequisites

```bash
# vLLM running locally with a model loaded
vllm serve Qwen/Qwen3-Coder-Next --port 8001

# For withQwenCode only:
npm install -g qwen-code
```

## vllmProvider — Text Generation

Returns a `LLMCallFunction<string>` that plugs directly into `withLLM`.

```typescript
import { withLLM, vllmProvider } from '@mandible-ai/mandible/providers';

colony('docgen')
  .sense('artifact:merged', { unclaimed: true })
  .do('generate-docs', withLLM({
    model: 'Qwen3-Coder-Next',
    provider: vllmProvider({ endpoint: 'http://localhost:8001' }),
    format: 'markdown',
    prompt: (signal) => `Generate documentation for:\n${signal.payload.code}`,
    route: 'docs:generated',
  }))
  .build();
```

### Configuration

```typescript
import { vllmProvider, type VLLMConfig } from '@mandible-ai/mandible/providers';

const provider = vllmProvider({
  endpoint: 'http://localhost:8001',   // Required. vLLM server URL.
  model: 'Qwen3-Coder-Next',          // Optional. Auto-detects from /v1/models if omitted.
  apiKey: 'my-key',                    // Optional. Sent as Bearer token.
  maxRetries: 3,                       // Optional. Retries on 503/429. Default: 3.
  retryDelayMs: 1000,                  // Optional. Base retry delay. Default: 1000.
  healthCheckOnInit: true,             // Optional. Verify server on first call. Default: true.
  timeoutMs: 120_000,                  // Optional. Request timeout. Default: 120s.
  headers: { 'X-Custom': 'value' },    // Optional. Extra headers.
});
```

### Environment-based Factory

```typescript
import { vllmFromEnv } from '@mandible-ai/mandible/providers';

// Reads VLLM_ENDPOINT, VLLM_MODEL, VLLM_API_KEY from process.env
// Returns null if VLLM_ENDPOINT is not set
const provider = vllmFromEnv() ?? 'anthropic';  // graceful fallback
```

## vllmStructuredProvider — JSON Output

Returns a `LLMCallFunction<R>` with JSON mode enabled. Uses vLLM's guided decoding to guarantee valid JSON.

```typescript
import { withStructuredOutput, vllmStructuredProvider } from '@mandible-ai/mandible/providers';
import { z } from 'zod';

const reviewSchema = z.object({
  approved: z.boolean(),
  feedback: z.string(),
  severity: z.enum(['minor', 'major', 'blocking']),
});

colony('reviewer')
  .sense('pr:needs-review', { unclaimed: true })
  .do('review-code', withStructuredOutput({
    model: 'Qwen3-Coder-Next',
    provider: vllmStructuredProvider({ endpoint: 'http://localhost:8001' }),
    schema: reviewSchema,
    prompt: (signal) => `Review this PR diff:\n${signal.payload.diff}`,
    route: (result) => result.approved
      ? { type: 'review:approved', payload: result }
      : { type: 'review:changes-needed', payload: result },
  }))
  .concurrency(2)
  .claim('lease', 120_000)
  .build();
```

The structured provider also has an env-based factory:

```typescript
import { vllmStructuredFromEnv } from '@mandible-ai/mandible/providers';

const provider = vllmStructuredFromEnv<ReviewResult>();
```

## withToolLoop — Agentic Tool-Calling Loop

The heavyweight provider. Runs a ReAct loop: prompt → LLM → tool calls → execute → feed results back → repeat. Replaces `withClaudeCode` for local deployments.

```typescript
import {
  withToolLoop,
  fileReadTool,
  fileEditTool,
  bashTool,
  grepTool,
} from '@mandible-ai/mandible/providers';

colony('devops')
  .sense('ci:failed', { unclaimed: true })
  .do('investigate', withToolLoop({
    endpoint: 'http://localhost:8001',
    model: 'Qwen3-Coder-Next',
    systemPrompt: 'You are a DevOps engineer. Investigate CI failures and propose fixes.',
    tools: [fileReadTool, fileEditTool, bashTool, grepTool],
    maxTurns: 15,
    maxBudget: { tokens: 100_000 },
    workingDirectory: '/workspace/repo',
    prompt: (signal) => `CI failed for PR #${signal.payload.prNumber}.\nLogs:\n${signal.payload.logs}\n\nInvestigate and fix.`,
    output: (result) => ({
      type: result.success ? 'devops:fixed' : 'devops:investigated',
      payload: {
        summary: result.text,
        toolCalls: result.totalToolCalls,
        tokens: result.totalTokens,
      },
    }),
  }))
  .concurrency(1)
  .claim('lease', 300_000)
  .build();
```

### Configuration

```typescript
withToolLoop({
  endpoint: string;                // Required. vLLM server URL.
  model?: string;                  // Optional. Auto-detects if omitted.
  apiKey?: string;                 // Optional. Bearer token for vLLM.
  prompt: string | ((signal) => string | Promise<string>);  // Required.
  systemPrompt?: string;           // Optional. Agent role/constraints.
  tools: ToolDefinition[];         // Required. Available tools.
  maxTurns?: number;               // Optional. Default: 20.
  maxBudget?: { tokens: number };  // Optional. Token limit.
  timeoutMs?: number;              // Optional. Per-LLM-call timeout. Default: 120s.
  workingDirectory?: string | ((signal) => string);  // Optional.
  onToolCall?: (event) => void;    // Optional. Observability hook.
  onTurn?: (event) => void;        // Optional. Per-turn metrics.
  output?: OutputMapping;          // Optional. Signal deposit mapping.
  autoWithdraw?: boolean;          // Optional. Default: true.
})
```

### Built-in Tools

| Tool | Name | Description |
|------|------|-------------|
| `fileReadTool` | `file_read` | Read file contents |
| `fileWriteTool` | `file_write` | Write content to file (creates dirs) |
| `fileEditTool` | `file_edit` | Find-and-replace in a file |
| `bashTool` | `bash` | Execute shell commands |
| `globTool` | `glob` | Find files by pattern |
| `grepTool` | `grep` | Search file contents with regex |
| `listDirTool` | `list_dir` | List directory contents |

### Custom Tools

Define custom tools using the `ToolDefinition` interface:

```typescript
import type { ToolDefinition } from '@mandible-ai/mandible/providers';

const gitDiffTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'git_diff',
    description: 'Show the git diff for staged changes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional path filter.' },
      },
    },
  },
  execute: async (args, cwd) => {
    const { execSync } = require('node:child_process');
    const path = args.path ? ` -- ${args.path}` : '';
    return execSync(`git diff --staged${path}`, { cwd }).toString();
  },
};
```

### Result Object

```typescript
interface ToolLoopResult {
  text: string;           // Final assistant text
  success: boolean;       // true if loop completed normally
  stopReason: 'complete' | 'max_turns' | 'token_budget' | 'error';
  totalToolCalls: number;
  totalTokens: { input: number; output: number };
  durationMs: number;
  turns: number;
  toolErrors: Array<{ tool: string; error: string }>;
}
```

### Observability Hooks

```typescript
withToolLoop({
  // ...
  onToolCall: (event) => {
    console.log(`[${event.tool}] ${event.durationMs}ms`);
    metrics.toolCallsTotal.inc({ tool: event.tool });
  },
  onTurn: (event) => {
    console.log(`Turn ${event.turn}: ${event.toolCalls} tool calls, ${event.tokensUsed.output} output tokens`);
    metrics.tokensTotal.inc(event.tokensUsed.input + event.tokensUsed.output);
  },
})
```

## withQwenCode — qwen-code Subprocess

Wraps the [qwen-code](https://github.com/anthropics/qwen-code) terminal agent as a subprocess. Same pattern as `withClaudeCode` but for local inference. qwen-code handles its own tool execution internally.

```typescript
import { withQwenCode } from '@mandible-ai/mandible/providers';

colony('fixer')
  .sense('finding:critical', { unclaimed: true })
  .do('auto-fix', withQwenCode({
    endpoint: 'http://localhost:8001',
    model: 'Qwen3-Coder-Next',
    prompt: (signal) => `Fix this issue:\n${signal.payload.description}\n\nFile: ${signal.payload.file}`,
    workingDirectory: '/workspace/repo',
    maxTurns: 20,
    timeout: 600_000,  // 10 minutes
    allowedCommands: ['npm', 'git', 'go', 'make'],
    output: (result) => ({
      type: result.success ? 'fix:applied' : 'fix:failed',
      payload: { summary: result.text, exitCode: result.exitCode },
    }),
  }))
  .concurrency(1)
  .claim('lease', 600_000)
  .build();
```

### Configuration

```typescript
withQwenCode({
  endpoint: string;                // Required. vLLM URL → sets OPENAI_BASE_URL.
  model?: string;                  // Optional. Default: 'Qwen3-Coder-Next'.
  apiKey?: string;                 // Optional. Sets OPENAI_API_KEY.
  prompt: string | ((signal) => string | Promise<string>);  // Required.
  workingDirectory?: string | ((signal) => string);  // Optional.
  maxTurns?: number;               // Optional. Default: 20.
  timeout?: number;                // Optional. Session timeout in ms. Default: 600s.
  allowedCommands?: string[];      // Optional. Restrict shell commands.
  env?: Record<string, string>;    // Optional. Extra env vars for subprocess.
  binary?: string;                 // Optional. Path to qwen-code. Default: 'qwen-code'.
  output?: OutputMapping;          // Optional. Signal deposit mapping.
  autoWithdraw?: boolean;          // Optional. Default: true.
  onOutput?: (chunk: string) => void;  // Optional. Real-time output streaming.
})
```

### Result Object

```typescript
interface QwenCodeResult {
  text: string;       // stdout from qwen-code
  stderr: string;     // stderr output
  exitCode: number;   // 0 = success
  durationMs: number;
  success: boolean;
  timedOut: boolean;
}
```

### When to Use withQwenCode vs withToolLoop

| Factor | withQwenCode | withToolLoop |
|--------|-------------|-------------|
| Setup | Requires `qwen-code` binary installed | No external binary needed |
| Tool execution | qwen-code handles it internally | You control the tool implementations |
| Custom tools | Limited to qwen-code's built-in tools | Define any custom tools |
| Observability | stdout/stderr only | Per-tool-call and per-turn hooks |
| Token tracking | Not available (hidden inside qwen-code) | Full token counting |
| Speed to ship | Faster (thin subprocess wrapper) | More implementation work |
| Control | Less (black box subprocess) | Full control over the loop |

## Error Handling

All vLLM providers throw `VLLMError` with typed error codes:

```typescript
import { VLLMError, type VLLMErrorCode } from '@mandible-ai/mandible/providers';

try {
  await provider('prompt', {});
} catch (err) {
  if (err instanceof VLLMError) {
    switch (err.code) {
      case 'CONNECTION_FAILED':    // vLLM server unreachable
      case 'HEALTH_CHECK_FAILED':  // /v1/models returned non-200
      case 'NO_MODELS':            // No models loaded on vLLM
      case 'API_ERROR':            // vLLM returned an HTTP error
      case 'MAX_RETRIES_EXCEEDED': // All retries exhausted
      case 'PARSE_ERROR':          // Response format unexpected
      case 'JSON_PARSE_ERROR':     // JSON mode but response isn't valid JSON
    }
  }
}
```

## Full Example: Local SDLC Pipeline

```typescript
import { mandible } from '@mandible-ai/mandible';
import { ForgejoEnvironment } from '@mandible-ai/mandible/environments/forgejo';
import {
  withLLM,
  withStructuredOutput,
  withToolLoop,
  withBash,
  vllmProvider,
  vllmStructuredProvider,
  fileReadTool,
  fileEditTool,
  bashTool,
  grepTool,
} from '@mandible-ai/mandible/providers';

const VLLM = 'http://localhost:8001';

const env = new ForgejoEnvironment({
  endpoint: 'http://forgejo:3000',
  token: process.env.FORGEJO_TOKEN!,
  owner: 'golem',
  repo: 'work',
});

mandible('sdlc-local')
  .environment(env)

  // Review PRs with structured output
  .colony('reviewer', (c) => c
    .sense('pr:needs-review', { unclaimed: true })
    .do('review', withStructuredOutput({
      model: 'Qwen3-Coder-Next',
      provider: vllmStructuredProvider({ endpoint: VLLM }),
      schema: reviewSchema,
      prompt: (signal) => `Review:\n${signal.payload.diff}`,
      route: (r) => r.approved
        ? { type: 'review:approved', payload: r }
        : { type: 'review:changes-needed', payload: r },
    }))
    .concurrency(2)
    .claim('lease', 120_000)
  )

  // Investigate CI failures with tool loop
  .colony('devops', (c) => c
    .sense('ci:failed', { unclaimed: true })
    .do('investigate', withToolLoop({
      endpoint: VLLM,
      tools: [fileReadTool, fileEditTool, bashTool, grepTool],
      maxTurns: 15,
      workingDirectory: '/workspace',
      prompt: (signal) => `CI failed. Logs:\n${signal.payload.logs}`,
      output: (r) => ({ type: 'devops:investigated', payload: { summary: r.text } }),
    }))
    .concurrency(1)
    .claim('lease', 300_000)
  )

  // Generate docs
  .colony('docgen', (c) => c
    .sense('artifact:merged', { unclaimed: true, tags: ['needs-docs'] })
    .do('generate', withLLM({
      model: 'Qwen3-Coder-Next',
      provider: vllmProvider({ endpoint: VLLM }),
      format: 'markdown',
      prompt: (signal) => `Document:\n${signal.payload.code}`,
      route: 'docs:generated',
    }))
    .concurrency(1)
  )

  // Release (no LLM needed)
  .colony('release', (c) => c
    .sense('release:ready', { unclaimed: true })
    .do('tag-and-push', withBash({
      command: (signal) => `git tag v${signal.payload.version} && git push --tags`,
      output: { type: 'release:completed' },
    }))
  )

  .start();
```
