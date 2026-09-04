// PURPOSE: mysql2 wire protocol client for Dolt — optional peer dependency
// PURPOSE: Provides lower-latency SQL access alongside the DoltHub HTTP API

export interface DoltSQLConfig {
  host: string;
  port?: number;
  user: string;
  password?: string;
  database: string;
}

export interface DoltSQLClient {
  query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[]; columns: string[] }>;
  execute(sql: string): Promise<{ affectedRows: number; message: string }>;
  close(): Promise<void>;
}

/**
 * Try to create a DoltSQLClient using mysql2/promise.
 * Returns null if mysql2 is not installed (optional peer dependency).
 */
export async function tryCreateSQLClient(config: DoltSQLConfig): Promise<DoltSQLClient | null> {
  let mysql2: any;
  try {
    // Use a variable to prevent TypeScript from resolving the module statically
    const moduleName = 'mysql2/promise';
    mysql2 = await import(moduleName);
  } catch {
    // mysql2 not installed — fall back to HTTP client
    return null;
  }

  const pool = mysql2.createPool({
    host: config.host,
    port: config.port ?? 3306,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: 5,
  });

  return {
    async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[]; columns: string[] }> {
      const [rows, fields] = await pool.query(sql);
      const columns = Array.isArray(fields)
        ? fields.map((f: any) => f.name)
        : [];
      return { rows: rows as T[], columns };
    },

    async execute(sql: string): Promise<{ affectedRows: number; message: string }> {
      const [result] = await pool.query(sql);
      const affectedRows = (result as any).affectedRows ?? 0;
      const message = (result as any).message ?? '';
      return { affectedRows, message };
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
