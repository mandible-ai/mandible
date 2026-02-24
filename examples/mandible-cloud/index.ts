#!/usr/bin/env tsx
// ============================================================
// Code Pipeline — Cloud Signal Server Relay
// ============================================================
// Runs colonies locally with a filesystem environment while
// relaying events to a Mandible Cloud signal server for remote
// dashboard observability.
//
// Usage:
//   MANDIBLE_API_KEY=mk_... MANDIBLE_PROJECT=proj_... npx tsx examples/mandible-cloud/index.ts
// ============================================================

import { resolve } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import WebSocket from 'ws';
import { mandible, FilesystemEnvironment, LocalHost } from '../../src/index.js';
import { shaper, critic, keeper, SEED_TASKS } from '../code-pipeline/colonies.js';

const API_KEY = process.env.MANDIBLE_API_KEY;
const PROJECT = process.env.MANDIBLE_PROJECT;
const SIGNAL_SERVER_URL = process.env.MANDIBLE_SIGNAL_SERVER ?? 'wss://api.mandible.cloud/v1/signals';

if (!API_KEY || !PROJECT) {
  console.error('Required env vars: MANDIBLE_API_KEY, MANDIBLE_PROJECT');
  console.error('Optional: MANDIBLE_SIGNAL_SERVER (default: wss://api.mandible.cloud/v1/signals)');
  process.exit(1);
}

const ENV_ROOT = resolve('/tmp/mandible-cloud-demo');
await rm(ENV_ROOT, { recursive: true, force: true });
await mkdir(ENV_ROOT, { recursive: true });

const env = new FilesystemEnvironment({ root: ENV_ROOT, name: 'code-pipeline' });

// Connect to signal server for event relay
function connectSignalServer(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SIGNAL_SERVER_URL);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', apiKey: API_KEY, project: PROJECT }));
    });
    ws.on('message', (raw: Buffer | string) => {
      let msg: any;
      try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
      if (msg.type === 'authenticated') {
        console.log('Connected to signal server');
        resolve(ws);
      } else if (msg.type === 'error' && msg.code === 'AUTH_FAILED') {
        reject(new Error('Auth failed'));
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Signal server connection timeout')), 10_000);
  });
}

console.log(`Connecting to ${SIGNAL_SERVER_URL}...`);
const ws = await connectSignalServer();

// Start colonies via mandible DSL
const host = await mandible('cloud-relay-demo')
  .environment(env)
  .colony('shaper', shaper)
  .colony('critic', critic)
  .colony('keeper', keeper)
  .start();

console.log(`Started ${host.colonies.length} colonies, relaying to cloud dashboard`);
console.log(`Environment: ${ENV_ROOT}\n`);

// Relay runtime events to signal server via LocalHost eventBus
const localHost = host as unknown as LocalHost;
if (localHost.eventBus) {
  localHost.eventBus.on((event: any) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'event', data: event }));
    }
  });
}

// Seed tasks
for (const task of SEED_TASKS) {
  await env.deposit({
    type: 'task:ready',
    payload: task,
    meta: { deposited_by: 'seed', tags: [task.priority] },
  });
  console.log(`  seeded: task:ready "${task.name}"`);
}

console.log('\nColonies working. Open the cloud console to watch.\nPress Ctrl+C to stop.\n');

process.on('SIGINT', async () => {
  await host.stop();
  ws.close();
  console.log('Stopped.');
  process.exit(0);
});

await new Promise(() => {});
