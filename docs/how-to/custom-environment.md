# How to Implement a Custom Environment

An Environment is the shared substrate where signals live. Mandible ships with filesystem and GitHub adapters, but any backing store that supports the core operations can be an environment — a database, a message queue, an in-memory store, a cloud service.

## The Environment interface

Every environment implements these 9 methods:

```typescript
interface Environment {
  readonly name: string;

  observe(query: SignalQuery): Promise<Signal[]>;
  deposit(signal: Omit<Signal, 'id' | 'meta'> & { meta?: Partial<SignalMeta> }): Promise<Signal>;
  withdraw(signalId: string): Promise<void>;
  claim(signalId: string, claimant: string, leaseDuration?: number): Promise<boolean>;
  release(signalId: string): Promise<void>;
  watch(query: SignalQuery, callback: (signal: Signal) => void): Subscription;
  history(query: SignalQuery & { includeWithdrawn?: boolean }): Promise<Signal[]>;
  decay(): Promise<DecayResult>;
  snapshot(): Promise<Signal[]>;
}
```

### Required vs optional behavior

All methods must be implemented, but not all need full implementations:

| Method | Required behavior | Can degrade gracefully? |
|--------|------------------|------------------------|
| `observe` | Return signals matching the query | No — core to the stigmergy loop |
| `deposit` | Store a signal, assign ID and meta | No — core to the stigmergy loop |
| `withdraw` | Remove a signal from active set | No — needed for signal lifecycle |
| `claim` | Atomic claim with concurrency safety | No — needed for work distribution |
| `release` | Release a held claim | No — needed for fault tolerance |
| `watch` | Push-based signal notifications | **Yes** — throw to fall back to polling |
| `history` | Query past signals | **Yes** — return `[]` if not supported |
| `decay` | Reduce concentration over time | **Yes** — return `{ decayed: 0, evaporated: 0, claimsReleased: 0 }` |
| `snapshot` | Return all active signals | No — needed for dashboard |

If `watch` throws, the colony runtime automatically falls back to polling with `observe`. This means your environment works even without push support — it's just less responsive.

## Signal lifecycle

Understanding the signal lifecycle helps you implement each method correctly:

```
deposit()  →  signal enters active set (concentration: 1.0)
              ↓
observe()  →  colonies discover the signal via queries
              ↓
claim()    →  one colony claims it (sets claimed_by, claimed_at, claim_lease)
              ↓
[action]   →  colony processes the signal
              ↓
withdraw() →  signal moves from active to history
              ↓
history()  →  signal queryable with includeWithdrawn: true
```

Between `deposit` and `withdraw`, `decay()` runs periodically:
- Reduces `concentration` based on age and TTL
- Evaporates signals that fall below the floor (default: 0.05)
- Releases expired claims (where `claimed_at + claim_lease < now`)

## Example: minimal in-memory environment

```typescript
import { randomUUID } from 'node:crypto';
import type {
  Signal,
  SignalMeta,
  SignalQuery,
  Environment,
  Subscription,
  DecayResult,
} from '@mandible-ai/mandible';
import { matchesQuery } from '@mandible-ai/mandible';

export class InMemoryEnvironment implements Environment {
  readonly name: string;

  private signals = new Map<string, Signal>();
  private withdrawn = new Map<string, Signal>();
  private watchers: Array<{ query: SignalQuery; callback: (signal: Signal) => void }> = [];

  constructor(name: string) {
    this.name = name;
  }

  async observe(query: SignalQuery): Promise<Signal[]> {
    const results: Signal[] = [];
    for (const signal of this.signals.values()) {
      if (matchesQuery(signal, query)) {
        results.push(signal);
      }
    }

    // Sort by concentration descending (strongest signals first)
    results.sort((a, b) => b.meta.concentration - a.meta.concentration);

    if (query.limit) {
      return results.slice(0, query.limit);
    }
    return results;
  }

  async deposit(
    input: Omit<Signal, 'id' | 'meta'> & { meta?: Partial<SignalMeta> }
  ): Promise<Signal> {
    const signal: Signal = {
      id: randomUUID(),
      type: input.type,
      payload: input.payload,
      meta: {
        deposited_at: Date.now(),
        deposited_by: input.meta?.deposited_by ?? 'unknown',
        concentration: input.meta?.concentration ?? 1.0,
        ttl: input.meta?.ttl,
        tags: input.meta?.tags,
        caused_by: input.meta?.caused_by,
        signature: input.meta?.signature,
        signer: input.meta?.signer,
        attestations: input.meta?.attestations,
        trustLevel: input.meta?.trustLevel,
        sourceEnvironment: input.meta?.sourceEnvironment,
      },
    };

    this.signals.set(signal.id, signal);

    // Notify watchers
    for (const watcher of this.watchers) {
      if (matchesQuery(signal, watcher.query)) {
        watcher.callback(signal);
      }
    }

    return signal;
  }

  async withdraw(signalId: string): Promise<void> {
    const signal = this.signals.get(signalId);
    if (signal) {
      this.signals.delete(signalId);
      this.withdrawn.set(signalId, signal);
    }
  }

  async claim(signalId: string, claimant: string, leaseDuration?: number): Promise<boolean> {
    const signal = this.signals.get(signalId);
    if (!signal) return false;

    // Already claimed by someone else
    if (signal.meta.claimed_by && signal.meta.claimed_by !== claimant) {
      // Check if lease expired
      if (signal.meta.claimed_at && signal.meta.claim_lease) {
        const expiry = signal.meta.claimed_at + signal.meta.claim_lease;
        if (Date.now() < expiry) return false;
      } else {
        return false;
      }
    }

    signal.meta.claimed_by = claimant;
    signal.meta.claimed_at = Date.now();
    signal.meta.claim_lease = leaseDuration;
    return true;
  }

  async release(signalId: string): Promise<void> {
    const signal = this.signals.get(signalId);
    if (signal) {
      signal.meta.claimed_by = undefined;
      signal.meta.claimed_at = undefined;
      signal.meta.claim_lease = undefined;
    }
  }

  watch(query: SignalQuery, callback: (signal: Signal) => void): Subscription {
    const entry = { query, callback };
    this.watchers.push(entry);

    return {
      unsubscribe: () => {
        const idx = this.watchers.indexOf(entry);
        if (idx >= 0) this.watchers.splice(idx, 1);
      },
    };
  }

  async history(query: SignalQuery & { includeWithdrawn?: boolean }): Promise<Signal[]> {
    const results: Signal[] = [];
    const source = query.includeWithdrawn
      ? [...this.signals.values(), ...this.withdrawn.values()]
      : [...this.signals.values()];

    for (const signal of source) {
      if (matchesQuery(signal, query)) {
        results.push(signal);
      }
    }
    return results;
  }

  async decay(): Promise<DecayResult> {
    let decayed = 0;
    let evaporated = 0;
    let claimsReleased = 0;
    const now = Date.now();

    for (const [id, signal] of this.signals) {
      const age = now - signal.meta.deposited_at;

      // TTL-based evaporation
      if (signal.meta.ttl && age > signal.meta.ttl) {
        this.signals.delete(id);
        this.withdrawn.set(id, signal);
        evaporated++;
        continue;
      }

      // Concentration decay (1% per second)
      const decayAmount = (age / 1000) * 0.01;
      const newConcentration = Math.max(0, 1.0 - decayAmount);

      if (newConcentration < 0.05) {
        this.signals.delete(id);
        this.withdrawn.set(id, signal);
        evaporated++;
      } else if (newConcentration !== signal.meta.concentration) {
        signal.meta.concentration = newConcentration;
        decayed++;
      }

      // Release expired claims
      if (signal.meta.claimed_at && signal.meta.claim_lease) {
        if (now > signal.meta.claimed_at + signal.meta.claim_lease) {
          signal.meta.claimed_by = undefined;
          signal.meta.claimed_at = undefined;
          signal.meta.claim_lease = undefined;
          claimsReleased++;
        }
      }
    }

    return { decayed, evaporated, claimsReleased };
  }

  async snapshot(): Promise<Signal[]> {
    return [...this.signals.values()];
  }
}
```

## Key implementation notes

### deposit must assign ID and meta

The caller passes `Omit<Signal, 'id' | 'meta'> & { meta?: Partial<SignalMeta> }`. Your deposit must:
- Generate a unique `id`
- Set `meta.deposited_at` to the current time
- Set `meta.concentration` to 1.0 (unless overridden)
- Preserve any caller-provided meta fields (`deposited_by`, `tags`, `caused_by`, etc.)

### claim must be atomic

If two colonies call `claim()` for the same signal at the same time, exactly one must succeed. For in-memory implementations, JavaScript's single-threaded nature handles this. For database-backed environments, use transactions or compare-and-swap operations.

### watch can throw

If your backing store doesn't support push notifications, throw from `watch()`. The colony runtime will catch the error and fall back to polling with `observe()` at the configured interval.

```typescript
watch(): Subscription {
  throw new Error('Watch not supported — use polling');
}
```

### history and withdrawn signals

The `history` method should return both active and withdrawn signals when `includeWithdrawn: true`. This is used by context assembly to walk causal chains — a parent signal may have been withdrawn by the time its child is being processed.

### decay semantics

The `decay()` method is called periodically by the runtime. It should:
1. Reduce `concentration` for aging signals
2. Evaporate (move to history) signals below the floor threshold
3. Release claims that have exceeded their lease duration
4. Return counts of what changed

If your backing store handles TTL natively (e.g., Redis), you can let it handle evaporation and return zeros for `evaporated`.

## Testing your environment

The filesystem environment tests are a good template. Key test scenarios:

1. **deposit + observe** — deposit a signal, observe it back with matching query
2. **deposit + withdraw + history** — full lifecycle
3. **claim concurrency** — two concurrent claims, only one succeeds
4. **claim lease expiry** — claim expires, signal becomes claimable again
5. **watch notifications** — deposit triggers watcher callback
6. **decay** — signals lose concentration over time, evaporate below floor
7. **query filtering** — type globs, tags, minConcentration, unclaimed, limit
8. **snapshot** — returns all active signals

```typescript
import { describe, it, expect } from 'vitest';
import { InMemoryEnvironment } from './in-memory-environment.js';

describe('InMemoryEnvironment', () => {
  it('deposits and observes signals', async () => {
    const env = new InMemoryEnvironment('test');

    const signal = await env.deposit({
      type: 'task:ready',
      payload: { name: 'test-task' },
      meta: { deposited_by: 'test' },
    });

    const observed = await env.observe({ type: 'task:ready' });
    expect(observed).toHaveLength(1);
    expect(observed[0].id).toBe(signal.id);
  });

  it('prevents double-claiming', async () => {
    const env = new InMemoryEnvironment('test');

    const signal = await env.deposit({
      type: 'task:ready',
      payload: {},
      meta: { deposited_by: 'test' },
    });

    const first = await env.claim(signal.id, 'colony-a');
    const second = await env.claim(signal.id, 'colony-b');

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('notifies watchers on deposit', async () => {
    const env = new InMemoryEnvironment('test');
    const received: Signal[] = [];

    env.watch({ type: 'task:*' }, (signal) => received.push(signal));

    await env.deposit({
      type: 'task:ready',
      payload: {},
      meta: { deposited_by: 'test' },
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('task:ready');
  });
});
```
