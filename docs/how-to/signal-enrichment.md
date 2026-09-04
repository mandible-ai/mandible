# Signal Enrichment

Most colony actions follow *sense → do → deposit a new signal → withdraw the old one*. Sometimes the right move is to **annotate the signal you're holding** instead: add a tag, merge a field into the payload, and leave it in place for the next reader.

That's `ctx.enrich()`.

```typescript
colony('triage')
  .sense('issue:detected', { unclaimed: true })
  .do('triage', async (signal, ctx) => {
    const severity = scoreSeverity(signal.payload);
    await ctx.enrich(signal.id, {
      tags: [...(signal.meta.tags ?? []), `severity:${severity}`],
      payload: { severity, triagedAt: Date.now() },
    });
    await ctx.release(); // hand it back — a fixer colony will claim it next
  })
```

## Semantics

| Field | Behavior |
|---|---|
| `payload` | **Merged** into the existing payload (shallow) |
| `tags` | **Replaced** wholesale — pass the full list you want |

The signal keeps its ID, lineage, and concentration. `enrich()` returns the updated signal and the runtime emits a `signal:enriched` event.

On a GitHub environment, tags are labels: enriching writes labels to the issue.

## `release()` — enrich without keeping the claim

A colony's claim normally persists after a successful action; that's what prevents re-processing a signal you didn't withdraw. An enricher that wants *other* colonies to pick the signal up next calls `ctx.release()` (defaults to the triggering signal). Pair it with a sensor filter so the enricher doesn't re-sense its own output:

```typescript
.sense('issue:detected', { unclaimed: true, filter: s => !s.meta.tags?.some(t => t.startsWith('severity:')) })
```

## Environment support

Enrichment needs `Environment.update()`. Filesystem, GitHub, and Dolt implement it; `ctx.enrich()` throws a clear error on an environment that doesn't. Custom environments: implement

```typescript
update(signalId: string, changes: {
  payload?: Record<string, unknown>;
  meta?: Partial<Pick<SignalMeta, 'tags' | 'concentration'>>;
}): Promise<Signal>;
```

## Turning decay off

Decay lowers every signal's concentration over time. For workflows built on enrichment — a signal that accumulates marks over hours — that's usually unwanted:

```typescript
colony('triage').decay(false)
```

Decay scheduling is per colony, but each sweep operates on the shared environment. If several colonies use the same environment, disable decay on every runtime whose sweep could affect these long-lived signals.

## Where it's used

- **Model routing** leaves `route:<name>` and `escalation:<n>` on the signal it dispatches ([Model Routing](model-routing.md))
- **Classification** writes `complexity:*` / `kind:*` and `classified:<name>` ([Model Routing → withClassifier](model-routing.md#4-withclassifier--deciding-what-a-task-is))
- **Gates** could be reimplemented with `update({ meta: { concentration } })` instead of withdraw + re-deposit, preserving the signal ID — an open improvement
