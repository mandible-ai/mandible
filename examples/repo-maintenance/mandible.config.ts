// PURPOSE: Dashboard config for repo-maintenance colonies (Scout + Fixer).
// PURPOSE: Run: npx tsx src/cli/index.ts dev examples/repo-maintenance/mandible.config.ts

import { resolve } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { FilesystemEnvironment } from '../../src/environments/filesystem/index.js';
import { createScoutColony } from './scout.js';
import { createFixerColony } from './fixer.js';

const ENV_ROOT = resolve('/tmp/mandible-repo-maintenance');
const TARGET_REPO = resolve(process.env.TARGET_REPO ?? process.cwd());

// Clean slate on startup
await rm(ENV_ROOT, { recursive: true, force: true });
await mkdir(ENV_ROOT, { recursive: true });

const env = new FilesystemEnvironment({ root: ENV_ROOT, name: 'repo-maintenance' });

// ── Colonies ────────────────────────────────────────────────

const scout = createScoutColony(env, TARGET_REPO);
const fixer = createFixerColony(env, TARGET_REPO);

// ── Seed scan trigger after a short delay ───────────────────

setTimeout(async () => {
  await env.deposit({
    type: 'scan:trigger',
    payload: {
      scope: 'full',
      triggered_by: 'dashboard',
    },
    meta: { deposited_by: 'seed', ttl: 10 * 60_000 },
  });
}, 2000);

// ── Export config for mandible dev ──────────────────────────

export default {
  environment: env,
  colonies: [scout, fixer],
  dashboard: { port: 4040, open: true },
};
