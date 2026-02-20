#!/usr/bin/env tsx
// ============================================================
// Remote Pipeline Integration Test
// ============================================================
// Runs the code-pipeline demo against a remote signal server
// instead of the local filesystem. Proves Vertical Slice 1:
//
//   1. Start the Go signal server (must be running separately)
//   2. Colonies connect via RemoteEnvironment (WebSocket)
//   3. Dashboard shows real-time events
//   4. Signals flow through the network, not the filesystem
//
// Prerequisites:
//   cd /path/to/mandible-cloud
//   MANDIBLE_DEV_API_KEY=your-api-key MANDIBLE_DEV_PROJECT=demo go run ./cmd/signalserver
//
// Then run this:
//   npx tsx examples/remote-pipeline/index.ts
// ============================================================

import { RemoteEnvironment } from '../../src/environments/remote/index.js';
import { colony } from '../../src/dsl/index.js';
import { createRuntime } from '../../src/core/runtime.js';
import { EventBus } from '../../src/core/events.js';
import { startDevServer } from '../../src/cli/server.js';
import type { Signal, ActionContext, ColonyDefinition } from '../../src/core/types.js';

const SIGNAL_SERVER_URL = process.env.MANDIBLE_SIGNAL_SERVER ?? 'ws://localhost:8080/v1/signals';
const API_KEY = process.env.MANDIBLE_API_KEY ?? 'replace-with-your-api-key';
const PROJECT = process.env.MANDIBLE_PROJECT ?? 'demo';
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? '4040', 10);

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Simulated work ──────────────────────────────────────────

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

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log('\n  mandible remote pipeline test');
  console.log(`  signal server: ${SIGNAL_SERVER_URL}`);
  console.log(`  project: ${PROJECT}\n`);

  // Create the remote environment
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

  // Define colonies against the remote environment
  const shaper = colony('shaper')
    .in(env)
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
    .build();

  const critic = colony('critic')
    .in(env)
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
    .build();

  const keeper = colony('keeper')
    .in(env)
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
    .build();

  // Start the dashboard pointing at the remote environment
  const config = {
    environment: env,
    colonies: [shaper, critic, keeper] as ColonyDefinition[],
    dashboard: { port: DASHBOARD_PORT, open: true },
  };

  await startDevServer(config, { port: DASHBOARD_PORT, open: true });

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
