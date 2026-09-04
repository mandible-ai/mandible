#!/usr/bin/env tsx
// ============================================================
// Model Routing — runnable demo, no API keys required
// ============================================================
// The LLM is faked so you can watch the *routing* happen:
//
//   1. A classifier marks unlabeled tasks (complexity:high / low)
//   2. Tag routes send them to the right tier
//   3. A flaky "haiku" handler fails once; the retry escalates to "opus"
//   4. A task whose last artifact was rejected routes up on lineage
//      alone — no failure, no label, just history
//
// Ends by printing the trail each signal carries.
//
//   npm run demo:model-routing
// ============================================================

import { resolve } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import {
  mandible, FilesystemEnvironment,
  withModelRouter, withClassifier,
  byTag, byEscalation, byLineage,
  routedVia, escalationLevel, isClassified,
  type ActionHandler, type Signal,
} from '../../src/index.js';

const ENV_ROOT = resolve('/tmp/mandible-model-routing');
await rm(ENV_ROOT, { recursive: true, force: true });
await mkdir(ENV_ROOT, { recursive: true });

const env = new FilesystemEnvironment({ root: ENV_ROOT, name: 'model-routing' });

type Task = { name: string; description: string; flaky?: boolean; attempt?: number };

// ----------------------------------------------------------
// Fake "model tiers" — stand-ins for withClaudeCode({ model: 'opus' }) etc.
// ----------------------------------------------------------

const failedOnce = new Set<string>();

function tier(model: 'opus' | 'sonnet' | 'haiku'): ActionHandler<Task> {
  return async (signal, ctx) => {
    const { name, flaky } = signal.payload;

    // Haiku is cheap but gives up on flaky work the first time it sees it
    if (model === 'haiku' && flaky && !failedOnce.has(name)) {
      failedOnce.add(name);
      console.log(`  [${model}]   ✗ ${name} — failed (will escalate)`);
      throw new Error(`${model} could not complete ${name}`);
    }

    console.log(`  [${model}]   ✓ ${name}`);
    await ctx.deposit('artifact:shaped', { task: name, tier: model, attempt: signal.payload.attempt ?? 1 }, {
      causedBy: [signal.id],
    });
    await ctx.withdraw(signal.id);
  };
}

// ----------------------------------------------------------
// A fake classifier LLM: reads the prompt, returns a structured answer
// ----------------------------------------------------------

const fakeClassifierLLM = async (prompt: string) => ({
  complexity: /auth|migration|parser/i.test(prompt) ? 'high' : 'low',
});

// ----------------------------------------------------------
// Colonies
// ----------------------------------------------------------

const host = await mandible('model-routing')
  .environment(env)

  // The worker: one rule, one router, four tiers of intelligence
  .colony('worker', (c) => c
    .sense('task:ready', { unclaimed: true, minConcentration: 0.1 })
    .retry(3, 100)                                // gives escalation a second attempt
    .do('work', withModelRouter<Task>({
      classify: withClassifier<Task, { complexity: string }>({
        model: 'haiku',
        provider: fakeClassifierLLM,              // swap for 'anthropic' in real use
        prompt: (s) => `Classify this task:\n${s.payload.description}`,
        tags: (r) => [`complexity:${r.complexity}`],
        onClassified: (s, tags) => tags.length && console.log(`  [classify] ${s.payload.name} → ${tags.join(', ')}`),
      }),
      routes: [
        byLineage({ environment: env, type: 'review:changes-needed' }, tier('opus')), // history beats everything
        byEscalation(1, tier('opus')),                                                // a failed attempt routes up
        byTag('complexity:high', tier('opus')),
        byTag('complexity:low', tier('haiku')),
      ],
      fallback: tier('sonnet'),
      onRoute: (s, r) => console.log(`  [route]    ${s.payload.name} → ${r.name}`),
    }))
    .concurrency(2)
    .claim('lease', 10_000)
    .poll(300))

  // The critic: rejects the first attempt at the parser rewrite, approves everything else
  .colony('critic', (c) => c
    .sense('artifact:shaped', { unclaimed: true, minConcentration: 0.1 })
    .do('review', async (signal, ctx) => {
      const { task, tier: usedTier, attempt } = signal.payload as { task: string; tier: string; attempt: number };
      if (task === 'rewrite-parser' && attempt === 1) {
        console.log(`  [critic]   ✗ ${task} (by ${usedTier}) — changes needed, re-queuing`);
        const review = await ctx.deposit('review:changes-needed', { task, reason: 'edge cases missed' }, { causedBy: [signal.id] });
        await ctx.deposit('task:ready', { name: task, description: 'Rewrite the parser (second attempt)', attempt: 2 }, { causedBy: [review.id] });
      } else {
        console.log(`  [critic]   ✓ ${task} (by ${usedTier})`);
        await ctx.deposit('review:approved', { task, tier: usedTier }, { causedBy: [signal.id] });
      }
      await ctx.withdraw(signal.id);
    })
    .concurrency(2)
    .claim('lease', 10_000)
    .poll(300))

  .start();

// ----------------------------------------------------------
// Seed work
// ----------------------------------------------------------

const seeds: Array<{ payload: Task; tags?: string[] }> = [
  { payload: { name: 'add-auth-middleware', description: 'Add JWT auth middleware to the API' } },
  { payload: { name: 'fix-typo', description: 'Fix a typo in the README' } },
  { payload: { name: 'flaky-lint', description: 'Fix lint warnings', flaky: true } },
  { payload: { name: 'update-changelog', description: 'Add release notes' }, tags: ['complexity:low'] }, // pre-labeled, like a GitHub issue
  { payload: { name: 'rewrite-parser', description: 'Rewrite the expression parser', attempt: 1 }, tags: ['complexity:low'] }, // mislabeled — the critic will catch it
];

console.log('\nSeeding tasks…');
for (const s of seeds) {
  await env.deposit({ type: 'task:ready', payload: s.payload, meta: { deposited_by: 'seed', tags: s.tags } });
  console.log(`  seeded: ${s.payload.name}${s.tags ? ` [${s.tags.join(', ')}]` : ''}`);
}
console.log('\nRouting…');

// ----------------------------------------------------------
// Wait for every task to be approved, then show the trail
// ----------------------------------------------------------

const EXPECTED_APPROVALS = seeds.length; // rewrite-parser's first attempt is rejected, its second approved
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  const approved = await env.observe({ type: 'review:approved' });
  if (approved.length >= EXPECTED_APPROVALS) break;
  await new Promise(r => setTimeout(r, 500));
}

await host.stop();

console.log('\nTrail left on each task signal:');
const tasks = await env.history({ type: 'task:ready', includeWithdrawn: true });
for (const t of tasks.sort((a, b) => a.meta.deposited_at - b.meta.deposited_at) as Signal<Task>[]) {
  const name = `${t.payload.name}${t.payload.attempt && t.payload.attempt > 1 ? ` (attempt ${t.payload.attempt})` : ''}`;
  console.log(`  ${name.padEnd(30)} route=${routedVia(t) ?? '-'}  escalation=${escalationLevel(t)}  classified=${isClassified(t)}  tags=[${t.meta.tags?.join(', ') ?? ''}]`);
}

console.log('\nWho did the work:');
const artifacts = await env.history({ type: 'artifact:shaped', includeWithdrawn: true });
for (const a of artifacts.sort((x, y) => x.meta.deposited_at - y.meta.deposited_at)) {
  console.log(`  ${String(a.payload.task).padEnd(30)} ${a.payload.tier}${Number(a.payload.attempt) > 1 ? ` (attempt ${a.payload.attempt})` : ''}`);
}

console.log(`\nSignals live in ${ENV_ROOT}\n`);
process.exit(0);
