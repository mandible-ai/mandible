// PURPOSE: Repo-maintenance example — Scout + Fixer colonies.
// PURPOSE: Run: npx tsx examples/repo-maintenance/mandible.config.ts

import { resolve } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { mandible } from '../../src/dsl/mandible.js';
import { FilesystemEnvironment } from '../../src/environments/filesystem/index.js';
import { configureScout } from './scout.js';
import { configureFixer } from './fixer.js';

const ENV_ROOT = resolve('/tmp/mandible-repo-maintenance');
const TARGET_REPO = resolve(process.env.TARGET_REPO ?? process.cwd());

// Clean slate on startup
await rm(ENV_ROOT, { recursive: true, force: true });
await mkdir(ENV_ROOT, { recursive: true });

const env = new FilesystemEnvironment({ root: ENV_ROOT, name: 'repo-maintenance' });

// ── Start colonies via mandible DSL ───────────────────────

const host = await mandible('repo-maintenance')
  .environment(env)
  .colony('scout', configureScout(TARGET_REPO))
  .colony('fixer', configureFixer(TARGET_REPO))
  .start();

console.log(`Started ${host.colonies.length} colonies (id: ${host.metadata.id})`);

// ── Seed scan trigger after a short delay ─────────────────

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

await host.dashboard({ port: 4040 });
