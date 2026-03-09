// PURPOSE: Docker deployment config for ping-loop — runs pinger + ponger as local Docker containers.
// PURPOSE: Run: npx tsx examples/ping-loop/docker.config.ts

import { mandible } from '../../src/dsl/mandible.js';
import { FilesystemEnvironment } from '../../src/environments/filesystem/index.js';
import { docker } from '../../src/hosts/docker.js';

const env = new FilesystemEnvironment({ root: '/tmp/mandible-ping-loop', name: 'ping-loop' });

const host = await mandible('ping-loop')
  .environment(env)
  .host(docker({ image: 'mandible-colony:latest' }))
  .colony('pinger', {
    module: './pinger.ts',
    export: 'configurePinger',
  })
  .colony('ponger', {
    module: './ponger.ts',
    export: 'configurePonger',
  })
  .start();

console.log(`Started ${host.colonies.length} colonies in Docker containers`);
console.log('Containers:', (host.metadata as any).containers);
console.log('\nDeposit a ping:request signal to start the loop.');

await host.dashboard({ port: 4040 });
