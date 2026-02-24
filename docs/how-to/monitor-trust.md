# How to Monitor Trust with Sentinel

The Sentinel pattern monitors an environment for signals with invalid or missing provenance. When a signal's trust level falls below the policy minimum, the sentinel flags it — depositing a report signal that other colonies can react to.

## When to use

- Environments that receive signals from multiple sources (bridges, external systems)
- Production colonies where you want to detect unsigned or tampered signals
- Multi-team deployments where trust boundaries matter

## Quick start

```typescript
import { createSentinel } from '@mandible-ai/mandible';

const sentinel = createSentinel({
  name: 'trust-guard',
  environment: env,
  policy: {
    name: 'strict',
    defaultTrust: 'unverified',
    minimumTrust: 'attested',
    trustedColonies: [shaperPublicKey, criticPublicKey],
    trustedBridges: [githubBridgePublicKey],
    quarantineRejected: true,
  },
});

await sentinel.start();
```

## Configuration

```typescript
import { createSentinel } from '@mandible-ai/mandible';
import type { SentinelConfig } from '@mandible-ai/mandible';

const sentinel = createSentinel({
  // Name for this sentinel instance (used in log messages and report signals)
  name: 'production-guard',

  // The environment to monitor
  environment: env,

  // Trust policy (see Trust Policy section below)
  policy: {
    name: 'strict',
    defaultTrust: 'unverified',
    minimumTrust: 'verified',
    trustedColonies: [],
    trustedBridges: [],
    quarantineRejected: true,
  },

  // Signal types to monitor — glob patterns (default: all signals)
  watchTypes: ['task:*', 'artifact:*', 'review:*'],

  // Callback when any signal is evaluated
  onEvaluated: (signal, result) => {
    console.log(`${signal.type}: ${result.trustLevel} (${result.reason})`);
  },

  // Callback when a signal is flagged (below minimum trust)
  onFlagged: (signal, result) => {
    console.warn(`FLAGGED: ${signal.type} — ${result.reason}`);
  },

  // Deposit sentinel:flagged report signals into the environment (default: true)
  depositReports: true,

  // Poll interval if watch isn't supported (default: 3000ms)
  pollInterval: 3_000,
});

await sentinel.start();
```

## Trust policy

The trust policy defines how signals are evaluated. Every field matters:

```typescript
interface TrustPolicy {
  // Policy name (for logging)
  name: string;

  // Trust level for signals with no provenance metadata
  defaultTrust: TrustLevel;

  // Minimum acceptable trust level — signals below this are flagged
  minimumTrust: TrustLevel;

  // Colony public keys that are always trusted (if signature checks out)
  trustedColonies: string[];

  // Bridge/attester public keys that are trusted
  trustedBridges: string[];

  // Only accept bridged signals from these environments (undefined = accept all)
  allowedSourceEnvironments?: string[];

  // Reject signals from these environments regardless of attestation
  blockedSourceEnvironments?: string[];

  // Keep rejected signals but mark them (true) vs drop entirely (false)
  quarantineRejected: boolean;

  // Max age of oldest attestation in chain — prevents replay attacks (ms)
  maxAttestationAge?: number;

  // Max number of hops in the attestation chain
  maxAttestationDepth?: number;
}
```

## Trust levels

Signals are classified into four trust levels, ordered from highest to lowest:

| Level | Numeric | Meaning |
|-------|---------|---------|
| `verified` | 3 | Colony signature valid, full attestation chain checks out |
| `attested` | 2 | Bridge attestation present but colony signature missing |
| `unverified` | 1 | No provenance metadata (local signals, legacy systems) |
| `rejected` | 0 | Failed verification (quarantined, not evicted) |

The sentinel compares each signal's trust level against `policy.minimumTrust`. If the signal's level is below the minimum, it's flagged.

### Common policy configurations

**Strict** — require full verification:
```typescript
{
  name: 'strict',
  defaultTrust: 'unverified',
  minimumTrust: 'verified',
  trustedColonies: [key1, key2],
  trustedBridges: [bridgeKey],
  quarantineRejected: true,
}
```

**Moderate** — accept bridged signals:
```typescript
{
  name: 'moderate',
  defaultTrust: 'unverified',
  minimumTrust: 'attested',
  trustedColonies: [],
  trustedBridges: [bridgeKey],
  quarantineRejected: true,
}
```

**Permissive** — flag only rejected signals:
```typescript
{
  name: 'permissive',
  defaultTrust: 'unverified',
  minimumTrust: 'unverified',
  trustedColonies: [],
  trustedBridges: [],
  quarantineRejected: false,
}
```

## Sentinel report signals

When a signal is flagged (`depositReports` is true, which is the default), the sentinel deposits a `sentinel:flagged` signal:

```typescript
{
  type: 'sentinel:flagged',
  payload: {
    signalId: 'sig_abc123',             // The flagged signal's ID
    signalType: 'task:ready',           // The flagged signal's type
    trustLevel: 'unverified',           // What level it was assigned
    reason: 'No signature or attestation present',
    meetsPolicy: false,
    sourceEnvironment: 'github',        // Where the signal came from (if bridged)
    attestationCount: 0,                // Number of attestations in the chain
  },
  meta: {
    deposited_by: 'sentinel:production-guard',
    tags: ['sentinel', 'trust', 'unverified'],
    caused_by: ['sig_abc123'],          // Links back to the flagged signal
    ttl: 300_000,                       // Reports expire after 5 minutes
  },
}
```

Other colonies can sense `sentinel:flagged` signals and react — for example, a notification colony that alerts on trust violations, or a quarantine colony that withdraws rejected signals.

## Monitoring

### Stats

```typescript
const stats = sentinel.stats;
// {
//   signalsEvaluated: number,
//   signalsFlagged: number,
//   byTrustLevel: {
//     verified: number,
//     attested: number,
//     unverified: number,
//     rejected: number,
//   },
//   lastEvaluatedAt?: number,     // epoch ms
// }
```

### Recent evaluations

```typescript
const evaluations = sentinel.recentEvaluations;
// Last 100 evaluations, each:
// {
//   signalId: string,
//   signalType: string,
//   trustLevel: TrustLevel,
//   meetsPolicy: boolean,
//   reason: string,
//   evaluatedAt: number,
// }
```

## Lifecycle

```typescript
const sentinel = createSentinel({ /* config */ });

await sentinel.start();   // Begins monitoring + evaluates existing signals
console.log(sentinel.running);  // true

// ... later
await sentinel.stop();    // Stops watching/polling
```

On start, the sentinel:
1. Tries `environment.watch()` first for push-based monitoring
2. Falls back to polling at `pollInterval` if watch throws
3. Evaluates all existing signals matching `watchTypes` immediately

The sentinel deduplicates — each signal ID is only evaluated once (tracked in a set capped at 10,000 entries).

## Example: flag unsigned signals and alert

```typescript
import { createSentinel, createBridge } from '@mandible-ai/mandible';

// Monitor the production environment
const sentinel = createSentinel({
  name: 'prod-guard',
  environment: prodEnv,
  policy: {
    name: 'strict',
    defaultTrust: 'unverified',
    minimumTrust: 'attested',
    trustedColonies: [shaperKey, criticKey, keeperKey],
    trustedBridges: [githubBridgeKey],
    quarantineRejected: true,
    maxAttestationAge: 3600_000,   // 1 hour
    maxAttestationDepth: 3,        // max 3 hops
  },
  onFlagged: (signal, result) => {
    console.warn(`[TRUST] ${signal.type} from ${signal.meta.deposited_by}: ${result.reason}`);
  },
});

await sentinel.start();

// A separate colony can react to sentinel reports
colony('alerter', c => c
  .sense('sentinel:flagged', { unclaimed: true })
  .do('alert', async (signal, ctx) => {
    await sendSlackAlert(`Trust violation: ${signal.payload.signalType} — ${signal.payload.reason}`);
    await ctx.withdraw(signal.id);
  })
);
```
