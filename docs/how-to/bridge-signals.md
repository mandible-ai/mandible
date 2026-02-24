# How to Bridge Signals Between Environments

Mandible provides two bridge patterns for moving signals across boundaries:

- **SignalBridge** — environment-to-environment mirroring with attestation chains
- **DebugBridge** — one-way gate from a signal server into a local environment

Both preserve provenance and deduplicate automatically.

## SignalBridge

Use `createBridge` when you need to connect two real environments. A bridge watches for matching signals in the source and mirrors them to the target, appending a signed attestation to each transfer.

### When to use

- Mirror `fix:proposed` signals from a local filesystem to GitHub so remote colonies can see them
- Replicate `task:ready` signals from GitHub issues into a local dev environment
- Create bidirectional sync between two filesystem environments

### Configuration

```typescript
import { createBridge } from '@mandible-ai/mandible';
import type { BridgeConfig } from '@mandible-ai/mandible';

const bridge = createBridge({
  // Human-readable name (used in log messages)
  name: 'local-to-github',

  // Bridge identity — Ed25519 keypair for signing attestations
  identity: bridgeIdentity,

  // Source environment to watch
  source: localEnv,

  // Target environment to deposit mirrored signals into
  target: githubEnv,

  // Signal type patterns to bridge (glob syntax)
  signalTypes: ['fix:proposed', 'review:*'],

  // Bridge in both directions (default: false)
  bidirectional: false,

  // Transform signals during bridging (return null to filter out)
  transform: (signal) => {
    // Strip large payloads before bridging
    if (signal.payload.diff && String(signal.payload.diff).length > 10_000) {
      return { ...signal, payload: { ...signal.payload, diff: '[truncated]' } };
    }
    return signal;
  },

  // Poll interval if source doesn't support watch (default: 5000ms)
  pollInterval: 5_000,
});

await bridge.start();
```

### Full example: local dev to GitHub

```typescript
import {
  createBridge,
  FilesystemEnvironment,
  GitHubEnvironment,
  generateIdentity,
} from '@mandible-ai/mandible';

const localEnv = new FilesystemEnvironment({
  root: './.mandible/signals',
  name: 'local',
});

const githubEnv = new GitHubEnvironment({
  owner: 'my-org',
  repo: 'my-project',
  token: process.env.GITHUB_TOKEN!,
});

const bridgeId = await generateIdentity('local-to-github-bridge', 'local');

const bridge = createBridge({
  name: 'local-to-github',
  identity: bridgeId,
  source: localEnv,
  target: githubEnv,
  signalTypes: ['fix:proposed'],
});

await bridge.start();
console.log('Bridge running:', bridge.running);

// Check stats
const stats = bridge.stats;
console.log(`Bridged: ${stats.signalsBridged}, Filtered: ${stats.signalsFiltered}`);

// Graceful shutdown
await bridge.stop();
```

### How attestation chains work

When a signal crosses a bridge:

1. The bridge takes the original signal from the source environment
2. `prepareForBridge()` appends a new `Attestation` to `signal.meta.attestations`
3. The attestation is signed with the bridge's Ed25519 private key
4. Each attestation signs over the previous signature, creating a linked chain
5. The signal is deposited into the target with `concentration: 1.0` and cleared claim state

The attestation chain records:
- **attester** — bridge identity name
- **attesterKey** — bridge public key (hex)
- **sourceEnvironment** — where the signal came from
- **targetEnvironment** — where it was deposited
- **timestamp** — when the transfer happened
- **signature** — Ed25519 signature linking to the previous attestation

A Sentinel in the target environment can verify the full chain to determine trust level.

### Dedup and loop prevention

The bridge tracks bridged signal IDs in an internal set (capped at 10,000 entries, LRU eviction at 50%). Two mechanisms prevent loops:

1. **ID tracking** — if a signal ID has already been bridged, it's skipped
2. **Source environment check** — if `signal.meta.sourceEnvironment` matches the target environment name, the signal is skipped (prevents echo in bidirectional bridges)

### Monitoring

```typescript
const stats = bridge.stats;
// {
//   signalsBridged: number,    — successfully mirrored
//   signalsFiltered: number,   — dropped by transform returning null
//   errors: number,            — deposit failures
//   lastBridgedAt?: number,    — epoch ms of last successful bridge
// }
```

### Watch vs poll

The bridge tries `source.watch()` first. If the environment throws (watch not supported), it falls back to polling at `pollInterval` (default 5 seconds). For bidirectional bridges, both directions independently choose watch or poll.

---

## DebugBridge

Use `createDebugBridge` when you need a one-way gate from a signal server into a local environment. This is the mechanism that makes the cloud console's "deposit signal" drawer work — signals deposited in the console flow through the signal server WebSocket and into the colony's real environment.

### When to use

- Ad-hoc testing: deposit signals from the cloud console into a running colony
- Colony runner integration: the cloud colony runner uses DebugBridge to receive signals from the signal server

### Configuration

```typescript
import { createDebugBridge } from '@mandible-ai/mandible';
import type { DebugBridgeConfig } from '@mandible-ai/mandible';

const bridge = createDebugBridge({
  // Human-readable name (default: 'debug-bridge')
  name: 'console-to-local',

  // Signal server WebSocket URL
  url: 'wss://signals.mandible.cloud/ws',

  // API key for signal server authentication
  apiKey: 'mnd_...',

  // Project ID — signals are isolated per project
  project: 'my-project',

  // Target environment — inbound signals are deposited here
  environment: localEnv,

  // Signal type filter patterns (default: ['*'])
  signalTypes: ['task:*', 'debug:*'],

  // Auto-reconnect on disconnect (default: true)
  reconnect: true,

  // Callback when a signal is successfully bridged
  onBridged: (signal) => {
    console.log(`Bridged: ${signal.type} (${signal.id})`);
  },

  // Callback on errors
  onError: (error) => {
    console.error('Bridge error:', error.message);
  },

  // Connection timeout in ms (default: 10000)
  connectTimeout: 10_000,
});

await bridge.start();
```

### End-to-end flow

```
Cloud Console          Signal Server          DebugBridge          Environment          Colony
     |                      |                      |                    |                  |
     |--- deposit signal -->|                      |                    |                  |
     |                      |--- WebSocket msg --->|                    |                  |
     |                      |                      |--- env.deposit -->|                  |
     |                      |                      |                    |--- sense ------->|
     |                      |                      |                    |                  |
     |                      |                      |                    |<-- deposit -------|
     |                      |<-- signal report ----|                    |                  |
     |<-- dashboard update -|                      |                    |                  |
```

1. User deposits a signal in the cloud console
2. Signal server broadcasts it via WebSocket
3. DebugBridge receives the message and deposits into the local environment
4. Colony senses the new signal and processes it normally
5. Colony deposits output signals, which the signal server reports back to the dashboard

### Connection lifecycle

1. **Connect** — opens WebSocket to `config.url`
2. **Authenticate** — sends `{ type: 'auth', apiKey, project }` message
3. **Subscribe** — sends `{ type: 'subscribe', query: { type: signalTypes } }` after auth succeeds
4. **Ready** — `start()` resolves once the subscription is acknowledged
5. **Keepalive** — pings every 30 seconds; terminates socket if no pong within 10 seconds
6. **Reconnect** — on disconnect, retries with exponential backoff (1s → 2s → 4s → ... → 30s max)

### Reconnect behavior

Reconnect is enabled by default. On disconnect:
- Backoff starts at 1 second, doubles each attempt, caps at 30 seconds
- Reconnect resets to 0 backoff after a successful connection
- The dedup set persists across reconnects, preventing re-deposit of already-seen signals
- Call `bridge.stop()` for intentional shutdown (skips reconnect)

### Monitoring

```typescript
const stats = bridge.stats;
// {
//   signalsBridged: number,    — deposited into environment
//   signalsFiltered: number,   — always 0 (no transform support)
//   errors: number,            — connection/deposit failures
//   lastBridgedAt?: number,    — epoch ms
// }
```

### Error handling

The DebugBridge surfaces errors through two channels:
- **`onError` callback** — called for WebSocket errors, signal server errors, and deposit failures
- **`stats.errors`** — incremented for every error

If `start()` cannot connect or authenticate within `connectTimeout`, it rejects with an error. After startup, connection drops trigger automatic reconnect (if enabled).
