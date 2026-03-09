// PURPOSE: Pinger colony configurator — senses ping:request, deposits ping:response.
// PURPOSE: Exported as a ColonyModuleRef for cloud deployment.

import type { ColonyBuilder } from '../../src/dsl/builder.js';

let counter = 0;

export function configurePinger() {
  return (c: ColonyBuilder) =>
    c
      .sense('ping:request', { unclaimed: true })
      .do('ping', async (signal, ctx) => {
        counter++;
        const payload = signal.payload as Record<string, unknown>;
        const message = payload.message ?? 'hello';
        ctx.log(`#${counter} — got "${message}", parroting back`);
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
      .poll(3000);
}
