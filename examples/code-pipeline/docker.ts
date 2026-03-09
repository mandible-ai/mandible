#!/usr/bin/env tsx
// ============================================================
// Code Pipeline — Docker Host
// ============================================================
// Same colonies as index.ts, but running as Docker containers
// on the local Docker daemon. Colony definitions must use
// module refs (closures can't cross container boundaries).
//
// To run:
//   npx tsx examples/code-pipeline/docker.ts
// ============================================================

import { mandible, FilesystemEnvironment, docker, type DockerHostMetadata } from '../../src/index.js';
import { SEED_TASKS } from './colonies.js';

const env = new FilesystemEnvironment({ root: '/tmp/mandible-demo', name: 'code-pipeline' });

const host = await mandible('code-pipeline')
  .environment(env)
  .host(docker({ image: 'mandible-colony:latest' }))
  .colony('shaper', { module: './colonies.ts', export: 'shaper' })
  .colony('critic', { module: './colonies.ts', export: 'critic' })
  .colony('keeper', { module: './colonies.ts', export: 'keeper' })
  .start();

const meta = host.metadata as DockerHostMetadata;
console.log(`Started ${host.colonies.length} colonies on ${host.name} host`);
console.log('Containers:', meta.containers);

// Seed tasks
for (const task of SEED_TASKS) {
  await env.deposit({
    type: 'task:ready',
    payload: task,
    meta: { deposited_by: 'seed', tags: [task.priority] },
  });
  console.log(`  seeded: task:ready "${task.name}"`);
}

console.log('\nColonies running in Docker containers.');
console.log('Press Ctrl+C to stop.\n');

// Keep alive until interrupted
process.on('SIGINT', async () => {
  console.log('\nStopping...');
  await host.stop();
  console.log('Stopped.');
  process.exit(0);
});

// Block forever
await new Promise(() => {});
