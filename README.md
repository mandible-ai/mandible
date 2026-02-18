# Colony

A universal stigmergy framework for agent coordination through environmental signals.

Instead of agents talking to each other through message passing, agents coordinate by reading from and writing to a shared environment - the same way ant colonies self-organize through pheromone trails. No agent knows about any other agent. Complex behavior emerges from simple rules.

## Why stigmergy over message passing?

Most multi-agent frameworks (CrewAI, AutoGen, LangGraph) coordinate agents through direct messaging. This reimplements distributed systems problems: service discovery, message routing, consensus, backpressure - but for LLMs.

Stigmergy sidesteps all of that. The environment carries the state. Agents are stateless reactive workers. You never need to answer "who should I tell about this?" - you just modify the environment, and whoever cares will notice.

**What you get:**

- **Observability for free** — `ls` the signals directory and see the full system state. The environment *is* the log.
- **Fault tolerance** — an agent dies, the signal remains, another agent picks it up. No lost messages.
- **Zero coupling** — add or remove colony types without touching any existing colony's configuration.
- **Natural load balancing** — spin up more instances of any colony type. They self-organize around available work.
- **Time travel** — new agents see the full environment state immediately. No message replay needed.

## Core concepts

Every concept maps to a biological analogy:

| Framework | Biology | Description |
|-----------|---------|-------------|
| **Signal** | Pheromone | A marker deposited in the environment. Has a type, payload, concentration (strength), and TTL. |
| **Environment** | Substrate | The shared medium agents read from and write to. Filesystem, database, GitHub, Kubernetes. |
| **Colony** | Ant colony | A group of identical agents with shared sensors, rules, and actuators. |
| **Sensor** | Antennae | How a colony perceives signals. A query pattern like `task:ready` or `review:*`. |
| **Rule** | Instinct | A stimulus→response mapping: "when I sense X, do Y and deposit Z." |
| **Concentration** | Pheromone strength | Signal priority. Starts at 1.0, decays over time. Agents prioritize stronger signals. |
| **Decay** | Evaporation | Signals weaken and eventually disappear, preventing stale work from accumulating. |

## Quick start

```bash
npm install
node --import tsx examples/code-pipeline/index.ts
```

Open a second terminal to watch the stigmergy loop in real time:

```bash
watch -n 0.5 'ls -la /tmp/stigmergy-demo/signals/'
```

You'll see JSON files appear and disappear as colonies deposit and withdraw signals — pheromone trails forming and evaporating on the filesystem.

## Defining a colony

Colonies are defined with a fluent DSL. Each colony declares what it senses, what rules it follows, and what it deposits. That's it.

```typescript
import { colony, createRuntime, FilesystemEnvironment } from './src/index.js';

const env = new FilesystemEnvironment({ root: '/tmp/my-env' });

// A Shaper colony: watches for tasks, produces artifacts
const shaperDef = colony('shaper')
  .in(env)
  .sense('task:ready', { unclaimed: true })
  .do('shape-code', async (signal, ctx) => {
    const result = await doWork(signal.payload);
    await ctx.deposit('artifact:shaped', result, {
      causedBy: [signal.id],
    });
    await ctx.withdraw(signal.id);
  })
  .concurrency(3)
  .claim('lease', 30_000)
  .build();

// A Critic colony: watches for artifacts, produces reviews
const criticDef = colony('critic')
  .in(env)
  .sense('artifact:shaped', { unclaimed: true })
  .do('review', async (signal, ctx) => {
    const review = await reviewWork(signal.payload);
    if (review.passes) {
      await ctx.deposit('review:approved', { artifact: signal.id });
    } else {
      await ctx.deposit('review:changes-needed', review.feedback, {
        ttl: 60_000, // auto-evaporates if nobody picks it up
      });
    }
    await ctx.withdraw(signal.id);
  })
  .concurrency(2)
  .claim('lease', 30_000)
  .build();

// Start them — they self-organize from here
const shaperRuntime = createRuntime(shaperDef);
const criticRuntime = createRuntime(criticDef);
await shaperRuntime.start();
await criticRuntime.start();
```

No colony references any other colony. They coordinate entirely through signals in the environment.

## The stigmergy loop

Every colony runtime executes the same loop:

```
sense → match rules → claim → execute action → deposit → (others sense)
```

1. **Sense** — poll or watch the environment for signals matching the colony's sensor queries.
2. **Match** — evaluate rules against sensed signals, ordered by priority.
3. **Claim** — attempt to claim the signal (prevents duplicate work across concurrent agents).
4. **Act** — execute the matched rule's action with the signal and an action context.
5. **Deposit** — leave new signals in the environment as output.

Other colonies sense those deposited signals and the cycle continues. Complex workflows emerge from simple local rules.

## DSL reference

```typescript
colony('name')
  .in(env)                                        // which environment
  .sense('type:pattern', { unclaimed: true })     // what to watch for
  .when(signal => signal.payload.priority > 0)    // optional guard
  .do('rule-name', async (signal, ctx) => { })    // action
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

## Signal types

Signal types use a `domain:state` convention and support glob patterns for sensing:

```typescript
'task:ready'        // exact match
'task:*'            // any task signal
'*:ready'           // anything in the ready state
'review:*'          // any review signal
```

## Environment adapters

The framework is environment-agnostic. Any shared substrate that supports observe/deposit/withdraw/watch can be an environment.

### Filesystem (implemented)

Signals are JSON files. Claims use atomic file operations. History lives in a `withdrawn/` directory. You can observe the entire system state with `ls` and `cat`.

```typescript
import { FilesystemEnvironment } from './src/environments/filesystem/index.js';

const env = new FilesystemEnvironment({
  root: '/tmp/my-pipeline',
  name: 'code-pipeline',
});
```

### Dolt (stubbed)

[Dolt](https://www.dolthub.com/) is a SQL database with Git-like versioning. Signals become rows, claims use `SELECT ... FOR UPDATE`, and Dolt's built-in branching/merging/diffing opens up powerful patterns:

- Shaper colonies work on a Dolt branch
- Critic colonies review by diffing branches
- Keeper colonies merge branches (Dolt merge = Git merge for data)
- Full signal history via `dolt_history` — queryable time travel

The adapter interface is identical to the filesystem adapter, so colony definitions work unchanged across either environment.

### Writing your own

Implement the `Environment` interface:

```typescript
interface Environment {
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
    types.ts            Core type definitions (Signal, Environment, Colony, Runtime)
    signal.ts           Signal creation, matching, decay math, priority sorting
    runtime.ts          Colony runtime — the stigmergy loop engine
  dsl/
    builder.ts          Fluent colony definition DSL
  environments/
    filesystem/         Working filesystem adapter
    dolt/               Dolt adapter (stubbed with implementation notes)
  index.ts              Public API

examples/
  code-pipeline/        Working demo: Shaper → Critic → Keeper pipeline
```

## Example: code pipeline demo

The included demo seeds 5 coding tasks into a filesystem environment. Three colonies self-organize to process them:

- **Shaper** (concurrency: 2) — picks up `task:ready` signals, produces `artifact:shaped` signals
- **Critic** (concurrency: 2) — reviews shaped artifacts, deposits `review:approved` or `review:changes-needed`
- **Keeper** (concurrency: 1) — merges approved artifacts, deposits `artifact:merged`

No orchestrator. No message broker. No routing logic. The colonies discover work through the environment and coordinate through signals.

```
$ node --import tsx examples/code-pipeline/index.ts

🚀 Starting colonies...
📋 Seeding tasks into environment...

[shaper] Picking up task: auth-middleware
[shaper] Picking up task: rate-limiter
[shaper] Shaped "auth-middleware" (60 lines)
[critic] Reviewing artifact for task: auth-middleware
[shaper] Shaped "rate-limiter" (96 lines)
[critic] ✓ Approved: Code for "auth-middleware" looks good.
[keeper] Merging approved artifact: auth-middleware
[critic] ✗ Changes needed: Code for "rate-limiter" needs work.
[keeper] Merged → commit 3v35a00f
```

## Roadmap

- [ ] Dolt environment adapter (full implementation)
- [ ] GitHub environment adapter (PRs/labels/comments as signals)
- [ ] Gardener colony pattern (rework loops, stale signal cleanup)
- [ ] Colony scaler (auto-adjust concurrency based on signal backlog)
- [ ] YAML colony definitions (declarative, no code)
- [ ] CLI tooling (`colony init`, `colony start`, `colony status`)
- [ ] Multi-environment pipelines (signals flow across substrates)
- [ ] Observability dashboard (signal flow visualization)

## License

MIT
