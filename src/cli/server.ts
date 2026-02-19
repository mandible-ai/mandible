// ============================================================
// Dashboard Server — HTTP + WebSocket for real-time observability
// ============================================================

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { ColonyRuntime, createRuntime } from '../core/runtime.js';
import { EventBus, type RuntimeEventData } from '../core/events.js';
import type { ColonyDefinition, Environment } from '../core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface MandibleConfig {
  environment: Environment;
  colonies: ColonyDefinition[];
  dashboard?: {
    port?: number;
    open?: boolean;
  };
}

export interface DevServerOptions {
  port: number;
  open: boolean;
}

export async function startDevServer(
  config: MandibleConfig,
  options: DevServerOptions
): Promise<void> {
  const eventBus = new EventBus();
  const runtimes: ColonyRuntime[] = [];

  // Create runtimes with shared event bus
  for (const colonyDef of config.colonies) {
    const runtime = createRuntime(colonyDef, { eventBus });
    runtimes.push(runtime);
  }

  // Collect recent events for reconnecting clients
  const recentEvents: RuntimeEventData[] = [];
  const MAX_RECENT = 500;

  eventBus.on((event) => {
    recentEvents.push(event);
    if (recentEvents.length > MAX_RECENT) {
      recentEvents.splice(0, recentEvents.length - MAX_RECENT);
    }
  });

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
        const signals = await config.environment.snapshot();
        sendJson(res, { signals });
      } else if (url.pathname === '/api/colonies') {
        const colonies = runtimes.map(rt => ({
          name: rt.name,
          state: rt.state,
          activeCount: rt.activeCount,
          concurrency: rt.concurrency,
          stats: rt.stats,
        }));
        sendJson(res, { colonies });
      } else if (url.pathname === '/api/stats') {
        const stats = runtimes.map(rt => ({
          name: rt.name,
          ...rt.stats,
        }));
        sendJson(res, { stats });
      } else if (url.pathname === '/api/events') {
        sendJson(res, { events: recentEvents });
      } else if (url.pathname === '/api/signals' && req.method === 'POST') {
        const body = await readBody(req);
        const { type, payload, tags } = JSON.parse(body);
        const signal = await config.environment.deposit({
          type,
          payload: payload ?? {},
          meta: {
            deposited_by: 'dashboard',
            tags,
          },
        });
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

  // WebSocket server
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket) => {
    // Send recent events on connect for catchup
    ws.send(JSON.stringify({ type: 'init', events: recentEvents.slice(-100) }));
  });

  // Forward runtime events to all connected WebSocket clients
  eventBus.on((event) => {
    const message = JSON.stringify({ type: 'event', data: event });
    for (const client of wss.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    }
  });

  // Periodic snapshot broadcast (for concentration decay animation)
  const snapshotInterval = setInterval(async () => {
    try {
      const signals = await config.environment.snapshot();
      const message = JSON.stringify({ type: 'snapshot', signals });
      for (const client of wss.clients) {
        if (client.readyState === 1) {
          client.send(message);
        }
      }
    } catch { /* ignore snapshot errors */ }
  }, 2000);

  // Start HTTP server
  server.listen(options.port, () => {
    console.log(`  dashboard: http://localhost:${options.port}`);
  });

  // Start all colony runtimes
  console.log(`  starting ${runtimes.length} colonies...`);
  for (const runtime of runtimes) {
    await runtime.start();
    console.log(`    + ${runtime.name} [running]`);
  }
  console.log('');

  // Auto-open browser
  if (options.open) {
    const url = `http://localhost:${options.port}`;
    try {
      const { exec } = await import('node:child_process');
      const cmd = process.platform === 'darwin' ? 'open' :
                  process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${cmd} ${url}`);
    } catch { /* ignore open errors */ }
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n  shutting down...');
    clearInterval(snapshotInterval);

    for (const runtime of runtimes) {
      await runtime.stop();
      console.log(`    - ${runtime.name} [stopped]`);
    }

    wss.close();
    server.close();
    console.log('  done.\n');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
