# Model Routing

Mandible does not have a central model router. It has something simpler and more in keeping with stigmergy: **the environment says what tier of intelligence a task needs, and the colony reads that when it acts.** A GitHub label, a signal tag, a payload field, the concentration a depositor chose, or a mark left by a previous failed attempt — all of these are already in the substrate. Routing is just reacting to them.

This guide covers four layers, from smallest to largest:

1. **Model aliases** — say `'opus'`, not a dated snapshot
2. **Dynamic `model`** — one provider, model chosen per signal
3. **`withModelRouter`** — different providers per signal, with trail and escalation
4. **`withClassifier`** — who decides what a task *is*, when nobody labeled it

---

## 1. Model aliases

The `model` field of `withClaudeCode`, `withStructuredOutput`, `withLLM`, and `withClassifier` accepts a tier alias instead of a full ID:

| Alias | Meaning |
|---|---|
| `'fable'` | Most capable widely released model |
| `'opus'` | Frontier reasoning / long-horizon agentic work |
| `'sonnet'` | Balanced default (used when `model` is omitted) |
| `'haiku'` | Fast and cheap |

```typescript
withClaudeCode({ model: 'opus', prompt: ... })
withStructuredOutput({ model: 'haiku', ... })
```

Aliases resolve to the current model ID for that family **at call time**, so upgrading Mandible moves every colony forward without touching colony code. Full IDs (`'claude-opus-4-6'`), Bedrock IDs (`'us.anthropic.claude-sonnet-4-6'`), and third-party models pass through unchanged.

### Pinning or overriding

Resolution order for an alias:

1. `setModelAliases({ opus: 'claude-opus-4-8' })` — programmatic, process-wide
2. `MANDIBLE_MODEL_OPUS=claude-opus-4-8` — environment variable (`MANDIBLE_MODEL_<ALIAS>`)
3. The built-in table in `src/providers/models.ts`

```typescript
import { currentModelAliases } from '@mandible-ai/mandible';
console.log(currentModelAliases()); // what each alias resolves to right now
```

The resolved ID is logged on every invocation and stamped into `AgentResult.model` for `withClaudeCode`, so you can always see what actually ran.

---

## 2. Dynamic `model`

`model` can be a function of the signal. Same provider, same prompt and tools — only the model changes:

```typescript
withClaudeCode({
  model: (signal) => signal.meta.tags?.includes('complexity:high') ? 'opus' : 'sonnet',
  prompt: (signal) => `Implement: ${signal.payload.description}`,
})
```

`selectModel()` makes this declarative:

```typescript
import { selectModel, escalationLevel } from '@mandible-ai/mandible';

withClaudeCode({
  model: selectModel({
    rules: [
      { match: (s) => escalationLevel(s) > 0,                  model: 'opus'  }, // retried after failure
      { match: (s) => s.meta.tags?.includes('complexity:high'), model: 'opus'  },
      { match: (s) => s.meta.tags?.includes('complexity:low'),  model: 'haiku' },
    ],
    default: 'sonnet',
  }),
  prompt: ...
})
```

> **Bedrock:** `bedrock.model` / `bedrockConfig.model` is a static override and cannot be combined with a dynamic `model` function — the provider throws at construction. Return Bedrock IDs from your function instead.

---

## 3. `withModelRouter`

When tiers need *different providers* — Opus with full tool use for hard issues, a structured-output call on Haiku for triage, a bash script for the mechanical ones — use the router. It is itself an `ActionHandler`, so the DSL and runtime don't change.

```typescript
import {
  withModelRouter, byTag, byEscalation, byType, byConcentration, byPayload,
  withClaudeCode, withStructuredOutput, withBash,
} from '@mandible-ai/mandible';

colony('worker')
  .in(githubEnv)
  .sense('task:ready', { unclaimed: true })
  .retry(3)
  .do('process', withModelRouter({
    routes: [
      byEscalation(1,            withClaudeCode({ model: 'opus', prompt })),
      byTag('complexity:high',   withClaudeCode({ model: 'opus', prompt })),
      byTag('complexity:low',    withStructuredOutput({ model: 'haiku', schema, prompt, route })),
      byTag('chore',             withBash({ command: 'npm run lint -- --fix', output })),
    ],
    fallback: withClaudeCode({ model: 'sonnet', prompt }),
  }))
  .build();
```

First matching route wins. `fallback` is **required** — by the time the router runs, the enclosing rule has already claimed the signal, so an unmatched signal with nowhere to go would sit until its lease expired.

### Matchers

| Matcher | Fires when | Route name recorded |
|---|---|---|
| `byTag(tag, h)` | `signal.meta.tags` includes `tag` (GitHub labels become tags) | `tag:<tag>` |
| `byType(glob, h)` | type matches, same glob rules as `.sense()` (`*` within segment, `**` across) | `type:<glob>` |
| `byPayload(field, value, h)` | `signal.payload[field] === value` | `payload:<field>=<value>` |
| `byConcentration(min, h)` | `signal.meta.concentration >= min` | `concentration>=<min>` |
| `byEscalation(min, h)` | signal has been escalated `min`+ times | `escalation>=<min>` |
| `byLineage({ environment, type?, tags?, filter?, depth? }, h)` | an ancestor (via `caused_by`, up to `depth`, default 3) matches the query | `lineage:<type>` |
| `{ name, match, use }` | custom predicate (sync or async) | `<name>` |

`byLineage` is routing driven by trails of past outcomes: a task whose previous artifact drew `review:changes-needed` goes straight to a stronger model — no thrown error, no escalation mark needed. Put it before label-based routes so history beats the label.

> **On concentration:** it decays with time by default, so `byConcentration(0.9, opus)` reads as "fresh signals → Opus". To use it as an explicit priority channel, have depositors set `meta.concentration` and turn off decay for the colony with `.decay(false)`.

### The trail

The router leaves marks on the signal it handles, via `ctx.enrich()`:

| Tag | Written when | Read by |
|---|---|---|
| `route:<name>` | before dispatch | `routedVia(signal)`; downstream colonies walking `caused_by` |
| `escalation:<n>` | after a handler throws | `byEscalation()`, `escalationLevel(signal)` |

On a GitHub environment these appear as labels on the issue, so a human can see at a glance that `route:tag:complexity:high` handled #42 and that #57 has reached `escalation:2`. Set `trail: false` to disable the route tag; `escalate: false` to disable escalation marks. Environments without `update()` support skip the write silently — the in-memory signal is still tagged, which is enough for retries.

### Escalation

Traditional routers do "cheap model failed → try the next one" with internal state. Here the failure is written to the signal, and the colony's ordinary retry loop does the rest:

1. `byTag('complexity:low', haiku)` fires; Haiku throws.
2. The router bumps the signal to `escalation:1` and rethrows.
3. `.retry(3)` re-invokes the rule with the same signal.
4. `byEscalation(1, opus)` — placed first — now matches.

Because the mark lives in the environment, it survives a colony restart and is visible to anyone inspecting the issue.

### Observability

```typescript
withModelRouter({
  routes,
  fallback,
  onRoute: (signal, { index, name }) => metrics.increment(`route.${name}`),
})
```

The `signal:matched` runtime event names the enclosing rule, not the route — use `onRoute` or the `route:` tag for per-route metrics.

---

## 4. `withClassifier` — deciding what a task is

The router reacts to marks. Where do marks come from?

| Source | Example | Cost |
|---|---|---|
| A human | GitHub label `complexity:high` → tag | free |
| An upstream colony | Scout deposits `task:ready` with `tags: ['kind:bug']` | free, but every depositor must know the taxonomy |
| A heuristic | `byPayload('files', …)`, custom `match` on diff size | free, brittle |
| Past outcomes | `byEscalation`, `byLineage` | free |
| **A cheap model** | `withClassifier` reads the task, writes tags | one Haiku call, once |

`withClassifier` is that last row. It asks a model for a structured answer, turns it into tags, and writes them onto the **same signal** with `ctx.enrich()`. It deposits nothing and withdraws nothing. Then it stamps `classified:<name>` so it never runs twice on one signal.

```typescript
import { withClassifier } from '@mandible-ai/mandible';
import { z } from 'zod';

const classify = withClassifier({
  model: 'haiku',
  schema: z.object({
    complexity: z.enum(['low', 'medium', 'high']),
    kind: z.enum(['bug', 'feature', 'chore']),
    touches_auth: z.boolean(),
  }),
  prompt: (s) => `Classify this task for routing:\n\n${s.payload.description}`,
  tags: (r) => [
    `complexity:${r.complexity}`,
    `kind:${r.kind}`,
    ...(r.touches_auth ? ['security-review'] : []),
  ],
});
```

Options: `name` (marker name, default `'default'`), `payload(result, signal)` to merge fields as well as tags, `replace` (default true — a new `complexity:low` evicts an old `complexity:high`), `mark` (default true), `release` (default false — see below), `onClassified`. It takes the same `model` / `provider` / `schema` / `bedrockConfig` options as `withStructuredOutput`, so it works with Anthropic, Bedrock, OpenAI, Vercel AI, or a custom function.

### Inline — classify on a miss

```typescript
withModelRouter({
  classify,
  routes: [
    byTag('security-review', opusWithReviewPrompt),
    byTag('complexity:high', opus),
    byTag('complexity:low',  haiku),
  ],
  fallback: sonnet,
})
```

When no route matches, the router runs `classify`, then evaluates the routes once more. A signal that arrives already marked — a labeled GitHub issue, a task from a Scout that set tags, a retry — never triggers the classifier. One classification per task, ever, and the marks are visible to everyone afterwards.

### A classifier colony — marks before any worker touches the task

```typescript
colony('classifier')
  .in(env)
  .sense('task:ready', { unclaimed: true, filter: (s) => !isClassified(s) })
  .do('classify', withClassifier({ ...config, release: true }))
  .claim('lease', 30_000)
  .concurrency(4)
  .build();

colony('worker')
  .in(env)
  .sense('task:ready', { unclaimed: true, filter: (s) => isClassified(s) })
  .do('work', withModelRouter({ routes, fallback }))
  .build();
```

Use this when several worker colonies share one taxonomy, or when you want marks to land before any expensive colony claims the task. Two details matter:

- **`release: true`.** The runtime keeps a claim after a successful action (that's what stops a colony re-processing a signal it hasn't withdrawn). A classifier hands the signal back instead, so it calls `ctx.release()` after marking. `ctx.release()` is available to any action.
- **The sensor filter.** The classifier colony ignores marked signals, so releasing doesn't cause it to re-claim its own work; the worker colony ignores *unmarked* ones, so it never races ahead of classification.

Classification is idempotent, so if two classifier instances ever both see a signal the result is the same marks written twice.

---

## Choosing a layer

| Need | Use |
|---|---|
| Stop pinning dated model IDs | Aliases |
| Same provider, cheaper model for easy signals | Dynamic `model` / `selectModel` |
| Different providers or tool sets per tier | `withModelRouter` |
| Retry on a stronger model after failure | `withModelRouter` + `byEscalation` + `.retry(n)` |
| Route up when a prior attempt was rejected | `byLineage({ environment, type: 'review:changes-needed' }, opus)` |
| Nobody labeled the task | `withModelRouter({ classify: withClassifier(...) })` or a classifier colony |
| See which tier produced an artifact | `routedVia(parent)` via lineage, or `AgentResult.model` |

## Runnable demo

```bash
npm run demo:model-routing
```

`examples/model-routing/index.ts` fakes the LLM so you can watch routing decisions without API keys: a classifier marks unlabeled tasks, tag routes dispatch them, a flaky "haiku" tier fails once and the retry escalates to "opus", and a task the critic rejected routes up on lineage alone. It ends by printing the `route:` / `escalation:` / `classified:` trail on every task signal. Swap `tier('opus')` for `withClaudeCode({ model: 'opus', … })` and the fake classifier provider for `'anthropic'` to run it for real.

## Roadmap

- **Budget-aware routing** — `byBudget()` reading a colony-wide cost signal and downgrading tiers when spend is high
