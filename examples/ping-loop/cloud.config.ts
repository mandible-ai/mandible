// PURPOSE: Cloud deployment config for ping-loop — deploys pinger + ponger to Mandible Cloud.
// PURPOSE: Run: MANDIBLE_API_KEY=mk_... MANDIBLE_PROJECT=proj_... npx tsx examples/ping-loop/cloud.config.ts

import { mandible } from '../../src/dsl/mandible.js';
import { FilesystemEnvironment } from '../../src/environments/filesystem/index.js';
import { docker } from '../../src/hosts/docker.js';

const API_URL = process.env.MANDIBLE_API_URL ?? 'https://api.mandible.dev';
const API_KEY = process.env.MANDIBLE_API_KEY;
const PROJECT = process.env.MANDIBLE_PROJECT;

if (!API_KEY) {
  console.error('\n  MANDIBLE_API_KEY is required.');
  console.error('  Usage: MANDIBLE_API_KEY=mk_... npx tsx examples/ping-loop/cloud.config.ts\n');
  process.exit(1);
}

// The environment is serialized and sent to the zone — filesystem is the simplest
// for a self-contained test. Zones get their own /tmp/mandible-signals.
const env = new FilesystemEnvironment({ root: '/tmp/mandible-signals', name: 'ping-loop' });

const host = await mandible('ping-loop')
  .environment(env)
  .host(docker({
    apiUrl: API_URL,
    apiKey: API_KEY,
    project: PROJECT,
  }))
  .colony('pinger', {
    module: './pinger.ts',
    export: 'configurePinger',
  })
  .colony('ponger', {
    module: './ponger.ts',
    export: 'configurePonger',
  })
  .start();

console.log(`Deployed to project: ${host.metadata.projectId}`);
console.log(`Signal server: ${host.metadata.signalServerUrl}`);
console.log(`Zones:`, host.metadata.zones);
console.log('\nDeposit a ping:request signal from the console to start the loop.');
