// ============================================================
// DoltHub HTTP API Client
// ============================================================
// Thin client for the DoltHub v1alpha1 REST API.
// Uses native fetch() — zero dependencies.
//
// Endpoints used:
//   Read:    GET  /api/v1alpha1/{owner}/{db}/{branch}?q=<SQL>
//   Write:   POST /api/v1alpha1/{owner}/{db}/write/{from}/{to}?q=<SQL>
//   Poll:    GET  /api/v1alpha1/{owner}/{db}/write?operationName=<op>
//   Branch:  POST /api/v1alpha1/{owner}/{db}/branches
//   List:    GET  /api/v1alpha1/{owner}/{db}/branches
// ============================================================

export interface DoltHubConfig {
  /** DoltHub database owner (user or organization) */
  owner: string;
  /** Database name on DoltHub */
  database: string;
  /** Branch to operate on (default: 'main') */
  branch?: string;
  /** DoltHub API token (format: "dhat.v1.xxx"). Falls back to DOLTHUB_TOKEN env var */
  token?: string;
  /** API base URL (default: 'https://www.dolthub.com') */
  apiBase?: string;
}

export class DoltHubError extends Error {
  constructor(
    message: string,
    public status: number,
    public responseBody?: unknown,
  ) {
    super(message);
    this.name = 'DoltHubError';
  }
}

export class DoltHubClient {
  private readonly owner: string;
  private readonly database: string;
  readonly branch: string;
  private readonly token: string | undefined;
  private readonly apiBase: string;

  constructor(config: DoltHubConfig) {
    this.owner = config.owner;
    this.database = config.database;
    this.branch = config.branch ?? 'main';
    this.token = config.token ?? (typeof process !== 'undefined' ? process.env?.DOLTHUB_TOKEN : undefined);
    this.apiBase = (config.apiBase ?? 'https://www.dolthub.com').replace(/\/$/, '');
  }

  // ----------------------------------------------------------
  // Read queries
  // ----------------------------------------------------------

  /**
   * Execute a read-only SQL query against the database.
   * Returns rows as plain objects and column names.
   */
  async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[]; columns: string[] }> {
    const url = `${this.apiBase}/api/v1alpha1/${this.owner}/${this.database}/${this.branch}?q=${encodeURIComponent(sql)}`;
    const response = await this.fetch(url, { method: 'GET' });
    const data = await this.parseResponse(response);

    // DoltHub read API returns { query_execution_status: "Success", rows: [...], schema: [...] }
    const rows = (data.rows ?? []) as T[];
    const columns = Array.isArray(data.schema)
      ? (data.schema as Array<{ columnName: string }>).map(s => s.columnName)
      : [];

    return { rows, columns };
  }

  // ----------------------------------------------------------
  // Write queries (async with polling)
  // ----------------------------------------------------------

  /**
   * Execute a write SQL statement (INSERT, UPDATE, DELETE, CREATE TABLE, etc.).
   * Writes go through the async write endpoint — we poll until complete.
   */
  async execute(sql: string): Promise<{ affectedRows: number; message: string }> {
    // POST to write endpoint — same branch for from and to
    const url = `${this.apiBase}/api/v1alpha1/${this.owner}/${this.database}/write/${this.branch}/${this.branch}?q=${encodeURIComponent(sql)}`;
    const response = await this.fetch(url, { method: 'POST' });
    const data = await this.parseResponse(response);

    // Write returns an operation_name for polling
    const operationName = data.operation_name as string | undefined;
    if (!operationName) {
      // Some writes may complete synchronously
      return this.parseWriteResult(data);
    }

    // Poll until done
    return this.pollOperation(operationName);
  }

  // ----------------------------------------------------------
  // Branch management
  // ----------------------------------------------------------

  /**
   * Create a new branch from an existing ref.
   */
  async createBranch(name: string, fromRef?: string): Promise<void> {
    const url = `${this.apiBase}/api/v1alpha1/${this.owner}/${this.database}/branches`;
    const body: Record<string, string> = {
      branchName: name,
      revisionType: 'branch',
      revision: fromRef ?? this.branch,
    };

    const response = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new DoltHubError(`Failed to create branch '${name}': ${text}`, response.status);
    }
  }

  /**
   * List all branches in the database.
   */
  async listBranches(): Promise<string[]> {
    const url = `${this.apiBase}/api/v1alpha1/${this.owner}/${this.database}/branches`;
    const response = await this.fetch(url, { method: 'GET' });
    const data = await this.parseResponse(response);

    // Response is an array of branch objects with .name
    if (Array.isArray(data)) {
      return data.map((b: Record<string, unknown>) => b.name as string);
    }
    return [];
  }

  /**
   * Merge source branch into target branch.
   * Uses the write endpoint with no query — DoltHub interprets this as a merge.
   */
  async mergeBranch(source: string, target: string): Promise<void> {
    const url = `${this.apiBase}/api/v1alpha1/${this.owner}/${this.database}/write/${target}/${source}`;
    const response = await this.fetch(url, { method: 'POST' });
    const data = await this.parseResponse(response);

    const operationName = data.operation_name as string | undefined;
    if (operationName) {
      await this.pollOperation(operationName);
    }
  }

  // ----------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string>),
    };

    if (this.token) {
      headers['authorization'] = `token ${this.token}`;
    }

    return globalThis.fetch(url, { ...init, headers });
  }

  private async parseResponse(response: Response): Promise<Record<string, unknown>> {
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => 'unknown error');
      }
      throw new DoltHubError(
        `DoltHub API error (${response.status}): ${JSON.stringify(body)}`,
        response.status,
        body,
      );
    }

    return response.json() as Promise<Record<string, unknown>>;
  }

  private async pollOperation(
    operationName: string,
    intervalMs = 500,
    timeoutMs = 60_000,
  ): Promise<{ affectedRows: number; message: string }> {
    const deadline = Date.now() + timeoutMs;
    const pollUrl = `${this.apiBase}/api/v1alpha1/${this.owner}/${this.database}/write?operationName=${encodeURIComponent(operationName)}`;

    while (Date.now() < deadline) {
      await sleep(intervalMs);

      const response = await this.fetch(pollUrl, { method: 'GET' });
      const data = await this.parseResponse(response);

      if (data.done) {
        return this.parseWriteResult(data);
      }
    }

    throw new DoltHubError(
      `Write operation timed out after ${timeoutMs}ms (operation: ${operationName})`,
      408,
    );
  }

  private parseWriteResult(data: Record<string, unknown>): { affectedRows: number; message: string } {
    const message = (data.query_execution_message as string) ?? '';

    // Parse "Query OK, N rows affected" or "Query OK, N row affected"
    const match = message.match(/(\d+)\s+rows?\s+affected/i);
    const affectedRows = match ? parseInt(match[1], 10) : 0;

    return { affectedRows, message };
  }
}

// ----------------------------------------------------------
// SQL escaping helper
// ----------------------------------------------------------

/**
 * Escape a string value for safe interpolation into a SQL query.
 * Handles single quotes, backslashes, and null bytes.
 *
 * This is used for internal values (signal IDs, colony names, type strings)
 * — not arbitrary user input from the internet.
 */
export function escapeSQL(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\0/g, '\\0');
}

/**
 * Format a value for SQL interpolation.
 * Strings are quoted and escaped, numbers/booleans are literal, null/undefined become NULL.
 */
export function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return `'${escapeSQL(value)}'`;
  // Objects/arrays → JSON string
  return `'${escapeSQL(JSON.stringify(value))}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
