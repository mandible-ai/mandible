#!/usr/bin/env tsx
// ============================================================
// Remote Pipeline — Colonies Observing a Remote Signal Server
// ============================================================
// Runs the code-pipeline demo against a remote signal server.
// Demonstrates the separation of concerns:
//
//   Environment = RemoteEnvironment (signals live on a WebSocket server)
//   Host        = local() (colonies run as local Node processes)
//
// The same colonies could run on docker() or cloud() hosts
// without changing any colony logic — only the host changes.
//
// Prerequisites:
//   cd /path/to/mandible-cloud
//   MANDIBLE_DEV_API_KEY=your-api-key MANDIBLE_DEV_PROJECT=demo go run ./cmd/signalserver
//
// Then run this:
//   npx tsx examples/remote-pipeline/index.ts
// ============================================================

import { RemoteEnvironment } from '../../src/environments/remote/index.js';
import { mandible } from '../../src/dsl/index.js';
import { local } from '../../src/hosts/index.js';
import type { Signal, ActionContext } from '../../src/core/types.js';

const SIGNAL_SERVER_URL = process.env.MANDIBLE_SIGNAL_SERVER ?? 'wss://api.mandible.dev/v1/signals';
const API_KEY = process.env.MANDIBLE_API_KEY ?? '';
const PROJECT = process.env.MANDIBLE_PROJECT ?? '';
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? '4040', 10);

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// -- Simulated work ──────────────────────────────────────────

async function simulateShaping(task: Record<string, unknown>) {
  await sleep(500 + Math.random() * 1500);
  return {
    code: `function ${task.name}() { return true; }`,
    linesChanged: Math.floor(Math.random() * 100) + 10,
    task: task.name,
  };
}

async function simulateReview(artifact: Record<string, unknown>) {
  await sleep(300 + Math.random() * 1000);
  const approved = Math.random() > 0.2;
  return {
    approved,
    feedback: approved
      ? `Code for "${artifact.task}" looks good.`
      : `Code for "${artifact.task}" needs error handling.`,
  };
}

async function simulateMerge(artifact: Record<string, unknown>) {
  await sleep(200 + Math.random() * 500);
  return { merged: true, task: artifact.task, commitHash: Math.random().toString(36).slice(2, 10) };
}

// -- Main ────────────────────────────────────────────────────

async function main() {
  console.log('\n  mandible remote pipeline');
  console.log(`  signal server: ${SIGNAL_SERVER_URL}`);
  console.log(`  project: ${PROJECT}\n`);

  // Environment = where signals live (remote signal server)
  const env = new RemoteEnvironment({
    url: SIGNAL_SERVER_URL,
    apiKey: API_KEY,
    project: PROJECT,
    name: 'remote-demo',
    connectTimeout: 5_000,
  });

  // Connect and verify
  try {
    await env.connect();
    console.log('  connected to signal server\n');
  } catch (err: any) {
    console.error(`  failed to connect: ${err.message}`);
    console.error('  make sure the signal server is running:');
    console.error('    MANDIBLE_DEV_API_KEY=your-api-key MANDIBLE_DEV_PROJECT=demo go run ./cmd/signalserver\n');
    process.exit(1);
  }

  // Host = where colony code runs (local Node processes)
  // Deploy using the DSL: environment + host are independent choices
  const deployment = await mandible('remote-pipeline')
    .environment(env)
    .host(local())
    .colony('shaper', c => c
      .sense('task:ready', { unclaimed: true, minConcentration: 0.1 })
      .do('shape-code', async (signal: Signal, ctx: ActionContext) => {
        ctx.log(`Shaping: ${signal.payload.name}`);
        const artifact = await simulateShaping(signal.payload);
        await ctx.deposit('artifact:shaped', artifact, { causedBy: [signal.id], tags: ['needs-review'] });
        await ctx.withdraw(signal.id);
      })
      .concurrency(2)
      .claim('lease', 30_000)
      .poll(1500)
    )
    .colony('critic', c => c
      .sense('artifact:shaped', { unclaimed: true, minConcentration: 0.1 })
      .do('review-code', async (signal: Signal, ctx: ActionContext) => {
        ctx.log(`Reviewing: ${signal.payload.task}`);
        const review = await simulateReview(signal.payload);
        if (review.approved) {
          await ctx.deposit('review:approved', { artifact: signal.payload, feedback: review.feedback }, { causedBy: [signal.id], tags: ['ready-to-merge'] });
        } else {
          await ctx.deposit('review:rejected', { artifact: signal.payload, feedback: review.feedback }, { causedBy: [signal.id], tags: ['needs-rework'], ttl: 60_000 });
        }
        await ctx.withdraw(signal.id);
      })
      .concurrency(2)
      .claim('lease', 30_000)
      .poll(1500)
    )
    .colony('keeper', c => c
      .sense('review:approved', { unclaimed: true, minConcentration: 0.1 })
      .do('merge-artifact', async (signal: Signal, ctx: ActionContext) => {
        const artifact = (signal.payload as any).artifact ?? {};
        ctx.log(`Merging: ${artifact.task}`);
        const result = await simulateMerge(artifact);
        await ctx.deposit('task:complete', result, { causedBy: [signal.id], tags: ['complete'] });
        await ctx.withdraw(signal.id);
      })
      .concurrency(1)
      .claim('exclusive')
      .poll(1500)
    )
    .deploy({ port: DASHBOARD_PORT });

  // Seed tasks after colonies are running
  console.log('  seeding tasks...\n');
  await sleep(2000);

  const tasks = [
    { name: 'auth-middleware', priority: 'high', description: 'Add JWT authentication' },
    { name: 'rate-limiter', priority: 'medium', description: 'API rate limiting' },
    { name: 'health-check', priority: 'low', description: 'Add /health endpoint' },
    { name: 'error-handler', priority: 'high', description: 'Global error handling' },
    { name: 'request-logger', priority: 'medium', description: 'Structured logging' },
  ];

  for (const task of tasks) {
    await env.deposit({
      type: 'task:ready',
      payload: task,
      meta: { deposited_by: 'seed', tags: [task.priority] },
    });
    console.log(`    seeded: task:ready "${task.name}"`);
  }

  console.log(`\n  dashboard: http://localhost:${DASHBOARD_PORT}`);
  console.log('  watching colonies coordinate over the network...');
  console.log('  press Ctrl+C to stop\n');

  process.on('SIGINT', async () => {
    await deployment.teardown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
