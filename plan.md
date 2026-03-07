# Dolt Environment Implementation Plan for Mandible

## Vision: Why Dolt Makes Mandible Exceptional

Dolt is a SQL database with full Git semantics — branch, merge, diff, log, time-travel. When combined with Mandible's stigmergy framework, it unlocks capabilities no other agent coordination system has:

### Killer Features

1. **Branched Agent Workspaces** — Each agent gets its own Dolt branch. A shaper colony works on `shaper/task-123`, deposits signals there, and the critic colony reviews by *diffing branches* rather than reading signals sequentially. The keeper merges approved branches back to `main`. Agents work in parallel isolation with zero conflicts.

2. **Time-Travel Debugging** — `AS OF` queries let you see the exact signal state at any point in history. "What did the environment look like when that agent made its decision?" becomes a single SQL query. No separate audit log needed — the database *is* the audit log.

3. **ACID Claims** — `SELECT ... FOR UPDATE` gives real database-level locking for signal claims. No filesystem race conditions. No distributed coordination overhead. Just SQL transactions.

4. **Signal Diffing for Code Review** — `dolt_diff('signals', 'main', 'shaper/task-123')` shows exactly what signals an agent deposited. Critic colonies can review agent work at the data level, not just the code level.

5. **Rollback & Recovery** — If an agent produces bad signals, `DOLT_RESET('--hard', 'HEAD~1')` on that branch reverts the damage. No cascading failures. No manual cleanup.

6. **DoltHub as Shared Environment** — Free hosted Dolt databases on dolthub.com become shared signal substrates. Teams can run colonies against the same DoltHub database from anywhere. Push/pull semantics for signal environments.

7. **SQL-Powered Observability** — Standard SQL queries for dashboards, analytics, and monitoring. `SELECT type, COUNT(*) FROM signals GROUP BY type` — no custom code needed.

8. **Multi-Branch Experimentation** — Run A/B tests on agent strategies by branching the environment, running different colony configurations, and comparing results via `dolt_diff`.

---

## Architecture

### Connection Strategy: Hosted Dolt (DoltHub)

DoltHub provides free hosted Dolt databases accessible via MySQL-compatible wire protocol. We'll use the `mysql2` npm package (the standard MySQL driver for Node.js) since Dolt speaks MySQL.

```
Colony → mysql2 connection pool → DoltHub hosted DB
                                    ├── main branch (production signals)
                                    ├── shaper/task-123 (agent workspace)
                                    ├── critic/review-456 (review workspace)
                                    └── experiment/new-decay-policy
```

### Schema

```sql
CREATE TABLE signals (
  id VARCHAR(64) PRIMARY KEY,
  type VARCHAR(255) NOT NULL,
  payload JSON,
  deposited_at BIGINT NOT NULL,
  deposited_by VARCHAR(255),
  concentration DECIMAL(5,4) DEFAULT 1.0000,
  ttl BIGINT,
  claimed_by VARCHAR(255),
  claimed_at BIGINT,
  claim_lease BIGINT,
  caused_by JSON,     -- string[] of parent signal IDs
  tags JSON,          -- string[] for filtering
  withdrawn BOOLEAN DEFAULT FALSE,
  -- Trust/provenance fields
  signature VARCHAR(512),
  signer VARCHAR(128),
  trust_level VARCHAR(20),
  source_environment VARCHAR(255),
  attestations JSON,
  -- Indexes for common query patterns
  INDEX idx_type (type),
  INDEX idx_concentration (concentration DESC),
  INDEX idx_unclaimed (claimed_by, withdrawn),
  INDEX idx_deposited_at (deposited_at),
  INDEX idx_deposited_by (deposited_by)
);
```

### New Tables for Agent Management

```sql
-- Track colony registrations and their branches
CREATE TABLE colonies (
  name VARCHAR(255) PRIMARY KEY,
  public_key VARCHAR(128),
  environment VARCHAR(255),
  branch VARCHAR(255) DEFAULT 'main',
  status ENUM('active', 'idle', 'stopped') DEFAULT 'idle',
  registered_at BIGINT NOT NULL,
  last_heartbeat BIGINT,
  config JSON,  -- colony configuration snapshot
  metadata JSON  -- arbitrary colony metadata
);

-- Track agent work sessions across branches
CREATE TABLE agent_sessions (
  id VARCHAR(64) PRIMARY KEY,
  colony_name VARCHAR(255) NOT NULL,
  branch VARCHAR(255) NOT NULL,
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  signals_deposited INT DEFAULT 0,
  signals_processed INT DEFAULT 0,
  status ENUM('active', 'completed', 'failed', 'abandoned') DEFAULT 'active',
  result JSON,
  FOREIGN KEY (colony_name) REFERENCES colonies(name)
);
```

---

## Implementation Steps

### Step 1: Add mysql2 dependency and update DoltEnvConfig

- Add `mysql2` as a peer dependency in package.json (keeping it optional like other integrations)
- Expand `DoltEnvConfig` to support:
  - `host`, `port`, `user`, `password` (for DoltHub hosted connections)
  - `connectionString` (alternative connection format)
  - `database`, `branch` (existing)
  - `autoCommit` — whether to auto-commit after each deposit/withdraw (default: true)
  - `commitPrefix` — prefix for auto-commit messages (default: 'mandible')

### Step 2: Implement core DoltEnvironment (connection & schema setup)

- Connection pool management via `mysql2/promise`
- `ensureInit()` — CREATE TABLE IF NOT EXISTS for signals table
- Branch checkout via `CALL DOLT_CHECKOUT(?)` on connection init
- Proper cleanup/pool destruction

### Step 3: Implement Environment interface methods

Each method maps naturally to SQL:

- **observe(query)** → `SELECT * FROM signals WHERE withdrawn = FALSE` + dynamic WHERE clauses for type, concentration, claimed_by, tags, after, limit. Type glob patterns (`task:*`) → SQL `LIKE 'task:%'`
- **deposit(input)** → `INSERT INTO signals ...` + optional `CALL DOLT_COMMIT('-Am', ?)`
- **withdraw(signalId)** → `UPDATE signals SET withdrawn = TRUE WHERE id = ?` + auto-commit
- **claim(signalId, claimant, leaseDuration)** → `BEGIN` → `SELECT ... FOR UPDATE` → check unclaimed → `UPDATE SET claimed_by = ?` → `COMMIT` (real ACID atomicity)
- **release(signalId)** → `UPDATE signals SET claimed_by = NULL, claimed_at = NULL, claim_lease = NULL WHERE id = ?`
- **watch(query, callback)** → Poll-based initially (query on interval, track seen IDs). DoltHub doesn't support binlog streaming, so polling is the right approach.
- **history(query)** → `SELECT * FROM dolt_history_signals` — Dolt's built-in history table gives full versioned history of every row across all commits. This is where Dolt absolutely shines vs filesystem.
- **decay()** → Single `UPDATE signals SET concentration = GREATEST(concentration - ?, 0) WHERE withdrawn = FALSE` + `UPDATE signals SET withdrawn = TRUE WHERE concentration < ?` — massively more efficient than iterating files.
- **snapshot()** → `SELECT * FROM signals WHERE withdrawn = FALSE ORDER BY concentration DESC`

### Step 4: Implement Dolt-specific branch operations

These are the features that make the Dolt environment special:

- **createBranch(name, from?)** → `CALL DOLT_BRANCH(?, ?)` — creates isolated workspace
- **mergeBranch(source, target?)** → `CALL DOLT_CHECKOUT(?)` → `CALL DOLT_MERGE(?)` — merges signal changes
- **diffBranch(branch1, branch2)** → `SELECT * FROM dolt_diff('signals', ?, ?)` — shows signal changes between branches
- **log(branch?, limit?)** → `SELECT * FROM dolt_log(?) LIMIT ?` — commit history
- **asOf(timestamp)** → Returns a new DoltEnvironment that queries `AS OF ?` — time-travel view

### Step 5: Implement agent management tables and methods

- **registerColony(name, config)** → INSERT into colonies table
- **updateHeartbeat(colonyName)** → UPDATE last_heartbeat
- **startSession(colonyName, branch)** → INSERT into agent_sessions
- **endSession(sessionId, result)** → UPDATE status, ended_at, result
- **getActiveAgents()** → SELECT from colonies/sessions where active

### Step 6: Write comprehensive tests

- Unit tests for SQL generation and signal ↔ row mapping
- Integration tests using a local Dolt instance (or mock mysql2)
- Test claim atomicity (concurrent claims)
- Test branch operations
- Test history via dolt_history
- Test decay efficiency
- Test watch polling

### Step 7: Update exports and documentation

- Export from `src/environments/dolt/index.ts`
- Already exported from main `src/index.ts`
- Add usage example showing DoltHub connection

---

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `package.json` | Edit | Add `mysql2` as peer dependency |
| `src/environments/dolt/adapter.ts` | Rewrite | Full implementation |
| `src/environments/dolt/index.ts` | Edit | Export new types |
| `src/environments/dolt/schema.ts` | New | SQL schema definitions and migrations |
| `tests/environments/dolt-adapter.test.ts` | New | Comprehensive test suite |

---

## Usage Example (Post-Implementation)

```typescript
import { mandible, colony, local } from 'mandible';
import { DoltEnvironment } from 'mandible/environments/dolt';

// Connect to DoltHub hosted database
const env = new DoltEnvironment({
  host: 'dolthub.com',  // or your hosted Dolt endpoint
  database: 'myorg/agent-signals',
  user: 'myuser',
  password: process.env.DOLT_TOKEN,
  branch: 'main',
  autoCommit: true,
});

// Shaper works on its own branch
const shaperEnv = new DoltEnvironment({
  ...env.getConfig(),
  branch: 'shaper/work',
});

// Critic reviews by diffing branches
const critic = colony('critic')
  .in(env)
  .sense('artifact:shaped', { unclaimed: true })
  .do('review', async (signal, ctx) => {
    const diff = await env.diffBranch('shaper/work', 'main');
    // Review the diff...
    await env.mergeBranch('shaper/work', 'main');
    await ctx.deposit('review:approved', { merged: true });
  })
  .build();
```
