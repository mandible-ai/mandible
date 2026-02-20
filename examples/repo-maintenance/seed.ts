#!/usr/bin/env tsx
// PURPOSE: Seed script for Scout + Fixer colonies — deposits a scan:trigger and runs the pipeline.
// PURPOSE: Usage: npx tsx examples/repo-maintenance/seed.ts [/path/to/repo] [--fix]

import { resolve } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { mandible } from '../../src/dsl/mandible.js';
import { FilesystemEnvironment } from '../../src/environments/filesystem/index.js';
import { configureScout } from './scout.js';
import { configureFixer } from './fixer.js';

const ENV_ROOT = resolve('/tmp/mandible-repo-maintenance');
const args = process.argv.slice(2);
const FIX_MODE = args.includes('--fix');
const TARGET_REPO = resolve(args.find(a => !a.startsWith('--')) ?? process.cwd());

async function main() {
  // 1. Set up fresh environment
  await rm(ENV_ROOT, { recursive: true, force: true });
  await mkdir(ENV_ROOT, { recursive: true });

  console.log(`\n${FIX_MODE ? 'Scout + Fixer' : 'Scout'} Colony — Repo Maintenance`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`  Environment: ${ENV_ROOT}`);
  console.log(`  Target repo: ${TARGET_REPO}`);
  console.log(`  Fix mode:    ${FIX_MODE ? 'ON' : 'OFF (use --fix to enable)'}`);
  console.log(`${'─'.repeat(50)}\n`);

  const env = new FilesystemEnvironment({ root: ENV_ROOT, name: 'repo-maintenance' });

  // 2. Build and start colonies via mandible DSL
  const builder = mandible('repo-maintenance')
    .environment(env)
    .colony('scout', configureScout(TARGET_REPO));

  if (FIX_MODE) {
    builder.colony('fixer', configureFixer(TARGET_REPO));
  }

  const host = await builder.start();
  console.log(`Started ${host.colonies.length} colony(s) (id: ${host.metadata.id})\n`);

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

  // 4. Wait for scan to complete
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

  // 5. Report results
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

  // 5b. If fix mode, wait for fixes to complete
  if (FIX_MODE) {
    const issueCount = issues.length;
    if (issueCount > 0) {
      console.log(`\nWaiting for Fixer colony to process ${issueCount} issue(s)...`);
      const fixDeadline = Date.now() + 5 * 60_000;
      while (Date.now() < fixDeadline) {
        const proposed = await env.observe({ type: 'fix:proposed' });
        const failed = await env.observe({ type: 'fix:failed' });
        const total = proposed.length + failed.length;
        if (total >= issueCount) break;
        await sleep(pollMs);
      }

      console.log('\n' + '='.repeat(50));
      console.log('  Fix Results');
      console.log('='.repeat(50) + '\n');

      const proposed = await env.observe({ type: 'fix:proposed' });
      for (const fix of proposed) {
        const p = fix.payload as Record<string, unknown>;
        const conf = String(p.confidence ?? 'unknown').toUpperCase();
        console.log(`  [${conf}] ${p.issue_title}`);
        console.log(`    Branch: ${p.branch}`);
        console.log(`    Files: ${(p.files_changed as string[])?.join(', ') || 'n/a'}`);
        console.log(`    Tests: ${p.tests_passed ? 'PASS' : 'FAIL'}`);
        console.log(`    ${p.diff_summary}`);
        console.log('');
      }

      const failed = await env.observe({ type: 'fix:failed' });
      for (const fix of failed) {
        const p = fix.payload as Record<string, unknown>;
        console.log(`  [FAILED] ${p.issue_title}`);
        console.log(`    Reason: ${p.reason}`);
        if (p.attempted_approach) console.log(`    Approach: ${p.attempted_approach}`);
        console.log('');
      }

      console.log(`  Proposed: ${proposed.length}, Failed: ${failed.length}`);
    }
  }

  // 6. Report colony status from host metadata
  console.log('\n  Colony status:');
  for (const col of host.colonies) {
    console.log(`    ${col.name}: ${col.state}`);
  }

  // 7. Stop
  await host.stop();
  console.log('\nDone.\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
