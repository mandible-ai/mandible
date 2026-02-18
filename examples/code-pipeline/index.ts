#!/usr/bin/env tsx
// ============================================================
// Code Pipeline Demo — Stigmergy in Action
// ============================================================
// Three colonies coordinate through a shared filesystem:
//
//   1. SHAPER — watches for task:ready signals, "writes code",
//      deposits artifact:shaped signals
//
//   2. CRITIC — watches for artifact:shaped signals, "reviews code",
//      deposits review:approved or review:changes-needed signals
//
//   3. KEEPER — watches for review:approved signals,
//      "merges" the artifact and deposits artifact:merged signals
//
// No colony knows about any other colony.
// They only interact through signals in the environment.
//
// To run:
//   npx tsx examples/code-pipeline/index.ts
//
// Then watch the signals/ directory to see stigmergy happen:
//   watch -n 0.5 'ls -la /tmp/stigmergy-demo/signals/'
// ============================================================

import { resolve } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { FilesystemEnvironment } from '../../src/environments/filesystem/index.js';
import { colony } from '../../src/dsl/index.js';
import { createRuntime } from '../../src/core/runtime.js';
import type { Signal, ActionContext } from '../../src/core/types.js';

// ----------------------------------------------------------
// Environment setup
// ----------------------------------------------------------

const ENV_ROOT = resolve('/tmp/stigmergy-demo');

async function setup() {
  // Clean slate
  await rm(ENV_ROOT, { recursive: true, force: true });
  await mkdir(ENV_ROOT, { recursive: true });
  console.log(`\n🌿 Environment root: ${ENV_ROOT}`);
  console.log(`   Watch signals: watch -n 0.5 'ls /tmp/stigmergy-demo/signals/'\n`);
}

// ----------------------------------------------------------
// Simulated work functions (replace with real LLM calls)
// ----------------------------------------------------------

async function simulateShaping(task: Record<string, unknown>): Promise<Record<string, unknown>> {
  const duration = 500 + Math.random() * 1500;
  await sleep(duration);
  return {
    code: `function ${task.name}() { /* shaped by colony */ return true; }`,
    linesChanged: Math.floor(Math.random() * 100) + 10,
    task: task.name,
  };
}

async function simulateReview(artifact: Record<string, unknown>): Promise<{ approved: boolean; feedback: string }> {
  const duration = 300 + Math.random() * 1000;
  await sleep(duration);
  // 80% approval rate
  const approved = Math.random() > 0.2;
  return {
    approved,
    feedback: approved
      ? `Code for "${artifact.task}" looks good. Clean implementation.`
      : `Code for "${artifact.task}" needs work: missing error handling.`,
  };
}

async function simulateMerge(artifact: Record<string, unknown>): Promise<Record<string, unknown>> {
  const duration = 200 + Math.random() * 500;
  await sleep(duration);
  return {
    merged: true,
    task: artifact.task,
    commitHash: Math.random().toString(36).slice(2, 10),
  };
}

// ----------------------------------------------------------
// Colony definitions
// ----------------------------------------------------------

function defineColonies(env: FilesystemEnvironment) {

  // ── SHAPER COLONY ──────────────────────────────────────
  const shaperDef = colony('shaper')
    .in(env)
    .sense('task:ready', { unclaimed: true, minConcentration: 0.1 })
    .do('shape-code', async (signal: Signal, ctx: ActionContext) => {
      ctx.log(`Picking up task: ${signal.payload.name}`);

      const artifact = await simulateShaping(signal.payload);

      // Deposit the shaped artifact — this is the pheromone trail
      await ctx.deposit('artifact:shaped', artifact, {
        causedBy: [signal.id],
        tags: ['needs-review'],
      });

      // Withdraw the task signal — it's been handled
      await ctx.withdraw(signal.id);

      ctx.log(`Shaped "${signal.payload.name}" (${artifact.linesChanged} lines)`);
    })
    .concurrency(2)
    .claim('lease', 30_000)
    .poll(1000)
    .build();

  // ── CRITIC COLONY ──────────────────────────────────────
  const criticDef = colony('critic')
    .in(env)
    .sense('artifact:shaped', { unclaimed: true, minConcentration: 0.1 })
    .do('review-code', async (signal: Signal, ctx: ActionContext) => {
      ctx.log(`Reviewing artifact for task: ${signal.payload.task}`);

      const review = await simulateReview(signal.payload);

      if (review.approved) {
        await ctx.deposit('review:approved', {
          artifact: signal.payload,
          feedback: review.feedback,
        }, {
          causedBy: [signal.id],
          tags: ['ready-to-merge'],
        });
        ctx.log(`✓ Approved: ${review.feedback}`);
      } else {
        await ctx.deposit('review:changes-needed', {
          artifact: signal.payload,
          feedback: review.feedback,
        }, {
          causedBy: [signal.id],
          tags: ['needs-rework'],
          ttl: 60_000, // expires after 1 minute if nobody picks it up
        });
        ctx.log(`✗ Changes needed: ${review.feedback}`);
      }

      // Withdraw the shaped artifact signal
      await ctx.withdraw(signal.id);
    })
    .concurrency(2)
    .claim('lease', 30_000)
    .poll(1000)
    .build();

  // ── KEEPER COLONY ──────────────────────────────────────
  const keeperDef = colony('keeper')
    .in(env)
    .sense('review:approved', { unclaimed: true, minConcentration: 0.1 })
    .do('merge-artifact', async (signal: Signal, ctx: ActionContext) => {
      const artifact = (signal.payload as Record<string, any>).artifact ?? {};
      ctx.log(`Merging approved artifact: ${artifact.task}`);

      const result = await simulateMerge(artifact);

      await ctx.deposit('artifact:merged', result, {
        causedBy: [signal.id],
        tags: ['complete'],
      });

      await ctx.withdraw(signal.id);
      ctx.log(`Merged → commit ${result.commitHash}`);
    })
    .concurrency(1)  // single keeper for serialized merges
    .claim('exclusive')
    .poll(1000)
    .build();

  return { shaperDef, criticDef, keeperDef };
}

// ----------------------------------------------------------
// Orchestration (just seeds tasks — no coordination logic!)
// ----------------------------------------------------------

async function seedTasks(env: FilesystemEnvironment) {
  const tasks = [
    { name: 'auth-middleware', priority: 'high', description: 'Add JWT authentication' },
    { name: 'rate-limiter', priority: 'medium', description: 'Implement API rate limiting' },
    { name: 'health-check', priority: 'low', description: 'Add /health endpoint' },
    { name: 'error-handler', priority: 'high', description: 'Global error handling middleware' },
    { name: 'request-logger', priority: 'medium', description: 'Structured request logging' },
  ];

  console.log('📋 Seeding tasks into environment...\n');

  for (const task of tasks) {
    const signal = await env.deposit({
      type: 'task:ready',
      payload: task,
      meta: { deposited_by: 'orchestrator', tags: [task.priority] },
    });
    console.log(`   → task:ready  "${task.name}" (${signal.id})`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log('   Colonies are now self-organizing. No further coordination.');
  console.log('─'.repeat(60) + '\n');
}

// ----------------------------------------------------------
// Main
// ----------------------------------------------------------

async function main() {
  await setup();

  const env = new FilesystemEnvironment({ root: ENV_ROOT, name: 'code-pipeline' });
  const { shaperDef, criticDef, keeperDef } = defineColonies(env);

  // Create runtimes
  const shaperRuntime = createRuntime(shaperDef, { rate: 0.005, interval: 10_000 });
  const criticRuntime = createRuntime(criticDef, { rate: 0.005, interval: 10_000 });
  const keeperRuntime = createRuntime(keeperDef, { rate: 0.005, interval: 10_000 });

  // Wire up observability
  for (const [name, rt] of [['shaper', shaperRuntime], ['critic', criticRuntime], ['keeper', keeperRuntime]] as const) {
    rt.on('signal:processed', (signal: Signal) => {
      // Just for demo visibility
    });
    rt.on('signal:claim-conflict', (signal: Signal) => {
      console.log(`   ⚡ Claim conflict in ${name}: ${signal.type}`);
    });
  }

  // Start all colonies
  console.log('🚀 Starting colonies...\n');
  await Promise.all([
    shaperRuntime.start(),
    criticRuntime.start(),
    keeperRuntime.start(),
  ]);

  // Seed tasks into the environment
  await sleep(500);
  await seedTasks(env);

  // Let the colonies work for 20 seconds
  await sleep(20_000);

  // Print final state
  console.log('\n' + '═'.repeat(60));
  console.log('   FINAL STATE');
  console.log('═'.repeat(60));

  const snapshot = await env.snapshot();
  const history = await env.history({ includeWithdrawn: true });

  console.log(`\n   Active signals: ${snapshot.length}`);
  console.log(`   Total signals processed: ${history.length}`);
  console.log(`\n   Active signals:`);
  for (const s of snapshot) {
    console.log(`     [${s.type}] ${s.payload.task ?? s.payload.name ?? '?'} (conc: ${s.meta.concentration.toFixed(2)})`);
  }

  console.log(`\n   Colony stats:`);
  console.log(`     Shaper:  ${shaperRuntime.stats.signalsProcessed} processed, ${shaperRuntime.stats.signalsDeposited} deposited, ${shaperRuntime.stats.claimConflicts} conflicts`);
  console.log(`     Critic:  ${criticRuntime.stats.signalsProcessed} processed, ${criticRuntime.stats.signalsDeposited} deposited, ${criticRuntime.stats.claimConflicts} conflicts`);
  console.log(`     Keeper:  ${keeperRuntime.stats.signalsProcessed} processed, ${keeperRuntime.stats.signalsDeposited} deposited, ${keeperRuntime.stats.claimConflicts} conflicts`);

  // Graceful shutdown
  console.log('\n🛑 Stopping colonies...');
  await Promise.all([
    shaperRuntime.stop(),
    criticRuntime.stop(),
    keeperRuntime.stop(),
  ]);

  console.log('✅ Done.\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
