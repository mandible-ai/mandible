import { resolve } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { FilesystemEnvironment } from './src/environments/filesystem/index.js';
import { colony } from './src/dsl/index.js';
import type { Signal, ActionContext } from './src/core/types.js';

const ENV_ROOT = resolve('/tmp/mandible-dashboard');

// Clean slate on startup
await rm(ENV_ROOT, { recursive: true, force: true });
await mkdir(ENV_ROOT, { recursive: true });

const env = new FilesystemEnvironment({ root: ENV_ROOT, name: 'demo' });

// ── Simulated work ──────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

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

// ── Colonies ────────────────────────────────────────────────

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

// ── Seed tasks after a short delay ──────────────────────────

setTimeout(async () => {
  const tasks = [
    { name: 'auth-middleware', priority: 'high', description: 'Add JWT authentication' },
    { name: 'rate-limiter', priority: 'medium', description: 'API rate limiting' },
    { name: 'health-check', priority: 'low', description: 'Add /health endpoint' },
    { name: 'error-handler', priority: 'high', description: 'Global error handling' },
    { name: 'request-logger', priority: 'medium', description: 'Structured logging' },
  ];
  for (const task of tasks) {
    await env.deposit({ type: 'task:ready', payload: task, meta: { deposited_by: 'seed', tags: [task.priority] } });
  }
}, 2000);

export default {
  environment: env,
  colonies: [shaper, critic, keeper],
  dashboard: { port: 4040, open: true },
};
