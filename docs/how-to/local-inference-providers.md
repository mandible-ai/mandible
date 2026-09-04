# Local Inference Providers

Run Mandible colonies entirely on local hardware with vLLM. No cloud model APIs are required, and inference stays on localhost.

## Overview

Mandible ships four providers for local inference:

| Provider | Purpose | Use When |
|----------|---------|----------|
| `vllmProvider()` | Text generation via vLLM | Plug into `withLLM` for summaries, docs, prose |
| `vllmStructuredProvider()` | JSON-validated output via vLLM | Plug into `withStructuredOutput` for reviews, classifications |
| `withToolLoop()` | Agentic tool-calling loop via vLLM | Code investigation, multi-step fixes, file editing |
| `withQwenCode()` | Subprocess wrapper for the qwen-code CLI | Agentic coding tasks via the `qwen` binary |

All providers talk to a local vLLM server (OpenAI-compatible API) and work with any model vLLM supports — Qwen3-Coder-Next is the recommended default for coding tasks.

## Prerequisites

```bash
# vLLM running locally with a model loaded
vllm serve Qwen/Qwen3-Coder-Next --port 8001

# For withQwenCode only:
npm install -g @qwen-code/qwen-code@latest
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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDefinition } from '@mandible-ai/mandible/providers';

const execFileAsync = promisify(execFile);

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
    const gitArgs = ['diff', '--staged'];
    if (typeof args.path === 'string') gitArgs.push('--', args.path);
    const { stdout } = await execFileAsync('git', gitArgs, { cwd });
    return stdout;
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

Wraps the [qwen-code](https://github.com/QwenLM/qwen-code) terminal agent as a subprocess. Same pattern as `withClaudeCode` but for local inference. qwen-code handles its own tool execution internally.

```typescript
import { withQwenCode } from '@mandible-ai/mandible/providers';

colony('fixer')
  .sense('finding:critical', { unclaimed: true })
  .do('auto-fix', withQwenCode({
    endpoint: 'http://localhost:8001',
    model: 'Qwen3-Coder-Next',
    prompt: (signal) => `Fix this issue:\n${signal.payload.description}\n\nFile: ${signal.payload.file}`,
    workingDirectory: '/workspace/repo',
    maxSessionTurns: 30,
    maxWallTime: '10m',
    maxToolCalls: 50,
    output: (result) => {
      if (result.stopReason === 'budget' || result.stopReason === 'max-turns') {
        return { type: 'fix:exhausted', payload: { summary: result.text } };
      }
      return {
        type: result.success ? 'fix:applied' : 'fix:failed',
        payload: { summary: result.text, toolCalls: result.toolCalls },
      };
    },
  }))
  .concurrency(1)
  .claim('lease', 600_000)
  .build();
```

### Approval mode

Headless runs still gate write/shell tools behind approval, and there is nobody
present to approve them — so the provider defaults to `approvalMode: 'yolo'`.
That auto-approves every tool call **without** a sandbox. On anything but an
ephemeral runner, bound it:

```typescript
withQwenCode({
  endpoint: 'http://localhost:8001',
  prompt: 'Audit dependencies for known CVEs',
  approvalMode: 'yolo',
  sandbox: true,                        // run tools in the CLI's sandbox image
  excludeTools: ['shell'],              // or take the dangerous tools away
  maxToolCalls: 25,
})
```

### Configuration

```typescript
withQwenCode({
  endpoint: string;                // Required. vLLM URL → OPENAI_BASE_URL (/v1 appended).
  model?: string;                  // Optional. Default: 'Qwen3-Coder-Next'.
  apiKey?: string;                 // Optional. Sets OPENAI_API_KEY.
  prompt: string | ((signal) => string | Promise<string>);  // Required.
  workingDirectory?: string | ((signal) => string);  // Optional.
  approvalMode?: 'plan' | 'default' | 'auto-edit' | 'auto' | 'yolo';  // Default: 'yolo'.
  outputFormat?: 'text' | 'json' | 'stream-json';  // Default: 'json'.
  maxSessionTurns?: number;        // Optional. Default: 20. Overrun exits 53.
  maxToolCalls?: number;           // Optional. Overrun exits 55.
  maxWallTime?: string | number;   // Optional. '30s' | '5m' | '1h' | seconds. Exits 55.
  excludeTools?: string[];         // Optional. e.g. ['shell', 'write'].
  includeDirectories?: string[];   // Optional. Extra context directories.
  systemPrompt?: string;           // Optional. Replaces the built-in prompt.
  appendSystemPrompt?: string;     // Optional. Appended to the built-in prompt.
  sandbox?: boolean;               // Optional. Default: false.
  unattendedRetry?: boolean;       // Optional. Retry 429/529 indefinitely.
  timeout?: number;                // Optional. Hard subprocess kill in ms. Default: 600s.
  env?: Record<string, string>;    // Optional. Extra env vars for subprocess.
  binary?: string;                 // Optional. Path to qwen. Default: 'qwen'.
  output?: OutputMapping;          // Optional. Signal deposit mapping.
  autoWithdraw?: boolean;          // Optional. Default: true.
  onOutput?: (chunk: string) => void;      // Optional. Raw stdout chunks.
  onMessage?: (msg: QwenMessage) => void;  // Optional. stream-json messages.
})
```

`maxWallTime` is the CLI's own cooperative budget — it stops the agent cleanly
and exits 55. `timeout` is Mandible's hard SIGTERM/SIGKILL backstop. Set both.

### Result Object

```typescript
interface QwenCodeResult {
  text: string;         // The agent's final answer (raw stdout if unparseable)
  stdout: string;       // Raw stdout
  stderr: string;
  exitCode: number;     // 0 ok · 53 turn cap · 55 budget · 130 interrupt
  stopReason: 'success' | 'error' | 'max-turns' | 'budget'
            | 'interrupted' | 'timeout' | 'spawn-failed';
  durationMs: number;
  success: boolean;     // exitCode === 0
  isError: boolean;     // the CLI reported an error result
  timedOut: boolean;
  sessionId?: string;   // reusable with the CLI's --resume
  model?: string;
  subtype?: string;     // 'success' | 'error_during_execution' | ...
  usage: { input_tokens: number; output_tokens: number };
  toolCalls: number;
  messages: QwenMessage[];   // empty in 'text' mode or on a parse failure
}
```

Branch on `stopReason`, not just `success` — an exhausted budget is a signal to
re-queue with more headroom, whereas a genuine error usually is not.

### Live progress with stream-json

```typescript
withQwenCode({
  endpoint: 'http://localhost:8001',
  prompt: 'Migrate callbacks to async/await in src/',
  outputFormat: 'stream-json',
  onMessage: (msg) => {
    if (msg.type === 'assistant') console.log('thinking…');
    if (msg.type === 'result') console.log('done:', msg.result);
  },
})
```

### When to Use withQwenCode vs withToolLoop

| Factor | withQwenCode | withToolLoop |
|--------|-------------|-------------|
| Setup | Requires the `qwen` binary installed | No external binary needed |
| Tool execution | qwen-code handles it internally | You control the tool implementations |
| Custom tools | Limited to qwen-code's built-in tools | Define any custom tools |
| Observability | Session messages via `onMessage` | Per-tool-call and per-turn hooks |
| Token tracking | Totals per run (`usage`, `toolCalls`) | Full per-turn token counting |
| Speed to ship | Faster (thin subprocess wrapper) | More implementation work |
| Control | Less (the CLI owns the loop) | Full control over the loop |

## Error Handling

The low-level `vllmProvider()` and `vllmStructuredProvider()` factories throw `VLLMError` with typed error codes:

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
import { FilesystemEnvironment, mandible } from '@mandible-ai/mandible';
import { z } from 'zod';
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

const env = new FilesystemEnvironment({
  root: './.mandible/sdlc-local',
  name: 'sdlc-local',
});

const reviewSchema = z.object({
  approved: z.boolean(),
  feedback: z.string(),
  severity: z.enum(['minor', 'major', 'blocking']),
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
      command: (signal) => {
        const version = String(signal.payload.version);
        if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
          throw new Error(`Invalid release version: ${version}`);
        }
        return `git tag v${version} && git push --tags`;
      },
      output: { type: 'release:completed' },
    }))
  )

  .start();
```
