// PURPOSE: Test colony that polls and deposits a signal every ~3 seconds.
// PURPOSE: Run: npx tsx examples/ping-loop/mandible.config.ts

import { resolve } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { mandible } from '../../src/dsl/mandible.js';
import { FilesystemEnvironment } from '../../src/environments/filesystem/index.js';

const ENV_ROOT = resolve('/tmp/mandible-ping-loop');

await rm(ENV_ROOT, { recursive: true, force: true });
await mkdir(ENV_ROOT, { recursive: true });

const env = new FilesystemEnvironment({ root: ENV_ROOT, name: 'ping-loop' });

let counter = 0;

const host = await mandible('ping-loop')
  .environment(env)
  .colony('pinger', (c) =>
    c
      .sense('ping:request', { unclaimed: true })
      .do('ping', async (signal, ctx) => {
        counter++;
        const payload = signal.payload as Record<string, unknown>;
        const message = payload.message ?? 'hello';
        console.log(`[pinger] #${counter} — got "${message}", parroting back`);
        await ctx.deposit('ping:response', {
          counter,
          message,
          respondedTo: signal.id,
          timestamp: Date.now(),
        });
        await ctx.withdraw(signal.id);
      })
      .concurrency(1)
      .claim('exclusive')
      .poll(3000),
  )
  .colony('ponger', (c) =>
    c
      .sense('ping:response', { unclaimed: true })
      .do('pong', async (signal, ctx) => {
        const payload = signal.payload as Record<string, unknown>;
        console.log(`[ponger] got response #${payload.counter}: "${payload.message}"`);
        await ctx.deposit('ping:request', {
          message: payload.message,
          requestedAt: Date.now(),
          previousResponse: signal.id,
        });
        await ctx.withdraw(signal.id);
      })
      .concurrency(1)
      .claim('exclusive')
      .poll(3000),
  )
  .start();

console.log(`Started ${host.colonies.length} colonies (id: ${host.metadata.id})`);
console.log('Open the dashboard and deposit a ping:request signal to start the loop.');

await host.dashboard({ port: 4040 });
