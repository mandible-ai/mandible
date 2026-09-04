# Dolt Environment

[Dolt](https://www.dolthub.com/) is a SQL database with Git semantics — branches, commits, diffs, merges — and [DoltHub](https://www.dolthub.com/) hosts it as a free SaaS. `DoltEnvironment` stores signals as rows in a DoltHub database using only the DoltHub HTTP API. No local Dolt server, no MySQL driver, no new dependencies.

Why Dolt for a signal substrate:

- **Shared** — colonies on different machines see the same signals without running your own server
- **Versioned** — every write is a Dolt commit; the full signal history is queryable
- **Branchable** — a colony can work on a branch, a Critic can diff it, a Keeper can merge it

---

## Setup

1. Create a DoltHub account and a database (e.g. `my-org/colony-signals`).
2. Generate an API token under **Settings → Credentials**. Tokens look like `dhat.v1.…`.
3. Export it: `export DOLTHUB_TOKEN=dhat.v1.…`

The `signals` table is created on first use (`CREATE TABLE IF NOT EXISTS`).

```typescript
import { DoltEnvironment } from '@mandible-ai/mandible';

const env = new DoltEnvironment({
  owner: 'my-org',
  database: 'colony-signals',
  branch: 'main',          // default
  token: process.env.DOLTHUB_TOKEN,  // default — falls back to the env var
  pollInterval: 5000,      // watch() polling cadence, ms
});
```

The environment implements everything a colony needs — `observe`, `deposit`, `withdraw`, `claim`, `release`, `update`, `watch`, `history`, `decay`, `snapshot` — plus serialization, so it works with `mandible.config.ts`, `deserializeEnvironment()`, and Docker hosts.

---

## How it maps

| Mandible | Dolt |
|---|---|
| Signal | Row in `signals` (id, type, payload JSON, concentration, tags JSON, caused_by JSON, …) |
| Withdraw | `withdrawn = TRUE` (row kept for history) |
| Claim | Conditional `UPDATE … WHERE claimed_by IS NULL OR lease expired`; atomic via affected-row count |
| Enrich | `UPDATE` of payload (merged) and tags (replaced) |
| Decay | Three statements: release expired claims, evaporate below floor / past TTL, lower concentrations |
| Watch | Poll `observe()` and emit signals not seen before |
| History | `SELECT … WHERE withdrawn = TRUE` (or all rows with `includeWithdrawn`) |

Reads are a single GET. Writes go through DoltHub's async write endpoint: the client POSTs the statement, receives an `operation_name`, and polls until `done`. Expect a few hundred milliseconds per write.

---

## Branching

The Dolt-specific methods are where this environment earns its keep.

```typescript
// A shaper colony works in isolation
await env.createBranch('feature/auth', 'main');
const branchEnv = new DoltEnvironment({ owner: 'my-org', database: 'colony-signals', branch: 'feature/auth' });

// … colonies deposit and withdraw on branchEnv …

// A critic sees exactly what changed
const changed = await env.diffBranch('main', 'feature/auth');

// A keeper merges it back — Dolt resolves at row level
await env.mergeBranch('feature/auth', 'main');
```

Patterns this enables:

- **Branch per phase**: `phase/shaping`, `phase/review`, merged forward as gates open
- **Branch per experiment**: two colonies with different prompts on two branches; diff the outcomes
- **Safe retries**: retry a failed batch on a fresh branch; merge only what succeeds

---

## Watching

`watch()` is poll-based (`pollInterval`, default 5 s). It's fine for colonies, which poll anyway. Webhook-driven subscriptions are planned for `@mandible/cloud`, where a hosted relay can turn DoltHub webhooks into pushes.

---

## Limits and trade-offs

- **Latency**: writes are async + polled. Not for sub-second coordination loops; fine for anything a colony does with an LLM.
- **No transactions over HTTP**: every statement is its own commit. Claims stay atomic because they're a single conditional `UPDATE`. If you need multi-statement ACID, pass `sql: { host, user, password, … }` to use the optional `mysql2` wire-protocol client alongside the HTTP client.
- **SQL interpolation**: values are escaped with `escapeSQL()` / `sqlValue()`. Signal types and IDs are framework-controlled; payloads are JSON-encoded. Don't build queries from untrusted strings yourself.
- **Rate limits**: DoltHub's free tier is generous for colony-scale traffic but not for tight polling. Keep `pollInterval` ≥ 2 s per environment instance.

---

## Testing without DoltHub

`tests/environments/dolt.test.ts` mocks `fetch()` with an in-memory signal store that understands the INSERT/UPDATE/SELECT shapes the adapter emits. Copy that pattern to unit-test colonies against a Dolt environment offline.

Design notes from the implementation are in [`plan.md`](../../plan.md).
