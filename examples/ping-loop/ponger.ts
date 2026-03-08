// PURPOSE: Ponger colony configurator — senses ping:response, deposits next ping:request.
// PURPOSE: Exported as a ColonyModuleRef for cloud deployment.

import type { ColonyBuilder } from '../../src/dsl/builder.js';

export function configurePonger() {
  return (c: ColonyBuilder) =>
    c
      .sense('ping:response', { unclaimed: true })
      .do('pong', async (signal, ctx) => {
        const payload = signal.payload as Record<string, unknown>;
        ctx.log(`got response #${payload.counter}: "${payload.message}"`);
        await ctx.deposit('ping:request', {
          message: payload.message,
          requestedAt: Date.now(),
          previousResponse: signal.id,
        });
        await ctx.withdraw(signal.id);
      })
      .concurrency(1)
      .claim('exclusive')
      .poll(3000);
}
