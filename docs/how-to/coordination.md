# Ordered Work: Gates and Barriers

Stigmergy is good at *parallel* work: many agents, one substrate, no coordinator. It is less obvious how to get *ordered* work — "don't start the review phase until every shaper is done", "don't ship until two critics approved" — without reintroducing a central scheduler.

Mandible uses two primitives, both of which keep the ordering *in the environment* rather than in code:

| Primitive | Shape | Question it answers |
|---|---|---|
| **Gate** | one signal waits for specific other signals | "Has *this* happened yet?" |
| **Barrier** | N signals converge into one | "Have *enough* of these happened yet?" |

Both are runnable helpers in `src/patterns/`, like `createBridge` and `createSentinel`: build one, `start()` it, `stop()` it when you're done.

---

## Gates — concentration gating

A gated signal is deposited at **concentration 0**. Colony sensors almost always filter with `minConcentration`, so a concentration-0 signal is invisible to them — it's in the environment, but no one can smell it. The gate polls its preconditions and, when they're all satisfied, withdraws the gated signal and re-deposits it at full concentration. Now colonies see it.

```typescript
import { createGate, FilesystemEnvironment } from '@mandible-ai/mandible';

const env = new FilesystemEnvironment({ root: './.mandible/signals' });
const gate = createGate({ environment: env, pollInterval: 2000 });
await gate.start();

// Seed the work
const authTask = await env.deposit({ type: 'task:ready', payload: { name: 'auth' }, meta: { deposited_by: 'seed' } });
const dbTask   = await env.deposit({ type: 'task:ready', payload: { name: 'db' },   meta: { deposited_by: 'seed' } });

// The review phase can't start until both tasks are *finished* (withdrawn)
await gate.deposit({
  type: 'phase:review',
  payload: { sprint: 'S1' },
  preconditions: [authTask.id, dbTask.id],
  preconditionMode: 'withdrawn',
});
```

Colonies keep working as normal. When the Shaper colony withdraws the last of the two tasks, the gate activates `phase:review` and whatever colony senses `phase:review` picks it up.

### Options

| Field | Meaning |
|---|---|
| `preconditions` | Signal IDs that must all be satisfied |
| `preconditionMode` | `'exists'` (default) — precondition must be present and active; `'withdrawn'` — precondition must have been completed |
| `activationConcentration` | Concentration on activation (default `1.0`) |
| `meta` | `deposited_by`, `ttl`, `tags`, `caused_by` for the gated signal |

### Lineage

The activated signal's `caused_by` contains the gated signal's original ID, the original `caused_by`, **and every precondition ID** — so `assembleContext()` and `byLineage()` can see what unblocked it.

### Debugging

Gated signals are discoverable: `env.observe({ type: 'phase:*' })` with no `minConcentration` shows them at concentration 0, tagged `gated`. `gate.stats` reports `pending` and `activated`.

---

## Barriers — fan-in convergence

A barrier watches for signals matching a query, counts distinct ones, and when the count reaches `threshold` deposits a downstream signal whose `caused_by` lists all of them.

```typescript
import { createBarrier } from '@mandible-ai/mandible';

const quorum = createBarrier({
  environment: env,
  name: 'review-quorum',
  trigger: { type: 'review:*', tags: ['approved'] },
  threshold: 2,
  then: {
    type: 'phase:merge-ready',
    payload: (reviews) => ({
      approvedBy: reviews.map(r => r.meta.deposited_by),
      artifacts: reviews.map(r => r.payload.artifact),
    }),
  },
  ttl: 30 * 60_000,
  onTimeout: {
    type: 'review:stalled',
    payload: (reviews) => ({ received: reviews.length, needed: 2 }),
  },
  pollInterval: 2000,
});
await quorum.start();
```

Two `review:*` signals tagged `approved` → one `phase:merge-ready`. One approval in 30 minutes → `review:stalled` for an escalation colony to notice.

### Options

| Field | Meaning |
|---|---|
| `trigger` | Type string or full `SignalQuery` (type globs, tags, `filter`, …) |
| `threshold` | Distinct matching signals needed (default 1) |
| `then` | What to deposit; `payload` may be a function of the accumulated signals |
| `ttl` / `onTimeout` | Expire after `ttl` ms; optionally deposit a timeout signal carrying what was collected |
| `withdrawTriggers` | Withdraw the accumulated signals after firing (default false) |
| `repeatable` | Reset and keep watching for new trigger IDs after firing (default false — one-shot barriers stop themselves) |

Signals are counted by ID for the lifetime of the barrier, so polling and repeatable rounds never double-count them. A barrier started after its triggers already exist fires on its first poll.

---

## Composing them

Gates and barriers snap together because they both speak in signals:

```typescript
// 1. N shapers finish → one batch signal
createBarrier({
  environment: env, name: 'shaping-done',
  trigger: 'artifact:shaped', threshold: tasks.length,
  then: { type: 'batch:shaped', payload: (a) => ({ artifacts: a.map(s => s.id) }) },
});

// 2. The integration phase waits for that batch signal
const batchSignalId = /* from the barrier's then, e.g. via env.watch('batch:shaped') */;
await gate.deposit({ type: 'phase:integrate', payload: {}, preconditions: [batchSignalId] });
```

Or skip the gate entirely and have the integration colony sense `batch:shaped` directly — the barrier's downstream signal *is* the ordering. Use a gate when the thing that must wait was deposited *before* its preconditions existed; use a barrier when the threshold is known but the IDs of the upstream signals are not.

## When not to use these

- **Two colonies, one hand-off**: just deposit the next signal type from the first colony's action. Gates and barriers are for *phases*, not every edge.
- **Long-lived state machines**: consider a Dolt environment and branch-per-phase instead (see [Dolt Environment](dolt-environment.md)).

A runnable demo lives at `examples/coordination/index.ts`:

```bash
npm run demo:coordination
```
