// PURPOSE: Dashboard Server — HTTP + WebSocket for real-time local observability
// PURPOSE: Data flows through DashboardSource interface — no cloud relay, no runtime coupling

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { RuntimeEventData } from '../core/events.js';
import { EventBus } from '../core/events.js';
import type { ColonyDefinition, Environment, Signal } from '../core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── DashboardSource interface ────────────────────────────────

export interface ColonyInfo {
  name: string;
  state: string;
  activeCount: number;
  concurrency: number;
  stats: {
    signalsSensed: number;
    signalsClaimed: number;
    signalsProcessed: number;
    signalsDeposited: number;
    claimConflicts: number;
    errors: number;
    avgProcessingMs: number;
  };
}

export interface DashboardSource {
  /** Subscribe to runtime events */
  onEvent(callback: (event: RuntimeEventData) => void): void;
  /** Get current signal snapshot across all environments */
  snapshot(): Promise<Signal[]>;
  /** Get colony info */
  colonies(): ColonyInfo[];
  /** Get environment names */
  environments(): string[];
  /** Deposit a signal from the dashboard inspector */
  deposit(type: string, payload: Record<string, unknown>, env?: string, tags?: string[]): Promise<Signal>;
  /** Events buffered before dashboard started */
  readonly bufferedEvents: RuntimeEventData[];
  /** Cleanup */
  close(): void;
}

// ── LocalDashboardSource ─────────────────────────────────────

export class LocalDashboardSource implements DashboardSource {
  constructor(
    private eventBus: EventBus,
    private envs: Environment[],
    private colonyInfoFn: () => ColonyInfo[],
    private _bufferedEvents: RuntimeEventData[] = [],
  ) {}

  onEvent(cb: (event: RuntimeEventData) => void): void {
    this.eventBus.on(cb);
  }

  async snapshot(): Promise<Signal[]> {
    const all: Signal[] = [];
    for (const env of this.envs) {
      const snap = await env.snapshot();
      for (const s of snap) {
        (s as any)._environment = env.name;
        all.push(s);
      }
    }
    return all;
  }

  colonies(): ColonyInfo[] {
    return this.colonyInfoFn();
  }

  environments(): string[] {
    return this.envs.map(e => e.name);
  }

  async deposit(type: string, payload: Record<string, unknown>, env?: string, tags?: string[]): Promise<Signal> {
    const target = env
      ? this.envs.find(e => e.name === env) ?? this.envs[0]
      : this.envs[0];
    return target.deposit({
      type,
      payload,
      meta: { deposited_by: 'dashboard', tags },
    });
  }

  get bufferedEvents(): RuntimeEventData[] {
    return this._bufferedEvents;
  }

  close(): void {
    /* no-op for local */
  }
}

// ── resolveEnvironments ──────────────────────────────────────

export interface SimpleConfig {
  environment?: Environment;
  environments?: Environment[];
  colonies: ColonyDefinition[];
}

/**
 * Resolve environments from config with 3-tier fallback:
 *   1. Explicit environments[] array
 *   2. Singular environment field
 *   3. Auto-discover from colony definitions (deduplicated by name)
 */
export function resolveEnvironments(config: SimpleConfig): Environment[] {
  if (config.environments && config.environments.length > 0) {
    return config.environments;
  }
  if (config.environment) {
    return [config.environment];
  }
  // Auto-discover from colony definitions
  const envMap = new Map<string, Environment>();
  for (const colony of config.colonies) {
    envMap.set(colony.environment.name, colony.environment);
  }
  return Array.from(envMap.values());
}

// ── startDashboard ───────────────────────────────────────────

export interface DashboardOptions {
  port: number;
  open: boolean;
}

export async function startDashboard(
  source: DashboardSource,
  options: DashboardOptions,
): Promise<void> {
  const recentEvents: RuntimeEventData[] = [...source.bufferedEvents];
  const MAX_RECENT = 500;

  function pushEvent(event: RuntimeEventData): void {
    recentEvents.push(event);
    if (recentEvents.length > MAX_RECENT) {
      recentEvents.splice(0, recentEvents.length - MAX_RECENT);
    }
  }

  // Pipe source events into recent events
  source.onEvent((event) => pushEvent(event));

  // HTTP server
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost:${options.port}`);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (url.pathname === '/api/state') {
        const signals = await source.snapshot();
        sendJson(res, { signals });

      } else if (url.pathname === '/api/colonies') {
        sendJson(res, { colonies: source.colonies() });

      } else if (url.pathname === '/api/stats') {
        const stats = source.colonies().map(c => ({
          name: c.name,
          ...c.stats,
        }));
        sendJson(res, { stats });

      } else if (url.pathname === '/api/environments') {
        sendJson(res, { environments: source.environments().map(name => ({ name })) });

      } else if (url.pathname === '/api/events') {
        sendJson(res, { events: recentEvents });

      } else if (url.pathname === '/api/signals' && req.method === 'POST') {
        const body = await readBody(req);
        const { type, payload, tags, environment: envName } = JSON.parse(body);
        const signal = await source.deposit(type, payload ?? {}, envName, tags);
        sendJson(res, { signal }, 201);

      } else if (url.pathname === '/' || url.pathname === '/index.html') {
        await serveDashboard(res);

      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    } catch (err: any) {
      console.error('Server error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  // WebSocket server for dashboard UI clients
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: 'init', events: recentEvents.slice(-100) }));
  });

  // Forward source events to all connected WebSocket clients
  source.onEvent((event) => {
    broadcastToClients(wss, { type: 'event', data: event });
  });

  // Periodic snapshot broadcast (for concentration decay animation)
  const snapshotInterval = setInterval(async () => {
    try {
      const signals = await source.snapshot();
      broadcastToClients(wss, { type: 'snapshot', signals });
    } catch { /* ignore snapshot errors */ }
  }, 2000);

  // Start HTTP server
  server.listen(options.port, () => {
    console.log(`  dashboard: http://localhost:${options.port}`);
  });

  // Auto-open browser
  if (options.open) {
    const dashUrl = `http://localhost:${options.port}`;
    try {
      const { exec } = await import('node:child_process');
      const cmd = process.platform === 'darwin' ? 'open' :
                  process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${cmd} ${dashUrl}`);
    } catch { /* ignore open errors */ }
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n  shutting down...');
    clearInterval(snapshotInterval);
    source.close();
    wss.close();
    server.close();
    console.log('  done.\n');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ── Helpers ──────────────────────────────────────────────────

function broadcastToClients(wss: WebSocketServer, data: unknown): void {
  const message = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function sendJson(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function serveDashboard(res: ServerResponse) {
  try {
    const htmlPath = join(__dirname, 'dashboard.html');
    const html = await readFile(htmlPath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FALLBACK_HTML);
  }
}

const FALLBACK_HTML = `<!DOCTYPE html>
<html><head><title>mandible</title></head>
<body style="background:#1a1a2e;color:#eee;font-family:monospace;padding:2em">
<h1>mandible dashboard</h1>
<p>dashboard.html not found — rebuild the project.</p>
</body></html>`;
