# Mandible MMP Spec

## What is Mandible?

Mandible is a universal stigmergy framework for autonomous agent coordination. Instead of wiring agents together with message passing, agents coordinate by depositing and sensing **signals** in a shared **environment** — like ant colonies using pheromone trails. Coordination emerges from the environment, not from an orchestrator.

## What is the MMP?

The Minimum Marketable Product is the smallest release that lets a developer `npm install mandible`, define a multi-agent pipeline, run it, and **watch the colonies self-organize through a live dashboard**. The dashboard is the differentiator — every agent framework can demo "agents doing tasks," but nobody has good real-time observability into multi-agent stigmergic coordination.

The MMP targets the broader AI/agent developer community. The goal is to generate enough interest to build a platform product play: hosted observability, team workspaces, shared environments, tracing, and telemetry.

## MMP Deliverables

There are three deliverables:

1. **`mandible` npm package** — the SDK
2. **`mandible dev` CLI** — runs colonies + opens a local web dashboard
3. **`create-mandible` starter template** — scaffolds a working project

---

## 1. `mandible` npm package (the SDK)

### What exists today

The following code is implemented and type-checks in the `stigmergy/` repo:

- **Core type system** (`src/core/types.ts`) — Signal, SignalMeta, Environment, ColonyDefinition, Runtime interfaces, plus provenance/trust types (TrustLevel, Attestation, ColonyIdentity, TrustPolicy, SigningConfig, VerificationResult, BridgeConfig)
- **Signal utilities** (`src/core/signal.ts`) — createSignal factory, glob-pattern matching, concentration decay, expiration, priority sorting
- **Colony runtime** (`src/core/runtime.ts`) — the stigmergy loop engine (sense → match → claim → execute → deposit), with concurrent execution, retries, decay sweeps
- **Colony DSL** (`src/dsl/builder.ts`) — fluent builder: `colony('name').in(env).sense(...).when(...).do(...).claim(...).build()`
- **Filesystem adapter** (`src/environments/filesystem/adapter.ts`) — working environment adapter storing signals as JSON files. Structure: `signals/`, `withdrawn/`, `claims/`
- **Action providers** (`src/providers/`) — `withAgent` (Claude Code SDK stub), `withStructuredOutput` (Anthropic/OpenAI/Vercel AI), `withBash` (shell commands), context assembly from signal lineage
- **Attestation utilities** (`src/core/attestation.ts`) — Ed25519 signing/verification using `@noble/ed25519`, attestation chain creation and verification, `prepareForBridge`
- **Colony patterns** (`src/patterns/`) — SignalBridge (cross-environment mirroring with attestation), Sentinel (trust monitoring)
- **Working demo** (`examples/code-pipeline/index.ts`) — 5 tasks self-organize through Shaper→Critic→Keeper with simulated work. Runs with `node --import tsx examples/code-pipeline/index.ts`

### What needs to be built for MMP

#### 1.1 Test suite for core runtime

Write comprehensive tests for:

- `signal.ts` — createSignal defaults, matchesQuery with glob patterns (`task:*`, `*:ready`, `**`), concentration decay math, TTL expiration, claim lease expiration, priority sorting
- `runtime.ts` — colony lifecycle (start/stop), sensor polling, rule matching with guards, claim acquisition and release, concurrent execution limits, retry behavior, decay sweep, auto-withdraw
- `filesystem/adapter.ts` — deposit writes JSON file, observe reads and filters, withdraw moves to history, claim creates lock file atomically, release removes lock, watch emits on new signals, decay reduces concentration and evaporates below floor, snapshot returns all active signals
- `attestation.ts` — generateIdentity produces valid keypair, signSignal produces verifiable signature, verifySignature accepts valid / rejects tampered, attestation chain creation links signatures, verifyAttestationChain walks and validates, verifySignal returns correct trust levels, policy constraints (age, depth, source environment) reject appropriately

Use `vitest` as the test runner. Target 90%+ coverage on `src/core/`.

#### 1.2 Runtime event system (for dashboard)

The colony runtime (`src/core/runtime.ts`) currently has a `RuntimeEvent` type but needs a proper event emitter that the dashboard can subscribe to. The runtime must emit events for every step of the stigmergy loop:

```typescript
interface RuntimeEvent {
  type:
    | 'colony:started'
    | 'colony:stopped'
    | 'signal:sensed'       // a signal was observed by a sensor
    | 'signal:matched'      // a signal matched a rule's guard
    | 'signal:claimed'      // a signal was claimed by this colony
    | 'signal:claim_failed' // claim contention — another colony got it
    | 'action:started'      // rule action execution began
    | 'action:completed'    // rule action finished successfully
    | 'action:failed'       // rule action threw an error
    | 'signal:deposited'    // a new signal was deposited as output
    | 'signal:withdrawn'    // a processed signal was withdrawn
    | 'decay:sweep'         // decay sweep ran, with evaporation count
    | 'claim:released'      // a claim was released (timeout or manual)
    ;
  colony: string;           // colony name
  timestamp: number;        // epoch ms
  signalId?: string;        // the signal involved (if applicable)
  signalType?: string;      // signal type for quick filtering
  rule?: string;            // which rule matched (if applicable)
  duration?: number;        // action execution time in ms (for action:completed/failed)
  error?: string;           // error message (for action:failed)
  metadata?: Record<string, unknown>; // additional context
}
```

The runtime should accept an optional `onEvent` callback in the colony definition or runtime config. The dashboard server (see section 2) will aggregate these events via WebSocket.

Also add an `environment:snapshot` event type that periodically emits the full state of all active signals (for dashboard initialization and reconnection).

#### 1.3 Wire `withAgent` to Claude Code SDK

The `withAgent` provider (`src/providers/agent.ts`) currently has the right structure but uses a dynamic import of `@anthropic-ai/claude-code`. Make it actually work:

- The Claude Code SDK (`@anthropic-ai/claude-code`) should be an optional peer dependency (it already is in package.json)
- When a colony rule uses `withAgent`, it should:
  1. Call `assembleContext()` to walk signal lineage and build a prompt
  2. Invoke Claude Code SDK with the assembled prompt, configured tools, and system prompt
  3. Parse the response and map it to signal deposits using the `outputMapping` config
  4. Return the deposits so the runtime can deposit them into the environment
- Handle the case where the SDK is not installed (throw a clear error: "Install @anthropic-ai/claude-code to use withAgent")
- The `withAgent` config should support:
  - `systemPrompt` — base instructions for the agent
  - `tools` — which Claude Code tools to enable (Read, Write, Edit, Bash, etc.)
  - `maxTurns` — limit on agentic turns
  - `outputMapping` — how to map Claude's response to signal deposits
  - `contextConfig` — how deep to walk the lineage, which related signals to include

#### 1.4 Signal validation on deposit

Add schema validation to the environment's `deposit` method:

- Signal `type` must be a non-empty string
- Signal `payload` must be an object (not null, not array)
- Signal `meta.deposited_by` must be a non-empty string
- Signal `meta.concentration` must be a number between 0 and 1
- If `meta.ttl` is provided, it must be a positive number
- If `meta.tags` is provided, it must be an array of strings
- Throw a `SignalValidationError` with a clear message on failure

#### 1.5 Package and publish prep

- Add `"bin"` field to `package.json` pointing to the CLI entry point (see section 2)
- Add `"exports"` field for clean ESM imports
- Add `"types"` field for TypeScript consumers
- Ensure `package.json` has: name `mandible`, description, keywords (stigmergy, agents, multi-agent, coordination, framework), repository URL, license (decide: MIT or Apache 2.0)
- Add a `.npmignore` or `"files"` field to keep the published package small (exclude examples, tests, docs)

---

## 2. `mandible dev` CLI

### 2.1 CLI entry point

Create `src/cli/index.ts` as the CLI entry point. The CLI should use a minimal argument parser (consider `citty` or just manual `process.argv` parsing — no heavy CLI framework needed for MMP).

Commands:

```
mandible dev [config]    # Run colonies + start dashboard server
mandible init            # (future, not MMP) Scaffold a new project
```

The `dev` command:

1. Loads the user's colony definitions from a config file (default: `mandible.config.ts`)
2. Initializes the environment(s)
3. Creates runtime instances for each colony
4. Starts all runtimes
5. Starts a local HTTP + WebSocket server for the dashboard
6. Opens the dashboard in the user's default browser
7. Handles graceful shutdown on SIGINT/SIGTERM (stops all runtimes, closes server)

### 2.2 Config file format

The config file exports a `MandibleConfig` object:

```typescript
// mandible.config.ts
import { colony, FilesystemEnvironment, withAgent, withBash } from 'mandible';

const env = new FilesystemEnvironment({ root: './.mandible/signals' });

export default {
  environment: env,
  colonies: [
    colony('shaper')
      .in(env)
      .sense({ type: 'task:ready' })
      .do(withAgent({
        systemPrompt: 'You are a code shaper. Given a task, write the implementation.',
        tools: ['Read', 'Write', 'Bash'],
      }))
      .claim('lease', 30_000)
      .concurrency(2)
      .build(),

    colony('critic')
      .in(env)
      .sense({ type: 'task:shaped' })
      .do(withAgent({
        systemPrompt: 'You are a code critic. Review the implementation for bugs and style.',
        tools: ['Read'],
      }))
      .claim('exclusive')
      .build(),

    colony('keeper')
      .in(env)
      .sense({ type: 'review:approved' })
      .do(withBash({
        command: 'git add -A && git commit -m "{{signal.payload.summary}}"',
        timeout: 10_000,
      }))
      .claim('exclusive')
      .build(),
  ],
  dashboard: {
    port: 4040,          // default dashboard port
    open: true,          // auto-open browser
  },
};
```

Use `tsx` or `jiti` to load TypeScript config files at runtime.

### 2.3 Dashboard server

The dashboard server runs inside the `mandible dev` process:

- **HTTP server** — serves the static dashboard SPA (a single HTML file with embedded JS/CSS, no build step)
- **WebSocket server** — streams runtime events to the dashboard in real-time
- **REST endpoints:**
  - `GET /api/state` — current snapshot of all active signals (for initial load / reconnection)
  - `GET /api/colonies` — list of colony definitions with their configs
  - `GET /api/stats` — runtime stats per colony (signals processed, errors, avg action duration)
  - `POST /api/signals` — manually deposit a signal (for seeding tasks from the dashboard)

Use `ws` for WebSocket. Use Node's built-in `http` module for the HTTP server (no Express needed).

### 2.4 Dashboard SPA

The dashboard is a single HTML file with embedded JavaScript and CSS. No React, no build step — it must be servable as a static file. Use vanilla JS with Web Components or a lightweight library like Preact via CDN if needed.

#### Dashboard views:

**Signal Flow (main view):**
- Real-time feed of runtime events scrolling vertically (like a log, but visual)
- Each event is a card showing: timestamp, colony name (color-coded), event type, signal type, duration (for actions)
- Active signals shown as a sidebar list with concentration bars that animate as they decay
- Color-coding: each colony gets a distinct color. Signal types get consistent colors derived from their name.

**Colony Status:**
- Card per colony showing: name, state (running/stopped), concurrency (active/max), signals processed count, error count, average action duration
- Sparkline chart showing signals-processed-per-minute over time

**Signal Graph:**
- Directed graph visualization of signal lineage (caused_by relationships)
- Nodes are signals (sized by concentration, colored by type)
- Edges are causality links
- Clicking a node shows the full signal payload and metadata
- Use `d3-force` for layout (importable via CDN)

**Environment Inspector:**
- Table of all active signals with sortable columns: id, type, deposited_by, concentration, age, claimed_by, tags
- Click to expand and see full payload JSON
- Filter by signal type (glob pattern) or colony name
- Manual signal deposit form (type + JSON payload + tags)

#### Dashboard design guidelines:
- Dark theme (dark gray background, not pure black)
- Monospace font for signal IDs and types
- Accent color: amber/orange (evokes pheromone trails)
- Smooth animations for signal appearance/disappearance (fade in/out as concentration changes)
- Responsive but desktop-first (developers use this on their main monitor)
- The Mandible logo/wordmark in the top-left corner
- Connection status indicator (WebSocket connected/reconnecting)

---

## 3. `create-mandible` starter template

Running `npx create-mandible my-project` should:

1. Create a new directory `my-project/`
2. Scaffold:
   - `package.json` with `mandible` as a dependency, `tsx` as a dev dependency, and scripts: `"dev": "mandible dev"`, `"seed": "tsx seed.ts"`
   - `tsconfig.json` with sensible defaults (ES2022, ESNext modules, strict)
   - `mandible.config.ts` with a 3-colony code pipeline (Shaper, Critic, Keeper) using `withAgent`
   - `seed.ts` — a script that deposits 3 initial `task:ready` signals into the filesystem environment
   - `.mandible/` directory (the signal environment root)
   - `README.md` explaining what the project does and how to run it
3. Print instructions:
   ```
   cd my-project
   npm install
   export ANTHROPIC_API_KEY=sk-...
   npm run seed     # deposit initial tasks
   npm run dev      # start colonies + dashboard
   ```

The starter template should work out of the box with a real Anthropic API key. If no API key is set, colonies should log a clear error and fall back gracefully (skip the LLM call, deposit a `task:error` signal with the message).

Also include a `--demo` flag: `npx create-mandible my-project --demo` that uses simulated work functions (setTimeout with random delays) instead of real LLM calls, so developers can see the full pipeline without an API key. This is critical for the first-run experience.

---

## 4. Demo scenario: Code Pipeline

The starter template uses the code pipeline scenario because every developer understands code review and it maps perfectly to the biological analogy (worker ants → code shapers, inspector ants → code critics, builder ants → keepers).

### Signal flow:

```
task:ready → [Shaper claims, writes code] → task:shaped
task:shaped → [Critic claims, reviews code] → review:approved OR review:rejected
review:approved → [Keeper claims, commits code] → task:complete
review:rejected → [loops back] → task:ready (with review feedback in payload)
```

### Signal payloads:

```typescript
// task:ready
{
  title: "Add input validation to the /users endpoint",
  description: "Validate email format and required fields before processing",
  files: ["src/routes/users.ts"],
  priority: "high",
}

// task:shaped
{
  title: "Add input validation to the /users endpoint",
  artifact: {
    files_modified: ["src/routes/users.ts"],
    diff_summary: "Added zod schema validation for email and name fields",
  },
}

// review:approved
{
  title: "Add input validation to the /users endpoint",
  summary: "Implementation is clean. Zod schemas correctly validate all required fields.",
  artifact: { /* passed through from shaper */ },
}

// review:rejected
{
  title: "Add input validation to the /users endpoint",
  feedback: "Missing validation for the 'role' field. Also add a test.",
  severity: "minor",
}

// task:complete
{
  title: "Add input validation to the /users endpoint",
  commit_sha: "a1b2c3d",
}
```

---

## 5. Non-goals for MMP

These are explicitly **out of scope** for the MMP release. They exist in the codebase or PRD but should not be prioritized:

- **Trust enforcement** — attestation types and signing utilities exist but enforcement (deposit-time verification, trust policies blocking signals) is post-MMP
- **Dolt adapter** — the stub exists but completing it is not MMP
- **GitHub adapter** — not MMP
- **CloudEvents bridge** — not MMP
- **SignalBridge pattern** — the code exists but there's no second environment to bridge to in MMP. Keep it in the codebase but don't build examples or docs for it.
- **Sentinel pattern** — same as above
- **Distributed runtime** — all colonies run in a single process for MMP
- **Authentication / multi-tenant** — the dashboard is local-only, no auth needed
- **Plugin system / marketplace** — post-MMP
- **`mandible init` CLI command** — `create-mandible` covers project scaffolding for MMP

---

## 6. Technical decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Package manager | npm | Widest compatibility |
| Test runner | vitest | Fast, ESM-native, TypeScript-first |
| CLI arg parsing | citty or manual | Minimal deps, only one command for MMP |
| Config loading | jiti or tsx register | Load .ts config files without a build step |
| Dashboard framework | Vanilla JS + d3 | No build step, single HTML file, fast to serve |
| WebSocket library | ws | Standard, lightweight |
| HTTP server | node:http | Zero dependencies |
| Ed25519 | @noble/ed25519 | Already integrated, portable, audited |
| LLM provider | Claude Code SDK | Primary provider; others via withStructuredOutput |

---

## 7. Project structure (MMP target)

```
mandible/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                          # Public API exports
│   ├── core/
│   │   ├── types.ts                      # Core type system
│   │   ├── signal.ts                     # Signal factory & utilities
│   │   ├── runtime.ts                    # Colony runtime (stigmergy loop)
│   │   ├── attestation.ts               # Ed25519 signing & verification
│   │   └── index.ts                      # Core barrel export
│   ├── dsl/
│   │   ├── builder.ts                    # Fluent colony DSL
│   │   └── index.ts
│   ├── environments/
│   │   └── filesystem/
│   │       ├── adapter.ts                # Filesystem environment
│   │       └── index.ts
│   ├── providers/
│   │   ├── types.ts                      # Provider interfaces
│   │   ├── agent.ts                      # withAgent (Claude Code SDK)
│   │   ├── structured-output.ts          # withStructuredOutput
│   │   ├── bash.ts                       # withBash
│   │   ├── context.ts                    # Context assembly
│   │   └── index.ts
│   ├── patterns/
│   │   ├── bridge.ts                     # SignalBridge (exists, not MMP focus)
│   │   ├── sentinel.ts                   # Sentinel (exists, not MMP focus)
│   │   └── index.ts
│   └── cli/
│       ├── index.ts                      # CLI entry point
│       ├── dev.ts                        # `mandible dev` command
│       ├── server.ts                     # HTTP + WebSocket dashboard server
│       └── dashboard.html                # Dashboard SPA (single file)
├── tests/
│   ├── core/
│   │   ├── signal.test.ts
│   │   ├── runtime.test.ts
│   │   └── attestation.test.ts
│   ├── environments/
│   │   └── filesystem.test.ts
│   └── providers/
│       └── agent.test.ts
├── templates/
│   └── starter/                          # create-mandible template files
│       ├── package.json.template
│       ├── tsconfig.json
│       ├── mandible.config.ts
│       ├── seed.ts
│       └── README.md
└── packages/
    └── create-mandible/
        ├── package.json
        └── index.ts                      # npx create-mandible entry point
```

---

## 8. Acceptance criteria

The MMP is shippable when all of the following are true:

1. **`npm install mandible`** installs cleanly with no peer dependency warnings (optional peers excluded)
2. **Core tests pass** with 90%+ coverage on `src/core/`
3. **The starter template works end-to-end:**
   - `npx create-mandible my-project --demo` creates a working project
   - `npm run seed` deposits 3 task signals
   - `npm run dev` starts 3 colonies and opens the dashboard
   - Within 60 seconds, all 3 tasks flow through the pipeline (shaped → reviewed → completed) visible in the dashboard
4. **The dashboard shows:**
   - Real-time event stream with colony color-coding
   - Active signals list with concentration decay animation
   - Signal lineage graph (at least for the demo pipeline)
   - Colony status cards with processing stats
   - Manual signal deposit form
5. **With a real API key:**
   - `npx create-mandible my-project` (no --demo flag) creates a project that uses Claude Code SDK
   - Setting `ANTHROPIC_API_KEY` and running `npm run dev` produces real code changes from the shaper colony
   - The critic colony provides real code review feedback
6. **README and landing page** accurately describe what the tool does with a GIF of the dashboard in action
