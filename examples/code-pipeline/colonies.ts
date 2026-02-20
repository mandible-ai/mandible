// ============================================================
// Shared Colony Definitions — Shaper / Critic / Keeper
// ============================================================
// These colonies are reusable across any host (local, docker,
// cloud). They define *what* happens, not *where* it runs.
//
// Each colony only knows about signal types — no colony
// references any other colony. Coordination emerges from
// the shared signal environment.
// ============================================================

import type { Signal, ActionContext } from '../../src/core/types.js';
import type { ColonyBuilder } from '../../src/dsl/builder.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

// Colony configurators — passed to mandible().colony(name, configure)

export function shaper(c: ColonyBuilder) {
  return c
    .sense('task:ready', { unclaimed: true, minConcentration: 0.1 })
    .do('shape-code', async (signal: Signal, ctx: ActionContext) => {
      ctx.log(`Shaping: ${signal.payload.name}`);
      const artifact = await simulateShaping(signal.payload);
      await ctx.deposit('artifact:shaped', artifact, {
        causedBy: [signal.id],
        tags: ['needs-review'],
      });
      await ctx.withdraw(signal.id);
      ctx.log(`Shaped "${signal.payload.name}" (${artifact.linesChanged} lines)`);
    })
    .concurrency(2)
    .claim('lease', 30_000)
    .poll(1000);
}

export function critic(c: ColonyBuilder) {
  return c
    .sense('artifact:shaped', { unclaimed: true, minConcentration: 0.1 })
    .do('review-code', async (signal: Signal, ctx: ActionContext) => {
      ctx.log(`Reviewing: ${signal.payload.task}`);
      const review = await simulateReview(signal.payload);
      if (review.approved) {
        await ctx.deposit('review:approved', {
          artifact: signal.payload,
          feedback: review.feedback,
        }, {
          causedBy: [signal.id],
          tags: ['ready-to-merge'],
        });
        ctx.log(`Approved: ${review.feedback}`);
      } else {
        await ctx.deposit('review:changes-needed', {
          artifact: signal.payload,
          feedback: review.feedback,
        }, {
          causedBy: [signal.id],
          tags: ['needs-rework'],
          ttl: 60_000,
        });
        ctx.log(`Changes needed: ${review.feedback}`);
      }
      await ctx.withdraw(signal.id);
    })
    .concurrency(2)
    .claim('lease', 30_000)
    .poll(1000);
}

export function keeper(c: ColonyBuilder) {
  return c
    .sense('review:approved', { unclaimed: true, minConcentration: 0.1 })
    .do('merge-artifact', async (signal: Signal, ctx: ActionContext) => {
      const artifact = (signal.payload as Record<string, any>).artifact ?? {};
      ctx.log(`Merging: ${artifact.task}`);
      const result = await simulateMerge(artifact);
      await ctx.deposit('artifact:merged', result, {
        causedBy: [signal.id],
        tags: ['complete'],
      });
      await ctx.withdraw(signal.id);
      ctx.log(`Merged -> commit ${result.commitHash}`);
    })
    .concurrency(1)
    .claim('exclusive')
    .poll(1000);
}

export const SEED_TASKS = [
  { name: 'auth-middleware', priority: 'high', description: 'Add JWT authentication' },
  { name: 'rate-limiter', priority: 'medium', description: 'API rate limiting' },
  { name: 'health-check', priority: 'low', description: 'Add /health endpoint' },
  { name: 'error-handler', priority: 'high', description: 'Global error handling' },
  { name: 'request-logger', priority: 'medium', description: 'Structured logging' },
];
