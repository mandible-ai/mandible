#!/usr/bin/env tsx
// PURPOSE: Seed script for the Scout colony — deposits a scan:trigger and runs the colony.
// PURPOSE: Usage: npx tsx examples/repo-maintenance/seed.ts [/path/to/repo]

import { resolve } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { FilesystemEnvironment } from '../../src/environments/filesystem/index.js';
import { createRuntime } from '../../src/core/runtime.js';
import { createScoutColony } from './scout.js';

const ENV_ROOT = resolve('/tmp/mandible-repo-maintenance');
const TARGET_REPO = resolve(process.argv[2] ?? process.cwd());

async function main() {
  // 1. Set up fresh environment
  await rm(ENV_ROOT, { recursive: true, force: true });
  await mkdir(ENV_ROOT, { recursive: true });

  console.log(`\nScout Colony — Repo Maintenance`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`  Environment: ${ENV_ROOT}`);
  console.log(`  Target repo: ${TARGET_REPO}`);
  console.log(`${'─'.repeat(50)}\n`);

  const env = new FilesystemEnvironment({ root: ENV_ROOT, name: 'repo-maintenance' });

  // 2. Create Scout colony
  const scoutDef = createScoutColony(env, TARGET_REPO);
  const runtime = createRuntime(scoutDef as any, {
    decayPolicy: { rate: 0.001, interval: 30_000 },
  });

  // 3. Deposit scan trigger
  console.log('Depositing scan:trigger signal...');
  const trigger = await env.deposit({
    type: 'scan:trigger',
    payload: {
      scope: 'full',
      triggered_by: 'seed-script',
    },
    meta: { deposited_by: 'seed' },
  });
  console.log(`  -> ${trigger.type} (${trigger.id})\n`);

  // 4. Start runtime
  console.log('Starting Scout colony...\n');
  await runtime.start();

  // 5. Wait for scan to complete
  const maxWaitMs = 5 * 60_000; // 5 minutes max
  const pollMs = 2_000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const signals = await env.observe({ type: 'scan:completed' });
    if (signals.length > 0) {
      console.log('\nScan completed!');
      break;
    }

    // Also check for errors
    const errors = await env.observe({ type: 'scan:error' });
    if (errors.length > 0) {
      console.error('\nScan encountered an error:');
      for (const e of errors) {
        console.error(JSON.stringify(e.payload, null, 2));
      }
      break;
    }

    await sleep(pollMs);
  }

  // 6. Report results
  console.log('\n' + '='.repeat(50));
  console.log('  Results');
  console.log('='.repeat(50) + '\n');

  const issues = await env.observe({ type: 'issue:detected' });
  if (issues.length === 0) {
    console.log('  No issues detected.\n');
  } else {
    console.log(`  Found ${issues.length} issue(s):\n`);
    for (const issue of issues) {
      const p = issue.payload as Record<string, unknown>;
      const severity = String(p.severity ?? 'unknown').toUpperCase();
      console.log(`  [${severity}] ${p.title}`);
      console.log(`    Category: ${p.category}`);
      console.log(`    Files: ${(p.files as string[])?.join(', ') || 'n/a'}`);
      console.log(`    ${p.description}`);
      if (p.suggested_fix) console.log(`    Fix: ${p.suggested_fix}`);
      console.log('');
    }
  }

  const summaries = await env.observe({ type: 'scan:completed' });
  if (summaries.length > 0) {
    const summary = summaries[0].payload as Record<string, unknown>;
    console.log(`  Cost: $${Number(summary.costUsd ?? 0).toFixed(4)}`);
    console.log(`  Duration: ${Number(summary.durationMs ?? 0)}ms`);
    console.log(`  Issues found: ${summary.issueCount}`);
  }

  console.log(`\n  Runtime stats:`);
  console.log(`    Signals processed: ${runtime.stats.signalsProcessed}`);
  console.log(`    Signals deposited: ${runtime.stats.signalsDeposited}`);
  console.log(`    Errors: ${runtime.stats.errors}`);

  // 7. Stop
  await runtime.stop();
  console.log('\nDone.\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
