// PURPOSE: Dashboard Server — HTTP + WebSocket for real-time observability
// PURPOSE: Supports local mode (direct Environment) and cloud mode (signal server relay)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { ColonyRuntime, createRuntime } from '../core/runtime.js';
import { EventBus, type RuntimeEventData } from '../core/events.js';
import type { ColonyDefinition, Environment, Signal } from '../core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface SignalServerConfig {
  url: string;
  apiKey: string;
  project: string;
}

export interface MandibleConfig {
  /** Single environment (backward compat) */
  environment?: Environment;
  /** Multiple environments — aggregated in dashboard */
  environments?: Environment[];
  signalServer?: SignalServerConfig;
  colonies: ColonyDefinition[];
  dashboard?: {
    port?: number;
    open?: boolean;
  };
  /** Pre-existing EventBus — if set, skip runtime creation (colonies already running) */
  _eventBus?: import('../core/events.js').EventBus;
  /** Pre-existing runtimes — for stats reporting when Host manages lifecycle */
  _runtimes?: ColonyRuntime[];
  /** Buffered events from before the server started */
  _bufferedEvents?: RuntimeEventData[];
}

export interface DevServerOptions {
  port: number;
  open: boolean;
}

/** Connect to signal server, authenticate, and return the WebSocket + helpers */
function connectToSignalServer(
  config: SignalServerConfig,
  callbacks: {
    onEvent: (event: RuntimeEventData) => void;
    onSnapshot: (signals: Signal[]) => void;
    onSignalPush: (signal: Signal) => void;
    onReady: () => void;
    onError: (err: Error) => void;
  },
): {
  ws: WebSocket;
  snapshot: () => void;
  deposit: (type: string, payload: Record<string, unknown>, tags?: string[]) => Promise<Signal>;
  close: () => void;
} {
  const ws = new WebSocket(config.url);

  let msgCounter = 0;
  const pendingRequests = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>();

  function nextId(): string {
    return `dash_${++msgCounter}`;
  }

  function send(msg: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function request<T>(msg: Record<string, unknown>): Promise<T> {
    const id = nextId();
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      send({ ...msg, id });
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error(`signal server request timed out: ${msg.type}`));
        }
      }, 30_000);
    });
  }

  ws.on('open', () => {
    send({ type: 'auth', apiKey: config.apiKey, project: config.project });
  });

  ws.on('message', (raw: Buffer | string) => {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch { return; }

    switch (msg.type) {
      case 'authenticated':
        // Auth succeeded — subscribe to all signals and request initial snapshot
        send({ type: 'subscribe', id: nextId(), query: { type: '*' } });
        callbacks.onReady();
        break;

      case 'result':
        if (msg.id && pendingRequests.has(msg.id)) {
          const pending = pendingRequests.get(msg.id)!;
          pendingRequests.delete(msg.id);
          pending.resolve(msg.data);
        }
        break;

      case 'error':
        if (msg.id && pendingRequests.has(msg.id)) {
          const pending = pendingRequests.get(msg.id)!;
          pendingRequests.delete(msg.id);
          pending.reject(new Error(`${msg.code}: ${msg.message}`));
        } else {
          callbacks.onError(new Error(`signal server error: ${msg.code} — ${msg.message}`));
        }
        break;

      case 'signal':
        // Subscription push — a new signal was deposited
        if (msg.signal) {
          callbacks.onSignalPush(msg.signal);
        }
        break;

      case 'event':
        // Runtime event relayed from a colony in a zone
        if (msg.data) {
          callbacks.onEvent(msg.data);
        }
        break;

      default:
        break;
    }
  });

  ws.on('error', (err) => {
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
  });

  return {
    ws,
    snapshot() {
      request<Signal[]>({ type: 'snapshot' })
        .then(signals => callbacks.onSnapshot(signals))
        .catch(() => { /* ignore snapshot errors */ });
    },
    async deposit(type: string, payload: Record<string, unknown>, tags?: string[]): Promise<Signal> {
      return request<Signal>({
        type: 'deposit',
        signal: {
          type,
          payload,
          meta: { deposited_by: 'dashboard', tags },
        },
      });
    },
    close() {
      ws.close();
    },
  };
}

/**
 * Resolve environments from config with 3-tier fallback:
 *   1. Explicit environments[] array
 *   2. Singular environment field
 *   3. Auto-discover from colony definitions (deduplicated by name)
 */
export function resolveEnvironments(config: MandibleConfig): Environment[] {
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

export async function startDevServer(
  config: MandibleConfig,
  options: DevServerOptions
): Promise<void> {
  const isCloudMode = !!config.signalServer;
  const hasExternalRuntimes = !!config._runtimes?.length;
  const eventBus = config._eventBus ?? new EventBus();
  const runtimes: ColonyRuntime[] = config._runtimes ?? [];
  const environments = isCloudMode ? [] : resolveEnvironments(config);

  // In local mode, create runtimes with shared event bus
  // Skip if external runtimes were provided (colonies already running via Host)
  if (!isCloudMode && !hasExternalRuntimes) {
    if (environments.length === 0) {
      throw new Error('MandibleConfig requires at least one environment, signalServer, or colonies with environments');
    }
    for (const colonyDef of config.colonies) {
      const runtime = createRuntime(colonyDef, { eventBus });
      runtimes.push(runtime);
    }
  }

  // Collect recent events for reconnecting clients — seed with any buffered events
  const recentEvents: RuntimeEventData[] = config._bufferedEvents ? [...config._bufferedEvents] : [];
  const MAX_RECENT = 500;

  function pushEvent(event: RuntimeEventData): void {
    recentEvents.push(event);
    if (recentEvents.length > MAX_RECENT) {
      recentEvents.splice(0, recentEvents.length - MAX_RECENT);
    }
  }

  // In local mode, pipe EventBus events into recent events
  if (!isCloudMode) {
    eventBus.on((event) => pushEvent(event));
  }

  // Signal server relay (cloud mode)
  let signalServerRelay: ReturnType<typeof connectToSignalServer> | null = null;
  let latestSnapshot: Signal[] = [];

  if (isCloudMode) {
    signalServerRelay = connectToSignalServer(config.signalServer!, {
      onEvent(event) {
        pushEvent(event);
        broadcastToClients(wss, { type: 'event', data: event });
      },
      onSnapshot(signals) {
        latestSnapshot = signals;
        broadcastToClients(wss, { type: 'snapshot', signals });
      },
      onSignalPush(signal) {
        // Update our local snapshot cache
        const idx = latestSnapshot.findIndex(s => s.id === signal.id);
        if (idx >= 0) {
          latestSnapshot[idx] = signal;
        } else {
          latestSnapshot.push(signal);
        }
      },
      onReady() {
        console.log('  connected to signal server');
        // Request initial snapshot
        signalServerRelay!.snapshot();
      },
      onError(err) {
        console.error('  signal server error:', err.message);
      },
    });
  }

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
        if (isCloudMode) {
          sendJson(res, { signals: latestSnapshot });
        } else {
          const allSignals: Signal[] = [];
          for (const env of environments) {
            const snapshot = await env.snapshot();
            // Tag each signal with its environment name for dashboard disambiguation
            for (const signal of snapshot) {
              (signal as any)._environment = env.name;
              allSignals.push(signal);
            }
          }
          sendJson(res, { signals: allSignals });
        }
      } else if (url.pathname === '/api/colonies') {
        if (isCloudMode) {
          // In cloud mode, report colony defs with placeholder state
          const colonies = config.colonies.map(c => ({
            name: c.name,
            state: 'running',
            activeCount: 0,
            concurrency: c.concurrency,
            stats: { signalsSensed: 0, signalsClaimed: 0, signalsProcessed: 0, signalsDeposited: 0, claimConflicts: 0, errors: 0, avgProcessingMs: 0 },
          }));
          sendJson(res, { colonies });
        } else {
          const colonies = runtimes.map(rt => ({
            name: rt.name,
            state: rt.state,
            activeCount: rt.activeCount,
            concurrency: rt.concurrency,
            stats: rt.stats,
          }));
          sendJson(res, { colonies });
        }
      } else if (url.pathname === '/api/stats') {
        if (isCloudMode) {
          const stats = config.colonies.map(c => ({
            name: c.name,
            signalsSensed: 0, signalsClaimed: 0, signalsProcessed: 0, signalsDeposited: 0, claimConflicts: 0, errors: 0, avgProcessingMs: 0,
          }));
          sendJson(res, { stats });
        } else {
          const stats = runtimes.map(rt => ({
            name: rt.name,
            ...rt.stats,
          }));
          sendJson(res, { stats });
        }
      } else if (url.pathname === '/api/environments') {
        sendJson(res, { environments: environments.map(e => ({ name: e.name })) });
      } else if (url.pathname === '/api/events') {
        sendJson(res, { events: recentEvents });
      } else if (url.pathname === '/api/signals' && req.method === 'POST') {
        const body = await readBody(req);
        const { type, payload, tags } = JSON.parse(body);
        if (isCloudMode) {
          const signal = await signalServerRelay!.deposit(type, payload ?? {}, tags);
          sendJson(res, { signal }, 201);
        } else {
          // Route to named environment or default to first
          const targetName = JSON.parse(body).environment;
          const targetEnv = targetName
            ? environments.find(e => e.name === targetName) ?? environments[0]
            : environments[0];
          const signal = await targetEnv.deposit({
            type,
            payload: payload ?? {},
            meta: {
              deposited_by: 'dashboard',
              tags,
            },
          });
          sendJson(res, { signal }, 201);
        }
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
    // Send recent events on connect for catchup
    ws.send(JSON.stringify({ type: 'init', events: recentEvents.slice(-100) }));
  });

  if (!isCloudMode) {
    // Forward runtime events to all connected WebSocket clients
    eventBus.on((event) => {
      broadcastToClients(wss, { type: 'event', data: event });
    });

    // Listen for remote events relayed through environments
    for (const env of environments) {
      if ('onEvent' in env && typeof (env as any).onEvent === 'function') {
        (env as any).onEvent((event: RuntimeEventData) => {
          pushEvent(event);
          broadcastToClients(wss, { type: 'event', data: event });
        });
      }
    }
  }

  // Periodic snapshot broadcast (for concentration decay animation)
  const snapshotInterval = setInterval(async () => {
    try {
      if (isCloudMode) {
        signalServerRelay!.snapshot();
      } else {
        const allSignals: Signal[] = [];
        for (const env of environments) {
          const snapshot = await env.snapshot();
          for (const signal of snapshot) {
            (signal as any)._environment = env.name;
            allSignals.push(signal);
          }
        }
        broadcastToClients(wss, { type: 'snapshot', signals: allSignals });
      }
    } catch { /* ignore snapshot errors */ }
  }, 2000);

  // Start HTTP server
  server.listen(options.port, () => {
    console.log(`  dashboard: http://localhost:${options.port}`);
  });

  if (!isCloudMode && runtimes.length > 0) {
    // Start all colony runtimes (local mode only, skipped when Host already started them)
    console.log(`  starting ${runtimes.length} colonies...`);
    for (const runtime of runtimes) {
      await runtime.start();
      console.log(`    + ${runtime.name} [running]`);
    }
    console.log('');
  } else if (isCloudMode) {
    console.log(`  cloud mode — ${config.colonies.length} colonies running in Edera zones`);
    for (const col of config.colonies) {
      console.log(`    + ${col.name} [cloud]`);
    }
    console.log('');
  }

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

    if (isCloudMode) {
      signalServerRelay?.close();
      console.log('  signal server connection closed');
    } else if (runtimes.length > 0) {
      for (const runtime of runtimes) {
        await runtime.stop();
        console.log(`    - ${runtime.name} [stopped]`);
      }
    }

    wss.close();
    server.close();
    console.log('  done.\n');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

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
