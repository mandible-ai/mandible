#!/usr/bin/env tsx
// ============================================================
// Code Pipeline — Docker Host
// ============================================================
// Same colonies as index.ts, but running as Docker containers
// via the Mandible Cloud API. The colony definitions are
// identical — only the host changes.
//
// Prerequisites:
//   - Mandible Cloud API running (local or remote)
//   - MANDIBLE_API_URL and MANDIBLE_API_KEY set
//
// To run:
//   export MANDIBLE_API_URL=http://localhost:9091
//   export MANDIBLE_API_KEY=your-api-key
//   npx tsx examples/code-pipeline/docker.ts
// ============================================================

import { mandible, FilesystemEnvironment, docker, type DockerHostMetadata } from '../../src/index.js';
import { shaper, critic, keeper, SEED_TASKS } from './colonies.js';

const apiUrl = process.env.MANDIBLE_API_URL;
const apiKey = process.env.MANDIBLE_API_KEY;

if (!apiUrl || !apiKey) {
  console.error('Set MANDIBLE_API_URL and MANDIBLE_API_KEY');
  process.exit(1);
}

const env = new FilesystemEnvironment({ root: '/tmp/mandible-demo', name: 'code-pipeline' });

// Same colonies, different host
const host = await mandible('code-pipeline')
  .environment(env)
  .host(docker({
    apiUrl,
    apiKey,
    image: 'mandible-colony:latest',
  }))
  .colony('shaper', shaper)
  .colony('critic', critic)
  .colony('keeper', keeper)
  .start();

const meta = host.metadata as DockerHostMetadata;
console.log(`Started ${host.colonies.length} colonies on ${host.name} host`);
console.log(`Project: ${meta.projectId}`);
console.log(`Signal server: ${meta.signalServerUrl}\n`);

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
