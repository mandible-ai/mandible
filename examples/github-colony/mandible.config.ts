// PURPOSE: Dashboard config for GitHub colony — Golem tablets as stigmergy signals
// PURPOSE: Run: GITHUB_TOKEN=ghp_... npx tsx src/cli/index.ts dev examples/github-colony/mandible.config.ts

import { GitHubEnvironment } from '../../src/environments/github/index.js';
import { colony } from '../../src/dsl/index.js';
import type { Signal, ActionContext } from '../../src/core/types.js';

// ----------------------------------------------------------
// Config from environment variables
// ----------------------------------------------------------

const OWNER = process.env.GITHUB_OWNER ?? 'sparrowlabsdev';
const REPO = process.env.GITHUB_REPO ?? 'sis-test';
const POLL_INTERVAL = 30_000;

if (!process.env.GITHUB_TOKEN) {
  console.error('\n  GITHUB_TOKEN is required.');
  console.error('  Usage: GITHUB_TOKEN=ghp_... npx tsx src/cli/index.ts dev examples/github-colony/mandible.config.ts\n');
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
// Colonies
// ----------------------------------------------------------

// Observer colony — senses golem tablets, logs them
// In a real setup this would be replaced with a triage/planning colony
const observer = colony('golem')
  .in(env)
  .sense('golem:*', { minConcentration: 0.05 })
  .do('log-tablet', async (signal: Signal, ctx: ActionContext) => {
    const payload = signal.payload as Record<string, unknown>;
    ctx.log(`[${signal.meta.concentration.toFixed(2)}] #${payload.number} ${payload.title}`);
  })
  .concurrency(1)
  .claim('none')
  .poll(POLL_INTERVAL)
  .build();

// Watcher colony — senses all issue types for dashboard visibility
const watcher = colony('issue-watcher')
  .in(env)
  .sense('issue:*', { minConcentration: 0.05 })
  .do('log-issue', async (signal: Signal, ctx: ActionContext) => {
    const payload = signal.payload as Record<string, unknown>;
    ctx.log(`[${signal.meta.concentration.toFixed(2)}] #${payload.number} ${payload.title}`);
  })
  .concurrency(1)
  .claim('none')
  .poll(POLL_INTERVAL)
  .build();

// ----------------------------------------------------------
// Export config for mandible dev
// ----------------------------------------------------------

export default {
  environment: env,
  colonies: [observer, watcher],
  dashboard: { port: 4040, open: true },
};
