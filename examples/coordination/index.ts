#!/usr/bin/env tsx
// ============================================================
// Coordination — gate + barrier, no LLM
// ============================================================
// Three workers finish jobs in parallel. A barrier folds their
// results into one `batch:complete`. A gate holds `phase:report`
// at concentration 0 — present but invisible to sensors — until
// every job has been *withdrawn* (finished), then releases it.
// The reporter colony senses the released phase signal and
// summarizes the batch.
//
//   npm run demo:coordination
// ============================================================

import { resolve } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { mandible, FilesystemEnvironment, createGate, createBarrier } from '../../src/index.js';

const ENV_ROOT = resolve('/tmp/mandible-coordination');
await rm(ENV_ROOT, { recursive: true, force: true });
await mkdir(ENV_ROOT, { recursive: true });

const env = new FilesystemEnvironment({ root: ENV_ROOT, name: 'coordination' });
const t0 = Date.now();
const log = (who: string, msg: string) => console.log(`  +${String(Date.now() - t0).padStart(5)}ms  [${who.padEnd(8)}] ${msg}`);

// ----------------------------------------------------------
// Colonies
// ----------------------------------------------------------

const host = await mandible('coordination')
  .environment(env)

  .colony('worker', (c) => c
    .sense('job:ready', { unclaimed: true, minConcentration: 0.1 })
    .do('run-job', async (signal, ctx) => {
      const { job, ms } = signal.payload as { job: string; ms: number };
      log('worker', `running ${job} (${ms}ms)`);
      await new Promise(r => setTimeout(r, ms));
      await ctx.deposit('result:ready', { job, value: job.length * 7 }, { causedBy: [signal.id] });
      await ctx.withdraw(signal.id);
      log('worker', `finished ${job}`);
    })
    .concurrency(3)
    .claim('lease', 10_000)
    .poll(200))

  .colony('reporter', (c) => c
    .sense('phase:report', { unclaimed: true, minConcentration: 0.1 })   // invisible while gated
    .retry(5, 300)                                                        // in case the barrier is a poll behind the gate
    .do('report', async (signal, ctx) => {
      const [batch] = await env.observe({ type: 'batch:complete' });
      if (!batch) throw new Error('batch:complete not there yet');
      const results = batch.payload.results as Array<{ job: string; value: number }>;
      const total = results.reduce((s, r) => s + r.value, 0);
      log('reporter', `phase:report released — ${results.length} results, total=${total}`);
      log('reporter', `caused_by: ${signal.meta.caused_by?.length} signal(s) (gated original + ${results.length} job preconditions)`);
      await ctx.deposit('report:done', { total, jobs: results.map(r => r.job) }, { causedBy: [signal.id, batch.id] });
      await ctx.withdraw(signal.id);
      await ctx.withdraw(batch.id);
    })
    .concurrency(1)
    .claim('lease', 10_000)
    .poll(200))

  .start();

// ----------------------------------------------------------
// Barrier: 3 × result:ready → 1 × batch:complete
// ----------------------------------------------------------

const barrier = createBarrier({
  environment: env,
  name: 'all-results',
  trigger: 'result:ready',
  threshold: 3,
  then: {
    type: 'batch:complete',
    payload: (results) => ({ results: results.map(r => r.payload) }),
  },
  withdrawTriggers: true,
  pollInterval: 200,
});
await barrier.start();

// ----------------------------------------------------------
// Seed jobs, then gate the report phase on all of them finishing
// ----------------------------------------------------------

const gate = createGate({ environment: env, pollInterval: 300 });
await gate.start();

const jobs = [
  { job: 'compile', ms: 600 },
  { job: 'lint', ms: 200 },
  { job: 'test-suite', ms: 900 },
];
const jobIds: string[] = [];
for (const j of jobs) {
  const s = await env.deposit({ type: 'job:ready', payload: j, meta: { deposited_by: 'seed' } });
  jobIds.push(s.id);
  log('seed', `job:ready ${j.job}`);
}

const gated = await gate.deposit({
  type: 'phase:report',
  payload: { batch: 'nightly' },
  preconditions: jobIds,
  preconditionMode: 'withdrawn',
});
log('gate', `phase:report deposited at concentration ${gated.meta.concentration} — reporter can't see it yet`);

// ----------------------------------------------------------
// Wait for the report, then show what happened
// ----------------------------------------------------------

const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  const done = await env.observe({ type: 'report:done' });
  if (done.length) break;
  await new Promise(r => setTimeout(r, 200));
}

await gate.stop();
await barrier.stop();
await host.stop();

console.log(`\n  gate:    ${gate.stats.activated} activated, ${gate.stats.pending} pending`);
console.log(`  barrier: fired ${barrier.stats.fired}×`);
const [report] = await env.observe({ type: 'report:done' });
console.log(`  report:  ${JSON.stringify(report?.payload)}`);
console.log(`\nSignals live in ${ENV_ROOT}\n`);
process.exit(0);
