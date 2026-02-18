# Mandible

A universal stigmergy framework for autonomous agent coordination.

Instead of wiring agents together with message passing, Mandible agents coordinate by depositing and sensing **signals** in a shared **environment** — the same way ant colonies self-organize through pheromone trails. No orchestrator. No message routing. Complex behavior emerges from simple rules.

[mandible.dev](https://mandible.dev)

## Why stigmergy over message passing?

Most multi-agent frameworks coordinate agents through direct messaging. This reimplements distributed systems problems — service discovery, routing, consensus, backpressure — but for LLMs.

Stigmergy sidesteps all of that. The environment carries the state. Agents are stateless reactive workers. You never need to answer "who should I tell about this?" — you just modify the environment, and whoever cares will notice.

**What you get:**

- **Observability for free** — the environment *is* the log. `ls` the signals directory and see the full system state.
- **Fault tolerance** — an agent dies, the signal remains, another agent picks it up. No lost messages.
- **Zero coupling** — add or remove colony types without touching any existing colony's configuration.
- **Natural load balancing** — spin up more instances of any colony type. They self-organize around available work.
- **Provenance built in** — every signal is signed by the colony that produced it. Bridges attest transfers. Trust is verifiable.

## Quick start

```bash
npm install mandible
```

```typescript
import { colony, createRuntime, FilesystemEnvironment, withAgent } from 'mandible';

const env = new FilesystemEnvironment({ root: './.mandible/signals' });

const shaper = colony('shaper')
  .in(env)
  .sense('task:ready', { unclaimed: true })
  .do(withAgent({
    systemPrompt: 'You are a code shaper. Given a task, write the implementation.',
    tools: ['Read', 'Write', 'Bash'],
  }))
  .concurrency(2)
  .claim('lease', 30_000)
  .build();

const critic = colony('critic')
  .in(env)
  .sense('task:shaped', { unclaimed: true })
  .do(withAgent({
    systemPrompt: 'You are a code critic. Review the implementation for correctness and style.',
    tools: ['Read'],
  }))
  .claim('exclusive')
  .build();

// Start them — they self-organize from here
const shaperRuntime = createRuntime(shaper);
const criticRuntime = createRuntime(critic);
await shaperRuntime.start();
await criticRuntime.start();
```

No colony references any other colony. They coordinate entirely through signals in the environment.

## Core concepts

Every concept maps to a biological analogy:

| Mandible | Biology | Description |
|----------|---------|-------------|
| **Signal** | Pheromone | A typed marker deposited in the environment with a payload, concentration, and TTL. |
| **Environment** | Substrate | The shared medium agents read from and write to. Filesystem, Dolt, GitHub, Kubernetes. |
| **Colony** | Ant caste | A group of identical agents with shared sensors, rules, and claim strategy. |
| **Sensor** | Antennae | How a colony perceives signals. A query pattern like `task:ready` or `review:*`. |
| **Rule** | Instinct | A stimulus→response mapping: "when I sense X, do Y and deposit Z." |
| **Concentration** | Pheromone strength | Signal priority (1.0 → 0.0). Agents prioritize stronger signals. |
| **Decay** | Evaporation | Signals weaken over time, preventing stale work from accumulating. |
| **Colony Identity** | Colony scent | Ed25519 keypair. Every signal is signed by the colony that produced it. |
| **Attestation** | Trail markers | Bridges sign transfers, creating a verifiable chain of custody across environments. |
| **Sentinel** | Guard ant | Monitors an environment for signals that fail provenance verification. |

## The stigmergy loop

Every colony runtime executes the same loop:

```
sense → match rules → claim → execute action → deposit → (others sense)
```

1. **Sense** — poll or watch the environment for signals matching the colony's sensor queries.
2. **Match** — evaluate rules against sensed signals, ordered by priority.
3. **Claim** — attempt to claim the signal (prevents duplicate work across concurrent agents).
4. **Act** — execute the matched rule's action (LLM call, shell command, custom function).
5. **Deposit** — leave new signed signals in the environment as output.

Other colonies sense those deposited signals and the cycle continues. Complex workflows emerge from simple local rules.

## Colony DSL

```typescript
colony('name')
  .in(env)                                        // which environment
  .sense('type:pattern', { unclaimed: true })     // what to watch for
  .when(signal => signal.payload.priority > 0)    // optional guard
  .do(withAgent({ tools: ['Read', 'Write'] }))    // action provider
  .concurrency(3)                                 // max parallel agents
  .claim('lease', 30_000)                         // claim strategy
  .poll(2000)                                     // sensor poll interval (ms)
  .autoWithdraw()                                 // auto-remove processed signals
  .timeout(60_000)                                // action timeout
  .retry(3, 1000)                                 // retry with backoff
  .build();
```

**Claim strategies:**

| Strategy | Behavior |
|----------|----------|
| `exclusive` | Strict claim-before-work. Only one agent processes each signal. |
| `lease` | Claim with TTL. Auto-releases if the agent dies or times out. |
| `optimistic` | Let multiple agents start, reconcile after. |
| `none` | No claiming. Multiple agents may process the same signal. |

## Action providers

Action providers wrap external capabilities into a standard interface for colony rules.

| Provider | Use case | Backed by |
|----------|----------|-----------|
| `withAgent` | Coding agents, complex reasoning | Claude Code SDK |
| `withStructuredOutput` | Classification, review, decisions | Anthropic, OpenAI, Vercel AI SDK |
| `withBash` | Build commands, test runners, linters | Shell execution |

The `withAgent` provider assembles context by walking signal lineage (caused_by chains), giving the LLM full awareness of the work pipeline state.

## Signal types

Signal types use a `domain:state` convention and support glob patterns for sensing:

```typescript
'task:ready'        // exact match
'task:*'            // any task signal
'*:ready'           // anything in the ready state
'review:*'          // any review signal
```

## Trust and attestation

Mandible provides cryptographic provenance for signals using `@noble/ed25519`:

- **Colony signing** — each colony generates an Ed25519 keypair and signs every signal it deposits. Signatures cover the semantic content (type, payload, lineage) but not mutable state (concentration, timestamps).
- **Bridge attestation** — when a signal crosses environments via a bridge, the bridge appends a signed attestation. Each attestation signs over the previous, creating a linked chain of custody.
- **Trust levels** — signals are classified as `verified` (valid signature + chain), `attested` (bridge chain valid, origin unsigned), `unverified` (no provenance), or `rejected` (verification failed).
- **Sentinel colonies** — monitor an environment for trust violations and deposit report signals that other colonies can react to.

## Environment adapters

Any shared substrate that supports observe/deposit/withdraw/claim/watch can be a Mandible environment.

### Filesystem (implemented)

Signals are JSON files. Claims use atomic file operations. History lives in a `withdrawn/` directory.

```typescript
import { FilesystemEnvironment } from 'mandible';

const env = new FilesystemEnvironment({
  root: './.mandible/signals',
  name: 'local',
});
```

### Dolt (stubbed)

[Dolt](https://www.dolthub.com/) is a SQL database with Git-like versioning. Signals become rows, branching enables parallel work, and `dolt_history` provides queryable time travel for the full signal history.

### Writing your own

Implement the `Environment` interface:

```typescript
interface Environment {
  name: string;
  observe(query: SignalQuery): Promise<Signal[]>;
  deposit(signal): Promise<Signal>;
  withdraw(signalId: string): Promise<void>;
  claim(signalId: string, claimant: string, leaseDuration?: number): Promise<boolean>;
  release(signalId: string): Promise<void>;
  watch(query: SignalQuery, callback: (signal: Signal) => void): Subscription;
  history(query: SignalQuery): Promise<Signal[]>;
  decay(): Promise<DecayResult>;
  snapshot(): Promise<Signal[]>;
}
```

## Project structure

```
src/
  core/
    types.ts            Core type system (Signal, Environment, Colony, Trust)
    signal.ts           Signal creation, matching, decay, priority sorting
    runtime.ts          Colony runtime — the stigmergy loop engine
    attestation.ts      Ed25519 signing & verification (@noble/ed25519)
  dsl/
    builder.ts          Fluent colony definition DSL
  environments/
    filesystem/         Filesystem adapter (JSON files + atomic claims)
    dolt/               Dolt adapter (stub)
  providers/
    agent.ts            withAgent — Claude Code SDK
    structured-output.ts withStructuredOutput — multi-model
    bash.ts             withBash — shell commands
    context.ts          Context assembly from signal lineage
  patterns/
    bridge.ts           SignalBridge — cross-environment mirroring with attestation
    sentinel.ts         Sentinel — trust monitoring and violation reporting

examples/
  code-pipeline/        Working demo: Shaper → Critic → Keeper pipeline
```

## Example: code pipeline

The included demo seeds 5 coding tasks into a filesystem environment. Three colonies self-organize to process them:

- **Shaper** (concurrency: 2) — picks up `task:ready` signals, produces `task:shaped` signals
- **Critic** (concurrency: 2) — reviews shaped artifacts, deposits `review:approved` or `review:rejected`
- **Keeper** (concurrency: 1) — commits approved work, deposits `task:complete`

No orchestrator. No message broker. No routing logic. The colonies discover work through the environment and coordinate through signals.

```bash
node --import tsx examples/code-pipeline/index.ts
```

## Roadmap

- [ ] `mandible dev` — CLI that runs colonies + opens a live dashboard
- [ ] Real-time dashboard with signal flow visualization, colony stats, lineage graph
- [ ] `create-mandible` — project scaffolding with starter templates
- [ ] Wire `withAgent` to Claude Code SDK for real LLM-powered colonies
- [ ] Comprehensive test suite (vitest, 90%+ coverage on core)
- [ ] Dolt environment adapter (full implementation)
- [ ] GitHub environment adapter (issues/PRs/comments as signals)
- [ ] CloudEvents bridge adapter (interop with CNCF event-driven infra)
- [ ] Colony scaler (auto-adjust concurrency based on signal backlog)
- [ ] Trust enforcement (environment-level deposit-time verification)
- [ ] Hosted observability platform (tracing, telemetry, team workspaces)

## License

MIT
