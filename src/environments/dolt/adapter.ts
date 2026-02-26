// ============================================================
// Dolt Environment Adapter (Stub)
// ============================================================
// Dolt is a SQL database with Git-like versioning.
// This makes it a natural stigmergy environment because:
//
//   1. Signals = rows in a signals table
//   2. Concentration = numeric column, trivial to query/sort
//   3. Claims = SELECT ... FOR UPDATE (real DB-level locking)
//   4. History = Dolt's built-in versioning (dolt_diff, dolt_log)
//   5. Watch = Dolt's binlog or polling
//   6. Branching = multiple environment "realities" (experiments!)
//
// Schema:
//   CREATE TABLE signals (
//     id VARCHAR(64) PRIMARY KEY,
//     type VARCHAR(255) NOT NULL,
//     payload JSON,
//     deposited_at BIGINT NOT NULL,
//     deposited_by VARCHAR(255),
//     concentration DECIMAL(5,4) DEFAULT 1.0,
//     ttl BIGINT,
//     claimed_by VARCHAR(255),
//     claimed_at BIGINT,
//     claim_lease BIGINT,
//     caused_by JSON,
//     tags JSON,
//     withdrawn BOOLEAN DEFAULT FALSE,
//     INDEX idx_type (type),
//     INDEX idx_concentration (concentration),
//     INDEX idx_unclaimed (claimed_by, withdrawn)
//   );
//
// The branching capability opens up a fascinating pattern:
//   - Shaper colony works on a Dolt branch
//   - Critic colony reviews by diffing branches
//   - Keeper merges branches (Dolt merge = Git merge for data)
//   - Signals themselves can be branched and merged!
// ============================================================

import type {
  Signal, SignalQuery, SignalMeta,
  Subscription, DecayResult,
  EnvironmentConfig, SerializableEnvironment,
} from '../../core/types.js';
import { registerEnvironment } from '../../core/environment-registry.js';

export interface DoltEnvConfig {
  /** Dolt database connection string */
  connectionString: string;
  /** Database name */
  database: string;
  /** Branch to operate on (default: 'main') */
  branch?: string;
  /** Human-readable name */
  name?: string;
}

export class DoltEnvironment implements SerializableEnvironment {
  readonly name: string;
  private config: DoltEnvConfig;

  constructor(config: DoltEnvConfig) {
    this.config = config;
    this.name = config.name ?? `dolt:${config.database}/${config.branch ?? 'main'}`;
  }

  // ----------------------------------------------------------
  // All methods throw until a Dolt client is integrated.
  // The interface is identical to FilesystemEnvironment so
  // colony definitions work unchanged across either env.
  // ----------------------------------------------------------

  async observe(query: SignalQuery): Promise<Signal[]> {
    // TODO: SELECT * FROM signals WHERE type LIKE ? AND concentration >= ? AND claimed_by IS NULL ...
    // Dolt's SQL engine makes this trivially efficient with proper indexes.
    throw new Error('DoltEnvironment: not yet implemented. Install doltdb and configure connection.');
  }

  async deposit(input: Omit<Signal, 'id' | 'meta'> & { meta?: Partial<SignalMeta> }): Promise<Signal> {
    // TODO: INSERT INTO signals (id, type, payload, ...) VALUES (?, ?, ?, ...)
    // Then: CALL DOLT_COMMIT('-m', 'deposit: {type}')  ← auto-version each signal!
    throw new Error('DoltEnvironment: not yet implemented.');
  }

  async withdraw(signalId: string): Promise<void> {
    // TODO: UPDATE signals SET withdrawn = TRUE WHERE id = ?
    // Dolt keeps the history automatically — no need for a separate withdrawn table.
    throw new Error('DoltEnvironment: not yet implemented.');
  }

  async claim(signalId: string, claimant: string, leaseDuration?: number): Promise<boolean> {
    // TODO: BEGIN; SELECT ... FOR UPDATE; UPDATE SET claimed_by = ?; COMMIT;
    // This gives us real ACID claim semantics — no filesystem race conditions.
    throw new Error('DoltEnvironment: not yet implemented.');
  }

  async release(signalId: string): Promise<void> {
    // TODO: UPDATE signals SET claimed_by = NULL, claimed_at = NULL WHERE id = ?
    throw new Error('DoltEnvironment: not yet implemented.');
  }

  watch(query: SignalQuery, callback: (signal: Signal) => void): Subscription {
    // TODO: Poll-based initially, or use Dolt's binlog for push.
    // Dolt also supports `dolt_diff()` which could detect new signals by comparing commits.
    throw new Error('DoltEnvironment: not yet implemented.');
  }

  async history(query: SignalQuery & { includeWithdrawn?: boolean }): Promise<Signal[]> {
    // TODO: This is where Dolt SHINES.
    // SELECT * FROM `dolt_history_signals` WHERE type LIKE ?
    // Gets the full history of every signal across all commits.
    // Can even query: "what did the signal table look like 5 minutes ago?"
    //   AS OF 'HEAD~5' or AS OF TIMESTAMP '2024-01-01 00:00:00'
    throw new Error('DoltEnvironment: not yet implemented.');
  }

  async decay(): Promise<DecayResult> {
    // TODO: UPDATE signals SET concentration = concentration - (rate * elapsed)
    //       WHERE withdrawn = FALSE
    //       DELETE FROM signals WHERE concentration < floor
    // Single SQL statement — way more efficient than filesystem iteration.
    throw new Error('DoltEnvironment: not yet implemented.');
  }

  async snapshot(): Promise<Signal[]> {
    // TODO: SELECT * FROM signals WHERE withdrawn = FALSE ORDER BY concentration DESC
    throw new Error('DoltEnvironment: not yet implemented.');
  }

  serialize(): EnvironmentConfig {
    return {
      type: 'dolt',
      name: this.name,
      connectionString: this.config.connectionString,
      database: this.config.database,
      branch: this.config.branch,
    };
  }

  // ----------------------------------------------------------
  // Dolt-specific operations (not part of the base interface)
  // ----------------------------------------------------------

  /**
   * Create a new branch in the Dolt database.
   * Colonies can operate on branches for isolation/experimentation.
   */
  async createBranch(branchName: string, fromBranch?: string): Promise<void> {
    // TODO: CALL DOLT_BRANCH(branchName, fromBranch ?? 'main')
    throw new Error('DoltEnvironment: not yet implemented.');
  }

  /**
   * Merge a branch back. Signals deposited on the branch become visible on target.
   * Dolt handles merge conflicts at the row level.
   */
  async mergeBranch(sourceBranch: string, targetBranch?: string): Promise<void> {
    // TODO: CALL DOLT_CHECKOUT(targetBranch); CALL DOLT_MERGE(sourceBranch);
    throw new Error('DoltEnvironment: not yet implemented.');
  }

  /**
   * Diff two branches to see what signals changed.
   * Useful for Critic colonies reviewing Shaper work.
   */
  async diffBranch(branch1: string, branch2: string): Promise<Signal[]> {
    // TODO: SELECT * FROM dolt_diff('signals', branch1, branch2)
    throw new Error('DoltEnvironment: not yet implemented.');
  }
}

// Self-register for deserialization
registerEnvironment('dolt', (c) => new DoltEnvironment({
  connectionString: c.connectionString as string,
  database: c.database as string,
  branch: c.branch as string | undefined,
  name: c.name,
}));
