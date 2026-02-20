#!/usr/bin/env tsx
// ============================================================
// Code Pipeline — Local Host
// ============================================================
// Runs three colonies in the current Node process using the
// default local() host. Colonies coordinate through signals
// in a filesystem environment.
//
//   Shaper  -> artifact:shaped
//   Critic  -> review:approved | review:changes-needed
//   Keeper  -> artifact:merged
//
// To run:
//   npx tsx examples/code-pipeline/index.ts
// ============================================================

import { resolve } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { mandible, FilesystemEnvironment } from '../../src/index.js';
import { shaper, critic, keeper, SEED_TASKS } from './colonies.js';

const ENV_ROOT = resolve('/tmp/mandible-demo');

// Clean slate
await rm(ENV_ROOT, { recursive: true, force: true });
await mkdir(ENV_ROOT, { recursive: true });

const env = new FilesystemEnvironment({ root: ENV_ROOT, name: 'code-pipeline' });

// Start colonies on the local host (default when .host() is omitted)
const host = await mandible('code-pipeline')
  .environment(env)
  .colony('shaper', shaper)
  .colony('critic', critic)
  .colony('keeper', keeper)
  .start();

console.log(`Started ${host.colonies.length} colonies on ${host.name} host`);
console.log(`Environment: ${ENV_ROOT}\n`);

// Seed tasks into the environment
for (const task of SEED_TASKS) {
  await env.deposit({
    type: 'task:ready',
    payload: task,
    meta: { deposited_by: 'seed', tags: [task.priority] },
  });
  console.log(`  seeded: task:ready "${task.name}"`);
}

console.log('\nColonies are self-organizing. Watch signals:');
console.log(`  watch -n 0.5 'ls ${ENV_ROOT}/signals/'\n`);

// Let colonies work
await new Promise(r => setTimeout(r, 20_000));

// Report
const snapshot = await env.snapshot();
console.log(`\nActive signals: ${snapshot.length}`);
for (const s of snapshot) {
  console.log(`  [${s.type}] ${s.payload.task ?? s.payload.name ?? '?'}`);
}

await host.stop();
console.log('Stopped.');
