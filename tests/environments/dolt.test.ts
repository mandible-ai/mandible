// PURPOSE: Tests for the Dolt environment adapter (DoltHub HTTP API)
// PURPOSE: Mocks globalThis.fetch to simulate DoltHub API responses

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DoltEnvironment } from '../../src/environments/dolt/adapter.js';
import { DoltHubClient, escapeSQL, sqlValue } from '../../src/environments/dolt/client.js';
import type { Signal } from '../../src/core/types.js';

// ----------------------------------------------------------
// Fetch mock infrastructure
// ----------------------------------------------------------

type FetchFn = typeof globalThis.fetch;
let originalFetch: FetchFn;
let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

/** Captured SQL queries from write requests (for assertion) */
let capturedQueries: string[] = [];

/** Rows returned by the mock dolt_diff table function */
let diffRows: Record<string, unknown>[] = [];

/** In-memory signal store backing the mock */
let signalStore: Record<string, Record<string, unknown>>;

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as Response;
}

/**
 * Set up a "realistic" fetch mock that simulates the DoltHub API.
 * Reads query from signals in signalStore, writes update signalStore.
 */
function setupRealisticMock() {
  fetchMock.mockImplementation(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = _init?.method ?? 'GET';

    // Extract SQL from query param
    const urlObj = new URL(url);
    const sql = urlObj.searchParams.get('q') ?? '';

    // Read endpoint: GET /api/v1alpha1/{owner}/{db}/{branch}?q=...
    if (method === 'GET' && url.includes('/api/v1alpha1/') && !url.includes('/write') && !url.includes('/branches') && sql) {
      return handleReadQuery(sql);
    }

    // Write endpoint: POST /api/v1alpha1/{owner}/{db}/write/...?q=...
    if (method === 'POST' && url.includes('/write/') && sql) {
      capturedQueries.push(sql);
      return handleWriteQuery(sql);
    }

    // Poll endpoint: GET /api/v1alpha1/{owner}/{db}/write?operationName=...
    if (method === 'GET' && url.includes('/write?operationName=')) {
      // Return done immediately for test speed
      return makeResponse({ done: true, query_execution_message: 'Query OK, 0 rows affected.' });
    }

    // Branches: GET
    if (method === 'GET' && url.includes('/branches')) {
      return makeResponse([{ name: 'main' }]);
    }

    // Branches: POST
    if (method === 'POST' && url.includes('/branches')) {
      return makeResponse({ status: 'ok' });
    }

    // Merge (POST write with no query)
    if (method === 'POST' && url.includes('/write/')) {
      return makeResponse({ done: true, query_execution_message: 'Query OK, 0 rows affected.' });
    }

    return makeResponse({ error: 'unhandled mock request' }, 404);
  });
}

function handleReadQuery(sql: string): Response {
  const upper = sql.toUpperCase();

  if (upper.includes('FROM DOLT_DIFF')) {
    return makeResponse({
      query_execution_status: 'Success',
      rows: diffRows,
      schema: [],
    });
  }

  if (upper.includes('FROM SIGNALS')) {
    const allSignals = Object.values(signalStore);
    let filtered = allSignals;

    // Parse basic WHERE conditions
    if (upper.includes('WITHDRAWN = FALSE') || upper.includes('WITHDRAWN=FALSE')) {
      filtered = filtered.filter(s => !s.withdrawn);
    }
    if (!upper.includes('WITHDRAWN = FALSE') && !upper.includes('WITHDRAWN=FALSE') && !upper.includes('WHERE 1=1') && upper.includes('WHERE')) {
      // If no withdrawn filter, include all
    }

    // Type LIKE filter
    const typeLikeMatch = sql.match(/type LIKE '([^']+)'/i);
    if (typeLikeMatch) {
      const pattern = typeLikeMatch[1].replace(/%/g, '.*').replace(/_/g, '.');
      const regex = new RegExp(`^${pattern}$`);
      filtered = filtered.filter(s => regex.test(s.type as string));
    }

    // unclaimed filter
    if (upper.includes('CLAIMED_BY IS NULL')) {
      filtered = filtered.filter(s => !s.claimed_by);
    }

    // concentration filter
    const concMatch = sql.match(/concentration >= (\d+\.?\d*)/i);
    if (concMatch) {
      const min = parseFloat(concMatch[1]);
      filtered = filtered.filter(s => Number(s.concentration) >= min);
    }

    // LIMIT
    const limitMatch = sql.match(/LIMIT (\d+)/i);
    if (limitMatch) {
      filtered = filtered.slice(0, parseInt(limitMatch[1], 10));
    }

    // Sort by concentration DESC
    if (upper.includes('ORDER BY CONCENTRATION DESC')) {
      filtered.sort((a, b) => Number(b.concentration) - Number(a.concentration));
    }

    return makeResponse({
      query_execution_status: 'Success',
      rows: filtered,
      schema: [
        { columnName: 'id' }, { columnName: 'type' }, { columnName: 'payload' },
        { columnName: 'deposited_at' }, { columnName: 'deposited_by' },
        { columnName: 'concentration' }, { columnName: 'ttl' },
        { columnName: 'claimed_by' }, { columnName: 'claimed_at' },
        { columnName: 'claim_lease' }, { columnName: 'caused_by' },
        { columnName: 'tags' }, { columnName: 'withdrawn' },
      ],
    });
  }

  return makeResponse({ query_execution_status: 'Success', rows: [], schema: [] });
}

function handleWriteQuery(sql: string): Response {
  const upper = sql.toUpperCase();

  // CREATE TABLE — skip
  if (upper.includes('CREATE TABLE')) {
    return makeResponse({
      done: true,
      query_execution_message: 'Query OK, 0 rows affected.',
    });
  }

  // INSERT INTO signals
  if (upper.includes('INSERT INTO SIGNALS')) {
    const valuesMatch = sql.match(/VALUES\s*\((.+)\)/is);
    if (valuesMatch) {
      const values = parseValues(valuesMatch[1]);
      const signal: Record<string, unknown> = {
        id: values[0], type: values[1], payload: values[2],
        deposited_at: values[3], deposited_by: values[4],
        concentration: values[5], ttl: values[6],
        caused_by: values[7], tags: values[8],
        withdrawn: values[9] === 'FALSE' ? false : Boolean(values[9]),
        claimed_by: null, claimed_at: null, claim_lease: null,
      };
      signalStore[signal.id as string] = signal;
      return makeResponse({
        done: true,
        query_execution_message: 'Query OK, 1 row affected.',
      });
    }
  }

  // UPDATE signals SET withdrawn = TRUE WHERE id = ...
  if (upper.includes('SET WITHDRAWN = TRUE') && upper.includes('WHERE ID =')) {
    const idMatch = sql.match(/WHERE id = '([^']+)'/i);
    if (idMatch && signalStore[idMatch[1]]) {
      signalStore[idMatch[1]].withdrawn = true;
      return makeResponse({
        done: true,
        query_execution_message: 'Query OK, 1 row affected.',
      });
    }
    return makeResponse({
      done: true,
      query_execution_message: 'Query OK, 0 rows affected.',
    });
  }

  // UPDATE signals SET claimed_by = ... (claim)
  if (upper.includes('SET CLAIMED_BY =') && !upper.includes('CLAIMED_BY = NULL')) {
    const idMatch = sql.match(/WHERE id = '([^']+)'/i);
    const claimantMatch = sql.match(/SET claimed_by = '([^']+)'/i);
    const claimedAtMatch = sql.match(/claimed_at = (\d+)/i);
    const leaseMatch = sql.match(/claim_lease = (\d+)/i);

    if (idMatch && claimantMatch) {
      const signal = signalStore[idMatch[1]];
      if (signal && !signal.withdrawn) {
        const now = Number(claimedAtMatch?.[1] ?? Date.now());
        // Check if unclaimed or lease expired
        if (!signal.claimed_by || (signal.claimed_at && signal.claim_lease &&
            (Number(signal.claimed_at) + Number(signal.claim_lease)) < now)) {
          signal.claimed_by = claimantMatch[1];
          signal.claimed_at = now;
          signal.claim_lease = Number(leaseMatch?.[1] ?? 60000);
          return makeResponse({
            done: true,
            query_execution_message: 'Query OK, 1 row affected.',
          });
        }
      }
      return makeResponse({
        done: true,
        query_execution_message: 'Query OK, 0 rows affected.',
      });
    }
  }

  // UPDATE signals SET claimed_by = NULL (release)
  if (upper.includes('CLAIMED_BY = NULL') && upper.includes('CLAIMED_AT = NULL')) {
    // Check for expired claims release (decay)
    if (upper.includes('CLAIMED_AT + CLAIM_LEASE')) {
      let count = 0;
      for (const signal of Object.values(signalStore)) {
        if (signal.claimed_by && signal.claimed_at && signal.claim_lease) {
          const now = Number(sql.match(/< (\d+)/)?.[1] ?? Date.now());
          if ((Number(signal.claimed_at) + Number(signal.claim_lease)) < now) {
            signal.claimed_by = null;
            signal.claimed_at = null;
            signal.claim_lease = null;
            count++;
          }
        }
      }
      return makeResponse({
        done: true,
        query_execution_message: `Query OK, ${count} rows affected.`,
      });
    }

    // Single release by ID
    const idMatch = sql.match(/WHERE id = '([^']+)'/i);
    if (idMatch && signalStore[idMatch[1]]) {
      signalStore[idMatch[1]].claimed_by = null;
      signalStore[idMatch[1]].claimed_at = null;
      signalStore[idMatch[1]].claim_lease = null;
      return makeResponse({
        done: true,
        query_execution_message: 'Query OK, 1 row affected.',
      });
    }
  }

  // UPDATE signals SET payload/tags/concentration WHERE id = ... AND withdrawn = FALSE
  if (upper.includes('SET') && !upper.includes('WITHDRAWN = TRUE') && !upper.includes('CLAIMED_BY') && upper.includes('WHERE ID =') && upper.includes('WITHDRAWN = FALSE')) {
    const idMatch = sql.match(/WHERE id = '([^']+)'/i);
    if (idMatch) {
      const signal = signalStore[idMatch[1]];
      if (signal && !signal.withdrawn) {
        // Parse SET clauses
        const payloadMatch = sql.match(/payload = '(.+?)'/i);
        if (payloadMatch) {
          signal.payload = payloadMatch[1];
        }
        const tagsMatch = sql.match(/tags = '(.+?)'/i);
        if (tagsMatch) {
          signal.tags = tagsMatch[1];
        }
        const concMatch = sql.match(/concentration = (\d+\.?\d*)/i);
        if (concMatch) {
          signal.concentration = parseFloat(concMatch[1]);
        }
        return makeResponse({
          done: true,
          query_execution_message: 'Query OK, 1 row affected.',
        });
      }
      return makeResponse({
        done: true,
        query_execution_message: 'Query OK, 0 rows affected.',
      });
    }
  }

  // Decay evaporate (SET withdrawn = TRUE WHERE ... concentration/ttl condition)
  if (upper.includes('SET WITHDRAWN = TRUE') && upper.includes('WITHDRAWN = FALSE') && (upper.includes('0.05') || upper.includes('TTL'))) {
    let count = 0;
    for (const signal of Object.values(signalStore)) {
      if (signal.withdrawn) continue;
      const now = Number(sql.match(/(\d{13,})/)?.[1] ?? Date.now());
      const elapsed = (now - Number(signal.deposited_at)) / 1000;
      const decayedConc = Number(signal.concentration) - (0.01 * elapsed);

      if (decayedConc < 0.05 || (signal.ttl != null && (Number(signal.deposited_at) + Number(signal.ttl)) < now)) {
        signal.withdrawn = true;
        count++;
      }
    }
    return makeResponse({
      done: true,
      query_execution_message: `Query OK, ${count} rows affected.`,
    });
  }

  // Decay update concentration
  if (upper.includes('SET CONCENTRATION = GREATEST')) {
    let count = 0;
    for (const signal of Object.values(signalStore)) {
      if (signal.withdrawn) continue;
      const now = Number(sql.match(/(\d{13,})/)?.[1] ?? Date.now());
      const elapsed = (now - Number(signal.deposited_at)) / 1000;
      const newConc = Math.max(0, Number(signal.concentration) - (0.01 * elapsed));
      if (Math.abs(newConc - Number(signal.concentration)) > 0.001) {
        signal.concentration = newConc;
        count++;
      }
    }
    return makeResponse({
      done: true,
      query_execution_message: `Query OK, ${count} rows affected.`,
    });
  }

  // Default: success with 0 rows
  return makeResponse({
    done: true,
    query_execution_message: 'Query OK, 0 rows affected.',
  });
}

/** Naive SQL VALUES parser — handles strings, numbers, NULL, TRUE/FALSE */
function parseValues(raw: string): (string | number | null)[] {
  const results: (string | number | null)[] = [];
  let i = 0;
  while (i < raw.length) {
    // Skip whitespace and commas
    while (i < raw.length && (raw[i] === ' ' || raw[i] === ',' || raw[i] === '\n')) i++;
    if (i >= raw.length) break;

    if (raw[i] === "'") {
      // String value — find matching close quote (handling escaped quotes)
      i++; // skip opening quote
      let value = '';
      while (i < raw.length) {
        if (raw[i] === '\\' && i + 1 < raw.length) {
          value += raw[i + 1];
          i += 2;
        } else if (raw[i] === "'") {
          i++;
          break;
        } else {
          value += raw[i];
          i++;
        }
      }
      results.push(value);
    } else if (raw.slice(i, i + 4).toUpperCase() === 'NULL') {
      results.push(null);
      i += 4;
    } else if (raw.slice(i, i + 4).toUpperCase() === 'TRUE') {
      results.push('TRUE');
      i += 4;
    } else if (raw.slice(i, i + 5).toUpperCase() === 'FALSE') {
      results.push('FALSE');
      i += 5;
    } else {
      // Number
      let numStr = '';
      while (i < raw.length && raw[i] !== ',' && raw[i] !== ')' && raw[i] !== ' ') {
        numStr += raw[i];
        i++;
      }
      results.push(Number(numStr));
    }
  }
  return results;
}

// ----------------------------------------------------------
// Test setup
// ----------------------------------------------------------

let env: DoltEnvironment;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn<FetchFn>();
  globalThis.fetch = fetchMock;
  signalStore = {};
  capturedQueries = [];
  diffRows = [];

  setupRealisticMock();

  env = new DoltEnvironment({
    owner: 'test-owner',
    database: 'test-db',
    branch: 'main',
    token: 'test-token',
    apiBase: 'https://mock.dolthub.com',
    name: 'test-dolt',
    pollInterval: 50, // fast polling for tests
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function depositTask(name: string, opts: Partial<{ tags: string[]; ttl: number; concentration: number }> = {}): Promise<Signal> {
  return env.deposit({
    type: 'task:ready',
    payload: { name },
    meta: {
      deposited_by: 'test',
      ...opts,
    },
  });
}

// ── SQL helpers ─────────────────────────────────────────────

describe('escapeSQL', () => {
  it('escapes single quotes', () => {
    expect(escapeSQL("it's")).toBe("it\\'s");
  });

  it('escapes backslashes', () => {
    expect(escapeSQL('a\\b')).toBe('a\\\\b');
  });

  it('escapes null bytes', () => {
    expect(escapeSQL('a\0b')).toBe('a\\0b');
  });

  it('leaves safe strings unchanged', () => {
    expect(escapeSQL('hello_world')).toBe('hello_world');
  });
});

describe('sqlValue', () => {
  it('wraps strings in quotes', () => {
    expect(sqlValue('hello')).toBe("'hello'");
  });

  it('returns numbers as-is', () => {
    expect(sqlValue(42)).toBe('42');
  });

  it('returns NULL for null/undefined', () => {
    expect(sqlValue(null)).toBe('NULL');
    expect(sqlValue(undefined)).toBe('NULL');
  });

  it('returns TRUE/FALSE for booleans', () => {
    expect(sqlValue(true)).toBe('TRUE');
    expect(sqlValue(false)).toBe('FALSE');
  });

  it('JSON-stringifies objects', () => {
    expect(sqlValue({ a: 1 })).toBe("'{\"a\":1}'");
  });
});

// ── Client ──────────────────────────────────────────────────

describe('DoltHubClient', () => {
  let client: DoltHubClient;

  beforeEach(() => {
    client = new DoltHubClient({
      owner: 'test-owner',
      database: 'test-db',
      branch: 'main',
      token: 'test-token',
      apiBase: 'https://mock.dolthub.com',
    });
  });

  it('sends auth header with token', async () => {
    await client.query('SELECT 1');
    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>)?.authorization).toBe('token test-token');
  });

  it('parses read query rows', async () => {
    signalStore['sig_1'] = {
      id: 'sig_1', type: 'task:ready', payload: '{"name":"test"}',
      deposited_at: Date.now(), deposited_by: 'tester',
      concentration: 1.0, ttl: null, claimed_by: null,
      claimed_at: null, claim_lease: null, caused_by: null,
      tags: null, withdrawn: false,
    };

    const result = await client.query('SELECT * FROM signals WHERE withdrawn = FALSE');
    expect(result.rows).toHaveLength(1);
    expect((result.rows[0] as Record<string, unknown>).id).toBe('sig_1');
  });

  it('parses affected rows from write response', async () => {
    const result = await client.execute(
      "INSERT INTO signals (id) VALUES ('test')",
    );
    // Our mock returns "1 row affected" for INSERTs
    expect(result.affectedRows).toBe(1);
  });

  it('polls operation until done', async () => {
    // Override mock to simulate async write with polling
    let pollCount = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/write/') && !url.includes('operationName')) {
        return makeResponse({ operation_name: 'op_123' });
      }

      if (url.includes('operationName=op_123')) {
        pollCount++;
        if (pollCount >= 2) {
          return makeResponse({
            done: true,
            query_execution_message: 'Query OK, 3 rows affected.',
          });
        }
        return makeResponse({ done: false });
      }

      return makeResponse({});
    });

    const result = await client.execute('UPDATE signals SET concentration = 0.5');
    expect(result.affectedRows).toBe(3);
    expect(pollCount).toBe(2);
  });

  it('lists branches', async () => {
    const branches = await client.listBranches();
    expect(branches).toContain('main');
  });
});

// ── Constructor ─────────────────────────────────────────────

describe('DoltEnvironment — constructor', () => {
  it('uses provided name', () => {
    expect(env.name).toBe('test-dolt');
  });

  it('falls back to dolt:{owner}/{db}/{branch} when name not provided', () => {
    const e = new DoltEnvironment({
      owner: 'myorg',
      database: 'signals',
    });
    expect(e.name).toBe('dolt:myorg/signals/main');
  });
});

// ── deposit ─────────────────────────────────────────────────

describe('deposit', () => {
  it('returns a signal with generated id and meta', async () => {
    const signal = await depositTask('auth');

    expect(signal.id).toMatch(/^sig_/);
    expect(signal.type).toBe('task:ready');
    expect(signal.payload).toEqual({ name: 'auth' });
    expect(signal.meta.deposited_by).toBe('test');
    expect(signal.meta.concentration).toBe(1.0);
  });

  it('stores signal in remote database (mock)', async () => {
    const signal = await depositTask('stored');

    // Verify it was stored in our mock store
    expect(signalStore[signal.id]).toBeDefined();
    expect(signalStore[signal.id].type).toBe('task:ready');
  });

  it('applies optional meta fields', async () => {
    const signal = await env.deposit({
      type: 'task:ready',
      payload: { name: 'tagged' },
      meta: {
        deposited_by: 'shaper',
        ttl: 5000,
        tags: ['urgent'],
        caused_by: ['sig_parent'],
        concentration: 0.8,
      },
    });

    expect(signal.meta.deposited_by).toBe('shaper');
    expect(signal.meta.ttl).toBe(5000);
    expect(signal.meta.tags).toEqual(['urgent']);
    expect(signal.meta.caused_by).toEqual(['sig_parent']);
    expect(signal.meta.concentration).toBe(0.8);
  });

  it('rejects invalid signal type', async () => {
    await expect(
      env.deposit({ type: '', payload: {}, meta: { deposited_by: 'test' } }),
    ).rejects.toThrow('non-empty string');
  });

  it('rejects null payload', async () => {
    await expect(
      env.deposit({ type: 'x', payload: null as any, meta: { deposited_by: 'test' } }),
    ).rejects.toThrow('plain object');
  });

  it('rejects array payload', async () => {
    await expect(
      env.deposit({ type: 'x', payload: [] as any, meta: { deposited_by: 'test' } }),
    ).rejects.toThrow('plain object');
  });
});

// ── observe ─────────────────────────────────────────────────

describe('observe', () => {
  it('returns signals matching type query', async () => {
    await depositTask('a');
    await depositTask('b');
    await env.deposit({ type: 'review:done', payload: {}, meta: { deposited_by: 'test' } });

    const tasks = await env.observe({ type: 'task:ready' });
    expect(tasks).toHaveLength(2);
    expect(tasks.every(s => s.type === 'task:ready')).toBe(true);
  });

  it('supports glob patterns', async () => {
    await depositTask('a');
    await env.deposit({ type: 'task:done', payload: {}, meta: { deposited_by: 'test' } });
    await env.deposit({ type: 'review:done', payload: {}, meta: { deposited_by: 'test' } });

    const allTasks = await env.observe({ type: 'task:*' });
    expect(allTasks).toHaveLength(2);
  });

  it('returns all signals when no query filter', async () => {
    await depositTask('a');
    await depositTask('b');
    const all = await env.observe({});
    expect(all).toHaveLength(2);
  });

  it('respects limit', async () => {
    await depositTask('a');
    await depositTask('b');
    await depositTask('c');

    const limited = await env.observe({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('filters by unclaimed', async () => {
    const s1 = await depositTask('unclaimed');
    const s2 = await depositTask('claimed');
    await env.claim(s2.id, 'shaper');

    const unclaimed = await env.observe({ type: 'task:ready', unclaimed: true });
    expect(unclaimed).toHaveLength(1);
    expect(unclaimed[0].id).toBe(s1.id);
  });

  it('returns empty for no matches', async () => {
    await depositTask('a');
    const none = await env.observe({ type: 'review:*' });
    expect(none).toEqual([]);
  });
});

// ── withdraw ────────────────────────────────────────────────

describe('withdraw', () => {
  it('marks signal as withdrawn', async () => {
    const signal = await depositTask('to-withdraw');
    await env.withdraw(signal.id);

    const active = await env.snapshot();
    expect(active.find(s => s.id === signal.id)).toBeUndefined();
  });

  it('does not throw for nonexistent signal', async () => {
    await expect(env.withdraw('sig_nonexistent')).resolves.toBeUndefined();
  });
});

// ── update ──────────────────────────────────────────────────

describe('update', () => {
  it('merges payload via SQL UPDATE', async () => {
    const signal = await depositTask('merge-test');
    const updated = await env.update(signal.id, { payload: { enriched: true } });

    expect(updated.payload).toHaveProperty('name', 'merge-test');
    expect(updated.payload).toHaveProperty('enriched', true);
  });

  it('updates tags via SQL UPDATE', async () => {
    const signal = await depositTask('tag-test');
    const updated = await env.update(signal.id, { meta: { tags: ['new', 'fresh'] } });

    expect(updated.meta.tags).toEqual(['new', 'fresh']);
  });

  it('updates concentration via SQL UPDATE', async () => {
    const signal = await depositTask('conc-test');
    const updated = await env.update(signal.id, { meta: { concentration: 0.7 } });

    expect(updated.meta.concentration).toBe(0.7);
  });

  it('throws for nonexistent signal', async () => {
    // Ensure init
    await depositTask('init');

    await expect(
      env.update('sig_nonexistent', { payload: { x: 1 } })
    ).rejects.toThrow('not found');
  });

  it('throws for withdrawn signal', async () => {
    const signal = await depositTask('will-withdraw');
    await env.withdraw(signal.id);

    await expect(
      env.update(signal.id, { payload: { x: 1 } })
    ).rejects.toThrow('not found');
  });
});

// ── claim / release ─────────────────────────────────────────

describe('claim', () => {
  it('successfully claims an unclaimed signal', async () => {
    const signal = await depositTask('claimable');
    const result = await env.claim(signal.id, 'shaper');
    expect(result).toBe(true);
  });

  it('updates signal with claim info', async () => {
    const signal = await depositTask('meta-update');
    await env.claim(signal.id, 'shaper', 30_000);

    const signals = await env.observe({ type: 'task:ready' });
    const claimed = signals.find(s => s.id === signal.id)!;
    expect(claimed.meta.claimed_by).toBe('shaper');
    expect(claimed.meta.claimed_at).toBeGreaterThan(0);
    expect(claimed.meta.claim_lease).toBe(30_000);
  });

  it('rejects second claim on same signal', async () => {
    const signal = await depositTask('contested');
    await env.claim(signal.id, 'shaper', 60_000);
    const second = await env.claim(signal.id, 'critic');
    expect(second).toBe(false);
  });

  it('allows claim takeover when lease has expired', async () => {
    const signal = await depositTask('expiring');
    // Claim with a 1ms lease
    await env.claim(signal.id, 'shaper', 1);

    // Small delay to ensure lease expires
    await new Promise(r => setTimeout(r, 10));

    const takeover = await env.claim(signal.id, 'critic', 30_000);
    expect(takeover).toBe(true);
  });
});

describe('release', () => {
  it('clears claim meta on the signal', async () => {
    const signal = await depositTask('clear-meta');
    await env.claim(signal.id, 'shaper');
    await env.release(signal.id);

    const signals = await env.observe({ type: 'task:ready' });
    const released = signals.find(s => s.id === signal.id)!;
    expect(released.meta.claimed_by).toBeUndefined();
    expect(released.meta.claimed_at).toBeUndefined();
    expect(released.meta.claim_lease).toBeUndefined();
  });

  it('does not throw for unclaimed signal', async () => {
    const signal = await depositTask('never-claimed');
    await expect(env.release(signal.id)).resolves.toBeUndefined();
  });

  it('does not throw for nonexistent signal', async () => {
    await expect(env.release('sig_ghost')).resolves.toBeUndefined();
  });
});

// ── watch ───────────────────────────────────────────────────

describe('watch', () => {
  it('emits existing signals on subscribe', async () => {
    const s1 = await depositTask('existing');

    const received: Signal[] = [];
    const sub = env.watch({ type: 'task:ready' }, (signal) => {
      received.push(signal);
    });

    // Give the initial async poll time to run
    await new Promise(r => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(s1.id);

    sub.unsubscribe();
  });

  it('emits new signals on subsequent polls', async () => {
    const received: Signal[] = [];
    const sub = env.watch({ type: 'task:ready' }, (signal) => {
      received.push(signal);
    });

    // Wait for initial poll
    await new Promise(r => setTimeout(r, 100));
    const beforeCount = received.length;

    // Deposit a new signal
    await depositTask('new-signal');

    // Wait for next poll cycle
    await new Promise(r => setTimeout(r, 150));

    expect(received.length).toBeGreaterThan(beforeCount);

    sub.unsubscribe();
  });

  it('stops emitting after unsubscribe', async () => {
    const received: Signal[] = [];
    const sub = env.watch({ type: 'task:ready' }, (signal) => {
      received.push(signal);
    });

    await new Promise(r => setTimeout(r, 100));
    sub.unsubscribe();

    const countAfterUnsub = received.length;
    await depositTask('after-unsub');
    await new Promise(r => setTimeout(r, 200));

    expect(received.length).toBe(countAfterUnsub);
  });
});

// ── history ─────────────────────────────────────────────────

describe('history', () => {
  it('returns active signals by default', async () => {
    await depositTask('active');

    const result = await env.history({ type: 'task:ready' });
    expect(result).toHaveLength(1);
  });

  it('includes withdrawn signals when includeWithdrawn is true', async () => {
    const signal = await depositTask('will-withdraw');
    await env.withdraw(signal.id);

    const activeOnly = await env.history({ type: 'task:ready' });
    expect(activeOnly).toHaveLength(0);

    const withWithdrawn = await env.history({ type: 'task:ready', includeWithdrawn: true });
    expect(withWithdrawn).toHaveLength(1);
    expect(withWithdrawn[0].id).toBe(signal.id);
  });

  it('respects limit', async () => {
    await depositTask('a');
    await depositTask('b');
    await depositTask('c');

    const limited = await env.history({ limit: 2 });
    expect(limited).toHaveLength(2);
  });
});

// ── branch diffs ────────────────────────────────────────────

describe('diffBranch', () => {
  it('maps added, modified, and removed Dolt diff rows to signals', async () => {
    const base = {
      type: 'task:ready',
      payload: '{"name":"task"}',
      deposited_at: 1,
      deposited_by: 'test',
      concentration: 1,
      ttl: null,
      claimed_by: null,
      claimed_at: null,
      claim_lease: null,
      caused_by: null,
      tags: '["reviewed"]',
    };
    diffRows = [
      Object.fromEntries([
        ...Object.entries({ id: 'sig_added', ...base }).map(([key, value]) => [`to_${key}`, value]),
        ['diff_type', 'added'],
      ]),
      Object.fromEntries([
        ...Object.entries({ id: 'sig_modified', ...base, payload: '{"name":"updated"}' })
          .map(([key, value]) => [`to_${key}`, value]),
        ['diff_type', 'modified'],
      ]),
      Object.fromEntries([
        ...Object.entries({ id: 'sig_removed', ...base }).map(([key, value]) => [`from_${key}`, value]),
        ['diff_type', 'removed'],
      ]),
    ];

    const result = await env.diffBranch('main', 'feature/review');

    expect(result.map(signal => signal.id)).toEqual([
      'sig_added',
      'sig_modified',
      'sig_removed',
    ]);
    expect(result[1].payload).toEqual({ name: 'updated' });
    expect(result[2].meta.tags).toEqual(['reviewed']);
  });
});

// ── decay ───────────────────────────────────────────────────

describe('decay', () => {
  it('evaporates expired signals (TTL)', async () => {
    await env.deposit({
      type: 'task:ready',
      payload: { name: 'expiring' },
      meta: { deposited_by: 'test', ttl: 1 },
    });

    await new Promise(r => setTimeout(r, 10));

    const result = await env.decay();
    expect(result.evaporated).toBeGreaterThanOrEqual(1);

    const remaining = await env.snapshot();
    expect(remaining).toHaveLength(0);
  });

  it('releases expired claims', async () => {
    const signal = await depositTask('claimed-expiring');
    await env.claim(signal.id, 'shaper', 1);

    await new Promise(r => setTimeout(r, 10));

    const result = await env.decay();
    expect(result.claimsReleased).toBeGreaterThanOrEqual(1);

    const signals = await env.observe({ type: 'task:ready' });
    const updated = signals.find(s => s.id === signal.id);
    expect(updated?.meta.claimed_by).toBeUndefined();
  });

  it('returns zero counts when nothing to decay', async () => {
    const result = await env.decay();
    expect(result.decayed).toBe(0);
    expect(result.evaporated).toBe(0);
    expect(result.claimsReleased).toBe(0);
  });
});

// ── snapshot ────────────────────────────────────────────────

describe('snapshot', () => {
  it('returns all active signals', async () => {
    await depositTask('a');
    await depositTask('b');
    await depositTask('c');

    const snap = await env.snapshot();
    expect(snap).toHaveLength(3);
  });

  it('does not include withdrawn signals', async () => {
    const signal = await depositTask('will-go');
    await env.withdraw(signal.id);

    const snap = await env.snapshot();
    expect(snap.find(s => s.id === signal.id)).toBeUndefined();
  });

  it('returns empty array for fresh environment', async () => {
    const snap = await env.snapshot();
    expect(snap).toEqual([]);
  });
});

// ── serialization ───────────────────────────────────────────

describe('serialize', () => {
  it('returns config with type dolt', () => {
    const config = env.serialize();
    expect(config.type).toBe('dolt');
    expect(config.owner).toBe('test-owner');
    expect(config.database).toBe('test-db');
    expect(config.name).toBe('test-dolt');
  });
});
