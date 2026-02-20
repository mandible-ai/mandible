#!/usr/bin/env tsx
// ============================================================
// Docker Pipeline — Colonies Running in Containers
// ============================================================
// Deploys colonies as Docker containers via the Mandible Cloud API.
// Each colony runs in its own container, connected to the signal
// server over WebSocket. The dashboard shows real-time coordination.
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
import { startDevServer } from '../../src/cli/server.js';
import { colony } from '../../src/dsl/index.js';
import type { Signal, ActionContext, ColonyDefinition } from '../../src/core/types.js';

const CLOUD_API = process.env.MANDIBLE_CLOUD_API ?? 'http://localhost:9091';
const SIGNAL_SERVER = process.env.MANDIBLE_SIGNAL_SERVER ?? 'ws://localhost:9090/v1/signals';
const ADMIN_KEY = process.env.MANDIBLE_ADMIN_KEY ?? 'replace-with-your-admin-key';
const COLONY_IMAGE = process.env.MANDIBLE_COLONY_IMAGE ?? 'mandible-colony:latest';
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? '4042', 10);

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${CLOUD_API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${ADMIN_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API ${method} ${path} failed (${res.status}): ${err}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function waitForZones(projectId: string, expected: number, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const zones = await api('GET', `/v1/projects/${projectId}/zones`) as any[];
    const running = zones.filter((z: any) => z.state === 'running');
    if (running.length >= expected) return zones;
    process.stdout.write('.');
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${expected} zones to reach running state`);
}

// ── Simulated work (used by the local dashboard colonies) ───

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
  console.log('\n  mandible docker pipeline');
  console.log(`  cloud API:      ${CLOUD_API}`);
  console.log(`  signal server:  ${SIGNAL_SERVER}`);
  console.log(`  colony image:   ${COLONY_IMAGE}\n`);

  // 1. Create project via Cloud API
  console.log('  creating project...');
  const project = await api('POST', '/v1/projects', { name: `docker-demo-${Date.now()}` }) as any;
  const projectId = project.id;
  console.log(`  project: ${projectId}\n`);

  // 2. Deploy 3 colonies as Docker containers
  console.log('  deploying colonies as Docker containers...');
  const deployResult = await api('POST', `/v1/projects/${projectId}/deploy`, {
    colonies: [
      {
        name: 'shaper',
        image: COLONY_IMAGE,
        concurrency: 2,
        claimStrategy: 'lease',
        sensors: [{ query: { type: 'task:ready' }, pollInterval: 2000 }],
      },
      {
        name: 'critic',
        image: COLONY_IMAGE,
        concurrency: 2,
        claimStrategy: 'lease',
        sensors: [{ query: { type: 'artifact:shaped' }, pollInterval: 2000 }],
      },
      {
        name: 'keeper',
        image: COLONY_IMAGE,
        concurrency: 1,
        claimStrategy: 'exclusive',
        sensors: [{ query: { type: 'review:approved' }, pollInterval: 2000 }],
      },
    ],
  }) as any;

  console.log(`  deployed ${deployResult.colonies.length} colonies:`);
  for (const c of deployResult.colonies) {
    console.log(`    + ${c.name} (zone: ${c.zoneId})`);
  }

  // 3. Wait for all zones to reach running state
  process.stdout.write('\n  waiting for containers');
  const zones = await waitForZones(projectId, 3);
  console.log(` done!`);
  for (const z of zones as any[]) {
    console.log(`    ${z.colony}: ${z.state} (uptime: ${z.uptimeSeconds}s)`);
  }

  // 4. Connect to signal server for dashboard + seeding
  const env = new RemoteEnvironment({
    url: SIGNAL_SERVER,
    apiKey: ADMIN_KEY,
    project: projectId,
    name: 'dashboard',
    connectTimeout: 5_000,
  });
  await env.connect();

  // 5. Start local dashboard (connects to same signal server for event relay)
  // Define local "ghost" colonies for the dashboard to track names
  // (these don't actually run — the real colonies are in Docker)
  const ghostShaper = colony('shaper').in(env)
    .sense('task:ready', { unclaimed: true })
    .do('shape', async (s: Signal, ctx: ActionContext) => {
      ctx.log(`Shaping: ${s.payload.name}`);
      const artifact = await simulateShaping(s.payload);
      await ctx.deposit('artifact:shaped', artifact, { causedBy: [s.id], tags: ['needs-review'] });
      await ctx.withdraw(s.id);
    })
    .concurrency(2).claim('lease', 30_000).poll(1500).build();

  const ghostCritic = colony('critic').in(env)
    .sense('artifact:shaped', { unclaimed: true })
    .do('review', async (s: Signal, ctx: ActionContext) => {
      ctx.log(`Reviewing: ${s.payload.task}`);
      const review = await simulateReview(s.payload);
      if (review.approved) {
        await ctx.deposit('review:approved', { artifact: s.payload, feedback: review.feedback }, { causedBy: [s.id], tags: ['ready-to-merge'] });
      } else {
        await ctx.deposit('review:rejected', { artifact: s.payload, feedback: review.feedback }, { causedBy: [s.id], tags: ['needs-rework'], ttl: 60_000 });
      }
      await ctx.withdraw(s.id);
    })
    .concurrency(2).claim('lease', 30_000).poll(1500).build();

  const ghostKeeper = colony('keeper').in(env)
    .sense('review:approved', { unclaimed: true })
    .do('merge', async (s: Signal, ctx: ActionContext) => {
      const artifact = (s.payload as any).artifact ?? {};
      ctx.log(`Merging: ${artifact.task}`);
      const result = await simulateMerge(artifact);
      await ctx.deposit('task:complete', result, { causedBy: [s.id], tags: ['complete'] });
      await ctx.withdraw(s.id);
    })
    .concurrency(1).claim('exclusive').poll(1500).build();

  await startDevServer(
    {
      environment: env,
      colonies: [ghostShaper, ghostCritic, ghostKeeper] as ColonyDefinition[],
      dashboard: { port: DASHBOARD_PORT, open: true },
    },
    { port: DASHBOARD_PORT, open: true },
  );

  // 6. Seed tasks
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

  // Graceful shutdown: teardown zones on exit
  const shutdown = async () => {
    console.log('\n  tearing down...');
    try {
      const zoneList = await api('GET', `/v1/projects/${projectId}/zones`) as any[];
      for (const z of zoneList) {
        if (z.state !== 'destroyed' && z.state !== 'destroying') {
          await api('DELETE', `/v1/projects/${projectId}/colonies/${z.colony}`);
          console.log(`    destroyed: ${z.colony}`);
        }
      }
    } catch (err: any) {
      console.error(`    teardown error: ${err.message}`);
    }
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
