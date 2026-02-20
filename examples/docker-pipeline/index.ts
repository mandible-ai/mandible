#!/usr/bin/env tsx
// ============================================================
// Docker Pipeline — Colonies Running in Containers
// ============================================================
// Demonstrates the separation of concerns:
//
//   Environment = RemoteEnvironment (signals live on a WebSocket server)
//   Host        = docker() (colonies run as Docker containers)
//
// Same colony definitions, same environment — only the host
// changes from local() to docker(). The colony code doesn't
// know or care where it's running.
//
// Prerequisites:
//   1. Docker running
//   2. Build the colony image:
//        cd mandible-cloud && ./scripts/build-colony-dev.sh
//   3. Start the signal server + cloud API:
//        cd mandible-cloud
//        PORT=9090 MANDIBLE_ADMIN_KEY=your-admin-key go run ./cmd/signalserver &
//        PORT=9091 MANDIBLE_SIGNAL_SERVER_URL=ws://host.docker.internal:9090/v1/signals \
//          MANDIBLE_SIGNAL_SERVER_ADMIN_URL=http://localhost:9090 \
//          MANDIBLE_ZONE_MODE=docker MANDIBLE_ADMIN_KEY=your-admin-key \
//          go run ./cmd/cloudapi &
//
// Then run:
//   npx tsx examples/docker-pipeline/index.ts
// ============================================================

import { RemoteEnvironment } from '../../src/environments/remote/index.js';
import { mandible } from '../../src/dsl/index.js';
import { docker } from '../../src/hosts/index.js';
import type { Signal, ActionContext } from '../../src/core/types.js';

const CLOUD_API = process.env.MANDIBLE_CLOUD_API ?? 'http://localhost:9091';
const SIGNAL_SERVER = process.env.MANDIBLE_SIGNAL_SERVER ?? 'ws://localhost:9090/v1/signals';
const ADMIN_KEY = process.env.MANDIBLE_ADMIN_KEY ?? 'replace-with-your-admin-key';
const COLONY_IMAGE = process.env.MANDIBLE_COLONY_IMAGE ?? 'mandible-colony:latest';
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? '4042', 10);

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
  console.log('\n  mandible docker pipeline');
  console.log(`  cloud API:      ${CLOUD_API}`);
  console.log(`  signal server:  ${SIGNAL_SERVER}`);
  console.log(`  colony image:   ${COLONY_IMAGE}\n`);

  // Environment = where signals live (remote signal server via WebSocket)
  const env = new RemoteEnvironment({
    url: SIGNAL_SERVER,
    apiKey: ADMIN_KEY,
    project: 'docker-demo',
    name: 'signal-server',
    connectTimeout: 5_000,
  });

  await env.connect();
  console.log('  connected to signal server\n');

  // Host = where colony code runs (Docker containers via Cloud API)
  // Deploy using the DSL: same colony definitions, different host
  const deployment = await mandible('docker-pipeline')
    .environment(env)
    .host(docker({
      apiUrl: CLOUD_API,
      apiKey: ADMIN_KEY,
      image: COLONY_IMAGE,
    }))
    .colony('shaper', c => c
      .sense('task:ready', { unclaimed: true })
      .do('shape-code', async (signal: Signal, ctx: ActionContext) => {
        ctx.log(`Shaping: ${signal.payload.name}`);
        const artifact = await simulateShaping(signal.payload);
        await ctx.deposit('artifact:shaped', artifact, { causedBy: [signal.id], tags: ['needs-review'] });
        await ctx.withdraw(signal.id);
      })
      .concurrency(2)
      .claim('lease', 30_000)
      .poll(2000)
    )
    .colony('critic', c => c
      .sense('artifact:shaped', { unclaimed: true })
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
      .poll(2000)
    )
    .colony('keeper', c => c
      .sense('review:approved', { unclaimed: true })
      .do('merge-artifact', async (signal: Signal, ctx: ActionContext) => {
        const artifact = (signal.payload as any).artifact ?? {};
        ctx.log(`Merging: ${artifact.task}`);
        const result = await simulateMerge(artifact);
        await ctx.deposit('task:complete', result, { causedBy: [signal.id], tags: ['complete'] });
        await ctx.withdraw(signal.id);
      })
      .concurrency(1)
      .claim('exclusive')
      .poll(2000)
    )
    .deploy({ port: DASHBOARD_PORT, image: COLONY_IMAGE });

  console.log(`  colonies deployed to Docker containers`);
  for (const c of deployment.colonies) {
    console.log(`    + ${c.name} (zone: ${c.zoneId ?? 'local'})`);
  }

  // Seed tasks
  console.log('\n  seeding tasks...\n');
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
  console.log('  colonies are running in Docker containers');
  console.log('  signals flow: seed -> shaper(container) -> critic(container) -> keeper(container)');
  console.log('  press Ctrl+C to stop\n');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n  tearing down...');
    await deployment.teardown();
  };

  process.on('SIGINT', async () => {
    await shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
