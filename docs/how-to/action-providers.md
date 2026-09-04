# How to Use Action Providers

Action providers are factories that return standard `(signal, ctx) => Promise<void>` action handlers. Each colony uses the minimum intelligence it needs — a Shaper gets a full coding agent, a Critic gets structured output, a Keeper gets a shell command. Cost and latency stay proportional to task complexity.

Three built-in providers:

| Provider | Use case | Backed by |
|----------|----------|-----------|
| `withClaudeCode` | Coding agents, complex reasoning | Claude Code SDK |
| `withStructuredOutput` | Classification, review, decisions | Anthropic, OpenAI, Bedrock, Vercel AI, custom |
| `withBash` | Build commands, test runners, deploys | Shell execution |

All providers share two patterns: **output mapping** (how to turn results into signals) and **autoWithdraw** (automatically remove the triggering signal after success).

---

## withClaudeCode

Spawns a real Claude Code agent session via the Claude Code SDK. The agent can read files, write code, run commands — full coding capabilities inside a colony action.

### Prerequisites

```bash
npm install @anthropic-ai/claude-agent-sdk
export ANTHROPIC_API_KEY=sk-ant-...
```

### Configuration

```typescript
import { withClaudeCode } from '@mandible-ai/mandible';

colony('shaper', c => c
  .sense('task:ready', { unclaimed: true })
  .do('shape-code', withClaudeCode({
    // Model tier alias ('fable' | 'opus' | 'sonnet' | 'haiku') or a full model ID.
    // Aliases track the latest model in that family — see model-routing.md.
    // Can also be a function of the signal. Default: 'sonnet'.
    model: 'sonnet',

    // Build the prompt from the incoming signal
    // Can be a static string or an async function
    prompt: (signal) => `Implement: ${signal.payload.description}`,

    // System prompt — sets the agent's role and constraints
    systemPrompt: 'You are a senior TypeScript engineer.',

    // Tools the agent is allowed to use (Claude Code SDK tool names)
    allowedTools: ['file_edit', 'bash'],

    // Tools explicitly forbidden (takes precedence over allowedTools)
    disallowedTools: ['web_search'],

    // Working directory — static or derived from the signal
    workingDirectory: (signal) => `/workspace/${signal.payload.name}`,

    // Max conversation turns before the agent stops
    maxTurns: 20,

    // Budget cap for a single invocation (default: 1.0 USD)
    maxBudgetUsd: 2.0,

    // Permission mode (default: 'bypassPermissions' for colonies)
    permissionMode: 'bypassPermissions',

    // Observability — called for each SDK message
    onMessage: (msg) => console.log('agent:', msg),

    // Environment variables passed to the agent process
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },

    // Map agent output to signal deposits (see Output Mapping below)
    output: { type: 'artifact:shaped', tags: ['needs-review'] },

    // Auto-withdraw the triggering signal after success (default: true)
    autoWithdraw: true,
  }))
  .concurrency(2)
  .claim('lease', 120_000)
);
```

### Dynamic prompts with context assembly

Use `assembleContext` to give the agent awareness of the signal's history:

```typescript
import { withClaudeCode, assembleContext } from '@mandible-ai/mandible';

withClaudeCode({
  prompt: async (signal) => {
    const context = await assembleContext(signal, env, {
      includeLineage: true,
      lineageDepth: 3,
      includeRelated: ['review:changes-needed'],
    });

    return [
      `## Task: ${signal.payload.name}`,
      `**Description:** ${signal.payload.description}`,
      '',
      context,
    ].join('\n');
  },
  // ...
});
```

### Bedrock routing

Route Claude Code through AWS Bedrock for enterprise deployments:

```typescript
withClaudeCode({
  prompt: '...',
  bedrock: {
    region: 'us-east-1',
    model: 'us.anthropic.claude-sonnet-4-6',
    // Falls back to AWS SDK credential chain if omitted
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    profile: 'my-sso-profile',
    // Optional Bedrock Guardrails
    guardrailId: 'abc123',
    guardrailVersion: '1',
  },
  // ...
});
```

The provider sets the required environment variables (`CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, etc.) for the Claude Code SDK automatically.

### Agent result

The provider extracts a structured result from the SDK:

```typescript
interface AgentResult {
  text: string;           // Final text output
  model?: string;         // Resolved model ID that ran (trail for downstream colonies)
  costUsd: number;        // Total cost in USD
  durationMs: number;     // Wall-clock duration
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  subtype: string;        // 'success', 'error_max_turns', 'error_during_execution'
  messages: unknown[];    // Full conversation (for debugging)
}
```

This result becomes the default payload when depositing output signals.

---

## withStructuredOutput

Calls an LLM and validates the response against a Zod schema. Use this for colonies that need LLM judgment but not full tool-use loops — Critics, Classifiers, Routers.

### Prerequisites (varies by provider)

```bash
# Anthropic (default)
npm install @anthropic-ai/sdk

# Bedrock
npm install @anthropic-ai/bedrock-sdk

# OpenAI
npm install openai

# Vercel AI SDK
npm install ai @ai-sdk/anthropic   # or @ai-sdk/openai, @ai-sdk/google
```

### Configuration

```typescript
import { withStructuredOutput } from '@mandible-ai/mandible';
import { z } from 'zod';

colony('critic', c => c
  .sense('artifact:shaped', { unclaimed: true })
  .do('review-code', withStructuredOutput({
    // Model tier alias or full ID (format depends on provider). Can be a function of the signal.
    model: 'sonnet',

    // Provider SDK: 'anthropic' | 'bedrock' | 'openai' | 'vercel-ai' | custom function
    provider: 'anthropic',

    // Prompt — static string or async function
    prompt: (signal) => `Review this code:\n${JSON.stringify(signal.payload)}`,

    // System prompt
    systemPrompt: 'You are a code reviewer. Be rigorous but constructive.',

    // Zod schema for validated output
    schema: z.object({
      approved: z.boolean(),
      feedback: z.string(),
      severity: z.enum(['minor', 'major', 'blocking']),
    }),

    // Max tokens (default: 4096)
    maxTokens: 4096,

    // Temperature (default: 0)
    temperature: 0,

    // Route the result to different signal types
    route: (result, signal) => {
      if (result.approved) {
        return { type: 'review:approved', payload: { ...result, artifact: signal.payload } };
      }
      return {
        type: 'review:changes-needed',
        payload: { ...result, artifact: signal.payload },
        ttl: 120_000,
      };
    },

    // Bedrock config (required when provider is 'bedrock')
    bedrockConfig: {
      region: 'us-east-1',
    },

    autoWithdraw: true,
  }))
);
```

### Custom provider function

Pass a function instead of a provider string for custom LLM backends:

```typescript
withStructuredOutput({
  model: 'custom-model',
  provider: async (prompt, { systemPrompt, maxTokens, temperature }) => {
    // Call your custom LLM
    const response = await myLlm.chat({ prompt, system: systemPrompt });
    return JSON.parse(response.text);
  },
  route: 'classification:result',
  // ...
});
```

The function signature is:
```typescript
type LLMCallFunction<R> = (
  prompt: string,
  options: { systemPrompt?: string; maxTokens?: number; temperature?: number }
) => Promise<R>;
```

### Vercel AI SDK model auto-detection

When using `provider: 'vercel-ai'`, the model string is auto-detected:

| Model prefix | Provider SDK |
|-------------|-------------|
| `claude*` or `anthropic/*` | `@ai-sdk/anthropic` |
| `gpt*` or `openai/*` | `@ai-sdk/openai` |
| `gemini*` or `google/*` | `@ai-sdk/google` |
| anything else | defaults to `@ai-sdk/anthropic` |

If you have a Zod schema, the provider uses `generateObject` for validated structured output. Without a schema, it falls back to `generateText` + JSON parse.

### Route function

The `route` parameter controls what signals get deposited after the LLM call:

```typescript
// Simple: always deposit the same type
route: 'classification:done',

// Function: conditional routing
route: (result, signal) => {
  if (result.severity === 'blocking') {
    return { type: 'review:blocked', payload: result, tags: ['urgent'] };
  }
  return { type: 'review:feedback', payload: result };
},

// Function: multiple deposits from one result
route: (result, signal) => [
  { type: 'review:summary', payload: { summary: result.summary } },
  { type: `review:${result.verdict}`, payload: result },
],
```

---

## withBash

Runs shell commands for mechanical tasks — git merge, test runners, deploy scripts. No LLM involved. Use this for Keepers, Deployers, and any colony that does deterministic work.

### Configuration

```typescript
import { withBash } from '@mandible-ai/mandible';

colony('keeper', c => c
  .sense('review:approved', { unclaimed: true })
  .do('merge-artifact', withBash({
    // Command — static string or async function
    command: (signal) => `git merge ${signal.payload.branch}`,

    // Working directory (default: process.cwd())
    cwd: '/workspace/repo',

    // Timeout in ms (default: 30000)
    timeout: 30_000,

    // Map command output to signal deposits (required)
    output: (result, signal) => ({
      type: result.exitCode === 0 ? 'artifact:merged' : 'merge:failed',
      payload: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      },
    }),

    autoWithdraw: true,
  }))
  .concurrency(1)
  .claim('exclusive')
);
```

### Bash result

The command result is passed to your output mapping:

```typescript
interface BashResult {
  stdout: string;      // Command stdout
  stderr: string;      // Command stderr
  exitCode: number;    // 0 = success
  durationMs: number;  // Wall-clock duration
}
```

### Exit code branching

A common pattern is routing based on exit code:

```typescript
output: (result, signal) => {
  if (result.exitCode === 0) {
    return { type: 'test:passed', payload: { stdout: result.stdout } };
  }
  return {
    type: 'test:failed',
    payload: { stderr: result.stderr, exitCode: result.exitCode },
    tags: ['needs-attention'],
  };
},
```

### Timeout behavior

If the command exceeds `timeout`, the child process is killed and the result has a non-zero exit code. The `stderr` will contain the timeout error. The max output buffer is 10 MB.

---

## Context Assembly

`assembleContext` builds a rich markdown prompt by walking the signal's causal chain and pulling in related signals from the environment. Use it inside a dynamic `prompt` function for any provider.

### What it produces

```markdown
## Current Signal
- **Type:** artifact:shaped
- **ID:** sig_abc123
- **Deposited by:** shaper
- **Age:** 2m ago
- **Concentration:** 0.95
- **Tags:** needs-review
- **Payload:**
```json
{ "name": "auth-middleware", "code": "..." }
```

---

## Causal Lineage
These signals led to the current one:

→ [task:ready] Add JWT authentication middleware... (by: seed, age: 5m ago)

---

## Related Signals (Same Origin)
- [review:changes-needed] Missing error handling... (by: critic, conc: 0.80)

---

## Related: review:*
- [review:approved] Looks good... (by: critic)
```

### Configuration

```typescript
import { assembleContext } from '@mandible-ai/mandible';

const context = await assembleContext(signal, env, {
  // Walk the caused_by chain (default: false)
  includeLineage: true,

  // How many levels deep to walk (default: 3)
  lineageDepth: 3,

  // Include sibling signals — other signals caused by the same parent (default: false)
  includeSiblings: true,

  // Include related signals by type pattern
  includeRelated: ['review:*', 'test:*'],

  // Custom context builder — append arbitrary content
  custom: async (signal, env) => {
    const recent = await env.observe({ type: 'error:*', limit: 5 });
    return `Recent errors:\n${recent.map(s => `- ${s.type}: ${s.payload.message}`).join('\n')}`;
  },
});
```

### Using with providers

```typescript
withClaudeCode({
  prompt: async (signal) => {
    const context = await assembleContext(signal, env, {
      includeLineage: true,
      includeRelated: ['review:changes-needed'],
    });
    return `Implement this task:\n${signal.payload.description}\n\n${context}`;
  },
  // ...
});
```

### withContext helper

For convenience, `withContext` returns a reusable prompt builder:

```typescript
import { withContext } from '@mandible-ai/mandible';

const addContext = withContext({
  includeLineage: true,
  lineageDepth: 2,
  includeSiblings: true,
});

// Use it in a provider prompt
withClaudeCode({
  prompt: async (signal) => {
    const basePrompt = `Implement: ${signal.payload.description}`;
    return addContext(basePrompt, signal, env);
  },
  // ...
});
```

---

## Output Mapping

All providers use the same `OutputMapping` type to convert results into signal deposits.

### Simple form

Deposits the full result as payload with a fixed signal type:

```typescript
output: {
  type: 'artifact:shaped',
  tags: ['needs-review'],
  ttl: 300_000,  // 5 minutes
}
```

### Function form

Full control over what gets deposited:

```typescript
output: (result, signal) => ({
  type: 'artifact:shaped',
  payload: { code: result.text, task: signal.payload.name },
  tags: ['needs-review'],
})
```

### Multiple deposits

Return an array to deposit multiple signals from one action:

```typescript
output: (result, signal) => [
  { type: 'artifact:shaped', payload: { code: result.text } },
  { type: 'metrics:action', payload: { costUsd: result.costUsd, durationMs: result.durationMs } },
]
```

### autoWithdraw

All providers default to `autoWithdraw: true` — the triggering signal is withdrawn after the action completes successfully. Set `autoWithdraw: false` if you want the signal to remain (e.g., for signals that multiple colonies should process).

### Default output behavior

- **withClaudeCode**: if no `output` is specified, deposits `{signalType}:completed` with the full `AgentResult` as payload
- **withStructuredOutput**: uses the `route` parameter (required) instead of `output`
- **withBash**: `output` is required

---

## Complete Example

A three-colony pipeline using all three providers (from `examples/code-pipeline/with-providers.ts`):

```typescript
import {
  mandible,
  FilesystemEnvironment,
  withClaudeCode,
  withStructuredOutput,
  withBash,
  assembleContext,
} from '@mandible-ai/mandible';

const env = new FilesystemEnvironment({ root: './.mandible/signals', name: 'pipeline' });

const host = await mandible('code-pipeline')
  .environment(env)

  // Shaper — full coding agent
  .colony('shaper', c => c
    .sense('task:ready', { unclaimed: true })
    .do('shape-code', withClaudeCode({
      prompt: async (signal) => {
        const context = await assembleContext(signal, env, {
          includeLineage: true,
          includeRelated: ['review:changes-needed'],
        });
        return `Implement: ${signal.payload.description}\n\n${context}`;
      },
      allowedTools: ['file_edit', 'bash'],
      workingDirectory: (signal) => `/workspace/${signal.payload.name}`,
      output: { type: 'artifact:shaped', tags: ['needs-review'] },
    }))
    .concurrency(2)
    .claim('lease', 120_000)
  )

  // Critic — structured review
  .colony('critic', c => c
    .sense('artifact:shaped', { unclaimed: true })
    .do('review-code', withStructuredOutput({
      model: 'sonnet',
      provider: 'anthropic',
      prompt: (signal) => `Review:\n${JSON.stringify(signal.payload, null, 2)}`,
      systemPrompt: 'You are a code reviewer. Be rigorous.',
      route: (result, signal) => result.approved
        ? { type: 'review:approved', payload: result }
        : { type: 'review:changes-needed', payload: result, ttl: 120_000 },
    }))
    .concurrency(2)
    .claim('lease', 60_000)
  )

  // Keeper — merge via shell
  .colony('keeper', c => c
    .sense('review:approved', { unclaimed: true })
    .do('merge', withBash({
      command: (signal) => `git merge ${signal.payload.branch}`,
      cwd: '/workspace/repo',
      output: (result) => ({
        type: result.exitCode === 0 ? 'artifact:merged' : 'merge:failed',
        payload: result,
      }),
    }))
    .concurrency(1)
    .claim('exclusive')
  )

  .start();
```
