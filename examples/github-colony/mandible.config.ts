// PURPOSE: GitHub colony example — Golem tablets as stigmergy signals
// PURPOSE: Run: GITHUB_TOKEN=ghp_... npx tsx examples/github-colony/mandible.config.ts

import { mandible } from '../../src/dsl/mandible.js';
import { GitHubEnvironment } from '../../src/environments/github/index.js';
import type { Signal, ActionContext } from '../../src/core/types.js';

// ----------------------------------------------------------
// Config from environment variables
// ----------------------------------------------------------

const OWNER = process.env.GITHUB_OWNER ?? 'your-org';
const REPO = process.env.GITHUB_REPO ?? 'your-repo';
const POLL_INTERVAL = 30_000;

if (!process.env.GITHUB_TOKEN) {
  console.error('\n  GITHUB_TOKEN is required.');
  console.error('  Usage: GITHUB_TOKEN=ghp_... npx tsx examples/github-colony/mandible.config.ts\n');
  process.exit(1);
}

// ----------------------------------------------------------
// Environment — GitHub IS the stigmergy substrate
// ----------------------------------------------------------

const env = new GitHubEnvironment({
  owner: OWNER,
  repo: REPO,
  pollInterval: POLL_INTERVAL,
  labels: ['golem'],
  allowWithdraw: false,
  decayRate: 0.001,
});

// ----------------------------------------------------------
// Start colonies via mandible DSL
// ----------------------------------------------------------

const host = await mandible('github-colony')
  .environment(env)
  // Observer colony — senses golem tablets, logs them
  .colony('golem', c => c
    .sense('golem:*', { minConcentration: 0.05 })
    .do('log-tablet', async (signal: Signal, ctx: ActionContext) => {
      const payload = signal.payload as Record<string, unknown>;
      ctx.log(`[${signal.meta.concentration.toFixed(2)}] #${payload.number} ${payload.title}`);
    })
    .concurrency(1)
    .claim('none')
    .poll(POLL_INTERVAL)
  )
  // Watcher colony — senses all issue types for dashboard visibility
  .colony('issue-watcher', c => c
    .sense('issue:*', { minConcentration: 0.05 })
    .do('log-issue', async (signal: Signal, ctx: ActionContext) => {
      const payload = signal.payload as Record<string, unknown>;
      ctx.log(`[${signal.meta.concentration.toFixed(2)}] #${payload.number} ${payload.title}`);
    })
    .concurrency(1)
    .claim('none')
    .poll(POLL_INTERVAL)
  )
  .start();

console.log(`Started ${host.colonies.length} colonies (id: ${host.metadata.id})`);
await host.dashboard({ port: 4040 });
