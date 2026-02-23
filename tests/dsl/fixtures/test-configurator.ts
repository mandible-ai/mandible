// PURPOSE: Test fixture for ColonyModuleRef resolution tests.
// PURPOSE: Exports a configurator function that returns a colony builder configurator.

import type { ColonyBuilder } from '../../../src/dsl/builder.js';
import type { Signal, ActionContext } from '../../../src/core/types.js';

export function configureTestColony(greeting: string) {
  return (builder: ColonyBuilder) =>
    builder
      .sense('test:signal', { unclaimed: true })
      .do('test-action', async (signal: Signal, ctx: ActionContext) => {
        ctx.log(`${greeting}: ${signal.type}`);
        await ctx.withdraw(signal.id);
      })
      .concurrency(2);
}
