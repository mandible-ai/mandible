// ============================================================
// Dolt Environment Adapter — DoltHub HTTP API
// ============================================================
// Maps the stigmergy Environment interface to a DoltHub database
// via the DoltHub v1alpha1 REST API.
//
// No local Dolt server or mysql2 dependency required — just a
// DoltHub account, a database, and an API token.
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
//     INDEX idx_unclaimed (withdrawn, claimed_by)
//   );
//
// Branching capability:
//   - createBranch / mergeBranch / diffBranch
//   - Colonies can operate on branches for isolation
//   - Dolt handles merge conflicts at the row level
// ============================================================

import type {
  Signal, SignalQuery, SignalMeta,
  Subscription, DecayResult,
  EnvironmentConfig, SerializableEnvironment,
} from '../../core/types.js';
import { registerEnvironment } from '../../core/environment-registry.js';
import { createSignal, matchesQuery } from '../../core/signal.js';
import { validateSignalInput } from '../../core/validation.js';
import { DoltHubClient, sqlValue, type DoltHubConfig } from './client.js';
import { tryCreateSQLClient, type DoltSQLClient, type DoltSQLConfig } from './sql-client.js';

export interface DoltEnvConfig extends DoltHubConfig {
  /** Human-readable name */
  name?: string;
  /** Poll interval for watch() in milliseconds (default: 5000) */
  pollInterval?: number;
  /** Optional mysql2 wire protocol connection — used for ACID transactions */
  sql?: DoltSQLConfig;
}

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS signals (
  id VARCHAR(64) PRIMARY KEY,
  type VARCHAR(255) NOT NULL,
  payload JSON,
  deposited_at BIGINT NOT NULL,
  deposited_by VARCHAR(255),
  concentration DECIMAL(5,4) DEFAULT 1.0,
  ttl BIGINT,
  claimed_by VARCHAR(255),
  claimed_at BIGINT,
  claim_lease BIGINT,
  caused_by JSON,
  tags JSON,
  withdrawn BOOLEAN DEFAULT FALSE,
  INDEX idx_type (type),
  INDEX idx_concentration (concentration),
  INDEX idx_unclaimed (withdrawn, claimed_by)
)`;

export class DoltEnvironment implements SerializableEnvironment {
  readonly name: string;
  private client: DoltHubClient;
  private sqlClient?: DoltSQLClient;
  private config: DoltEnvConfig;
  private pollInterval: number;
  private initialized = false;

  constructor(config: DoltEnvConfig) {
    this.config = config;
    this.client = new DoltHubClient(config);
    this.name = config.name ?? `dolt:${config.owner}/${config.database}/${config.branch ?? 'main'}`;
    this.pollInterval = config.pollInterval ?? 5000;
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;

    // Try to connect via mysql2 if sql config provided
    if (this.config.sql && !this.sqlClient) {
      const client = await tryCreateSQLClient(this.config.sql);
      if (client) {
        this.sqlClient = client;
      }
    }

    await this.activeClient.execute(CREATE_TABLE_SQL);
    this.initialized = true;
  }

  /** Returns the SQL client if available, otherwise falls back to HTTP client */
  private get activeClient(): { query: DoltHubClient['query']; execute: DoltHubClient['execute'] } {
    return this.sqlClient ?? this.client;
  }

  // ----------------------------------------------------------
  // Core operations
  // ----------------------------------------------------------

  async observe(query: SignalQuery): Promise<Signal[]> {
    await this.ensureInit();

    const conditions = ['withdrawn = FALSE'];
    if (query.type) {
      if (Array.isArray(query.type)) {
        const likes = query.type.map(t => `type LIKE ${sqlValue(globToLike(t))}`);
        conditions.push(`(${likes.join(' OR ')})`);
      } else {
        conditions.push(`type LIKE ${sqlValue(globToLike(query.type))}`);
      }
    }
    if (query.minConcentration !== undefined) {
      conditions.push(`concentration >= ${sqlValue(query.minConcentration)}`);
    }
    if (query.unclaimed) {
      conditions.push('claimed_by IS NULL');
    }
    if (query.tags && query.tags.length > 0) {
      // Check that all query tags exist in the signal's tags JSON array
      for (const tag of query.tags) {
        conditions.push(`JSON_CONTAINS(tags, ${sqlValue(JSON.stringify(tag))})`);
      }
    }
    if (query.after !== undefined) {
      conditions.push(`deposited_at > ${sqlValue(query.after)}`);
    }

    let sql = `SELECT * FROM signals WHERE ${conditions.join(' AND ')} ORDER BY concentration DESC`;
    if (query.limit) {
      sql += ` LIMIT ${query.limit}`;
    }

    const { rows } = await this.activeClient.query(sql);
    let signals = rows.map(rowToSignal);

    // Apply custom filter predicate if provided (can't express in SQL)
    if (query.filter) {
      signals = signals.filter(query.filter);
    }

    return signals;
  }

  async deposit(
    input: Omit<Signal, 'id' | 'meta'> & { meta?: Partial<SignalMeta> },
  ): Promise<Signal> {
    await this.ensureInit();
    validateSignalInput(input);

    const signal = createSignal(input.type, input.payload, {
      deposited_by: input.meta?.deposited_by,
      ttl: input.meta?.ttl,
      tags: input.meta?.tags,
      caused_by: input.meta?.caused_by,
      concentration: input.meta?.concentration,
    });

    const sql = `INSERT INTO signals (id, type, payload, deposited_at, deposited_by, concentration, ttl, caused_by, tags, withdrawn) VALUES (${sqlValue(signal.id)}, ${sqlValue(signal.type)}, ${sqlValue(JSON.stringify(signal.payload))}, ${sqlValue(signal.meta.deposited_at)}, ${sqlValue(signal.meta.deposited_by)}, ${sqlValue(signal.meta.concentration)}, ${signal.meta.ttl != null ? sqlValue(signal.meta.ttl) : 'NULL'}, ${signal.meta.caused_by ? sqlValue(JSON.stringify(signal.meta.caused_by)) : 'NULL'}, ${signal.meta.tags ? sqlValue(JSON.stringify(signal.meta.tags)) : 'NULL'}, FALSE)`;

    await this.activeClient.execute(sql);
    return signal;
  }

  async withdraw(signalId: string): Promise<void> {
    await this.ensureInit();
    await this.activeClient.execute(
      `UPDATE signals SET withdrawn = TRUE WHERE id = ${sqlValue(signalId)}`,
    );
  }

  async update(
    signalId: string,
    changes: {
      payload?: Record<string, unknown>;
      meta?: Partial<Pick<SignalMeta, 'tags' | 'concentration'>>;
    },
  ): Promise<Signal> {
    await this.ensureInit();

    const setClauses: string[] = [];

    if (changes.payload) {
      // Read current payload, merge, then SET
      const { rows } = await this.activeClient.query(
        `SELECT payload FROM signals WHERE id = ${sqlValue(signalId)} AND withdrawn = FALSE`,
      );
      if (rows.length === 0) {
        throw new Error(`Signal ${signalId} not found or already withdrawn`);
      }
      const current = (parseJSON((rows[0] as Record<string, unknown>).payload) ?? {}) as Record<string, unknown>;
      const merged = { ...current, ...changes.payload };
      setClauses.push(`payload = ${sqlValue(JSON.stringify(merged))}`);
    }

    if (changes.meta?.tags !== undefined) {
      setClauses.push(`tags = ${sqlValue(JSON.stringify(changes.meta.tags))}`);
    }

    if (changes.meta?.concentration !== undefined) {
      setClauses.push(`concentration = ${sqlValue(changes.meta.concentration)}`);
    }

    if (setClauses.length === 0) {
      // No changes — just read and return
      const { rows } = await this.activeClient.query(
        `SELECT * FROM signals WHERE id = ${sqlValue(signalId)} AND withdrawn = FALSE`,
      );
      if (rows.length === 0) {
        throw new Error(`Signal ${signalId} not found or already withdrawn`);
      }
      return rowToSignal(rows[0] as Record<string, unknown>);
    }

    const updateSql = `UPDATE signals SET ${setClauses.join(', ')} WHERE id = ${sqlValue(signalId)} AND withdrawn = FALSE`;
    const result = await this.activeClient.execute(updateSql);

    if (result.affectedRows === 0) {
      throw new Error(`Signal ${signalId} not found or already withdrawn`);
    }

    // Re-read the updated signal
    const { rows } = await this.activeClient.query(
      `SELECT * FROM signals WHERE id = ${sqlValue(signalId)}`,
    );
    return rowToSignal(rows[0] as Record<string, unknown>);
  }

  async claim(
    signalId: string,
    claimant: string,
    leaseDuration: number = 60_000,
  ): Promise<boolean> {
    await this.ensureInit();
    const now = Date.now();

    const sql = `UPDATE signals SET claimed_by = ${sqlValue(claimant)}, claimed_at = ${sqlValue(now)}, claim_lease = ${sqlValue(leaseDuration)} WHERE id = ${sqlValue(signalId)} AND withdrawn = FALSE AND (claimed_by IS NULL OR (claimed_at + claim_lease) < ${sqlValue(now)})`;

    const result = await this.activeClient.execute(sql);
    return result.affectedRows > 0;
  }

  async release(signalId: string): Promise<void> {
    await this.ensureInit();
    await this.activeClient.execute(
      `UPDATE signals SET claimed_by = NULL, claimed_at = NULL, claim_lease = NULL WHERE id = ${sqlValue(signalId)}`,
    );
  }

  watch(query: SignalQuery, callback: (signal: Signal) => void): Subscription {
    const seen = new Set<string>();
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;

    const poll = async () => {
      if (!active) return;
      try {
        const signals = await this.observe(query);
        for (const signal of signals) {
          if (!active) return;
          if (!seen.has(signal.id)) {
            seen.add(signal.id);
            callback(signal);
          }
        }
      } catch {
        // Swallow errors during polling — will retry on next interval
      }
    };

    // Initial poll, then interval
    const setup = async () => {
      await poll();
      if (active) {
        timer = setInterval(poll, this.pollInterval);
      }
    };

    setup();

    return {
      unsubscribe() {
        active = false;
        if (timer) clearInterval(timer);
      },
    };
  }

  async history(
    query: SignalQuery & { includeWithdrawn?: boolean },
  ): Promise<Signal[]> {
    await this.ensureInit();

    const conditions: string[] = [];
    if (!query.includeWithdrawn) {
      conditions.push('withdrawn = FALSE');
    }
    if (query.type) {
      if (Array.isArray(query.type)) {
        const likes = query.type.map(t => `type LIKE ${sqlValue(globToLike(t))}`);
        conditions.push(`(${likes.join(' OR ')})`);
      } else {
        conditions.push(`type LIKE ${sqlValue(globToLike(query.type))}`);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    let sql = `SELECT * FROM signals ${where} ORDER BY deposited_at DESC`;
    if (query.limit) {
      sql += ` LIMIT ${query.limit}`;
    }

    const { rows } = await this.activeClient.query(sql);
    let signals = rows.map(rowToSignal);

    if (query.filter) {
      signals = signals.filter(query.filter);
    }

    return signals;
  }

  async decay(): Promise<DecayResult> {
    await this.ensureInit();
    const now = Date.now();
    const result: DecayResult = { decayed: 0, evaporated: 0, claimsReleased: 0 };

    // Step 1: Release expired claims
    const claimResult = await this.activeClient.execute(
      `UPDATE signals SET claimed_by = NULL, claimed_at = NULL, claim_lease = NULL WHERE claimed_by IS NOT NULL AND (claimed_at + claim_lease) < ${sqlValue(now)}`,
    );
    result.claimsReleased = claimResult.affectedRows;

    // Step 2: Evaporate signals below floor or past TTL
    const evapResult = await this.activeClient.execute(
      `UPDATE signals SET withdrawn = TRUE WHERE withdrawn = FALSE AND ((concentration - (0.01 * (${sqlValue(now)} - deposited_at) / 1000.0)) < 0.05 OR (ttl IS NOT NULL AND (deposited_at + ttl) < ${sqlValue(now)}))`,
    );
    result.evaporated = evapResult.affectedRows;

    // Step 3: Update remaining concentrations
    const decayResult = await this.activeClient.execute(
      `UPDATE signals SET concentration = GREATEST(0, concentration - (0.01 * (${sqlValue(now)} - deposited_at) / 1000.0)) WHERE withdrawn = FALSE`,
    );
    result.decayed = decayResult.affectedRows;

    return result;
  }

  async snapshot(): Promise<Signal[]> {
    await this.ensureInit();
    const { rows } = await this.activeClient.query(
      'SELECT * FROM signals WHERE withdrawn = FALSE ORDER BY concentration DESC',
    );
    return rows.map(rowToSignal);
  }

  // ----------------------------------------------------------
  // Serialization
  // ----------------------------------------------------------

  serialize(): EnvironmentConfig {
    const config: EnvironmentConfig = {
      type: 'dolt',
      name: this.name,
      owner: this.config.owner,
      database: this.config.database,
      branch: this.config.branch,
      apiBase: this.config.apiBase,
    };
    if (this.config.sql) {
      config.sql = this.config.sql;
    }
    return config;
  }

  // ----------------------------------------------------------
  // Dolt-specific operations (not part of the base interface)
  // ----------------------------------------------------------

  /**
   * Create a new branch in the Dolt database.
   * Colonies can operate on branches for isolation/experimentation.
   */
  async createBranch(branchName: string, fromBranch?: string): Promise<void> {
    await this.client.createBranch(branchName, fromBranch);
  }

  /**
   * Merge a branch back. Signals deposited on the branch become visible on target.
   * Dolt handles merge conflicts at the row level.
   */
  async mergeBranch(sourceBranch: string, targetBranch?: string): Promise<void> {
    await this.client.mergeBranch(sourceBranch, targetBranch ?? this.client.branch);
  }

  /**
   * Diff two branches to see what signals changed.
   * Useful for Critic colonies reviewing Shaper work.
   */
  async diffBranch(branch1: string, branch2: string): Promise<Signal[]> {
    const { rows } = await this.client.query(
      `SELECT * FROM dolt_diff('signals', ${sqlValue(branch1)}, ${sqlValue(branch2)})`,
    );
    return rows.map(rowToSignal);
  }
}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

/**
 * Convert a glob pattern to a SQL LIKE pattern.
 * `*` → `%`, `?` → `_`, escape existing `%` and `_`.
 */
function globToLike(glob: string): string {
  return glob
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/\*/g, '%')
    .replace(/\?/g, '_');
}

/**
 * Map a database row to a Signal object.
 * Handles JSON columns that may be strings or already-parsed objects.
 */
function rowToSignal(row: Record<string, unknown>): Signal {
  return {
    id: row.id as string,
    type: row.type as string,
    payload: (parseJSON(row.payload) ?? {}) as Record<string, unknown>,
    meta: {
      deposited_at: Number(row.deposited_at),
      deposited_by: (row.deposited_by as string) ?? undefined,
      concentration: Number(row.concentration),
      ttl: row.ttl != null ? Number(row.ttl) : undefined,
      claimed_by: (row.claimed_by as string) ?? undefined,
      claimed_at: row.claimed_at != null ? Number(row.claimed_at) : undefined,
      claim_lease: row.claim_lease != null ? Number(row.claim_lease) : undefined,
      caused_by: (parseJSON(row.caused_by) as string[] | undefined) ?? undefined,
      tags: (parseJSON(row.tags) as string[] | undefined) ?? undefined,
    },
  };
}

function parseJSON(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

// Self-register for deserialization
registerEnvironment('dolt', (c) => new DoltEnvironment({
  owner: c.owner as string,
  database: c.database as string,
  branch: c.branch as string | undefined,
  apiBase: c.apiBase as string | undefined,
  name: c.name,
  sql: c.sql as DoltSQLConfig | undefined,
}));
