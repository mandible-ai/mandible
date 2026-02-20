// ============================================================
// Local Host — runs colonies as local Node processes
// ============================================================
// The simplest host: starts ColonyRuntime instances in the
// current process and optionally opens a dashboard.
//
// This is the default host when none is specified. It works
// with any Environment — filesystem, remote signal server,
// GitHub, Dolt, etc.
// ============================================================

import type {
  Host,
  ColonyDefinition,
  DeployOptions,
  Deployment,
  Environment,
} from '../core/types.js';

export class LocalHost implements Host {
  readonly name: string;
  private runtimes: Array<{ stop(): Promise<void>; name: string }> = [];

  constructor(options?: { name?: string }) {
    this.name = options?.name ?? 'local';
  }

  async deploy(colonies: ColonyDefinition[], options: DeployOptions = {}): Promise<Deployment> {
    const { createRuntime } = await import('../core/runtime.js');
    const { EventBus } = await import('../core/events.js');
    const eventBus = new EventBus();

    // Start local runtimes for each colony
    for (const def of colonies) {
      const runtime = createRuntime(def, { eventBus });
      this.runtimes.push(runtime);
      await runtime.start();
    }

    // Collect unique environments from all colony definitions
    const envMap = new Map<string, Environment>();
    for (const def of colonies) {
      envMap.set(def.environment.name, def.environment);
    }
    const environments = Array.from(envMap.values());

    const self = this;
    const deployment: Deployment = {
      colonies: colonies.map(c => ({ name: c.name, state: 'running' })),
      host: this,
      environments,

      dashboard: async (opts) => {
        const port = opts?.port ?? options.port ?? 4040;
        const open = opts?.open ?? options.open ?? true;
        const { startDevServer } = await import('../cli/server.js');
        // Use the first environment for the dashboard
        const primaryEnv = environments[0];
        if (!primaryEnv) throw new Error('No environments to observe');
        await startDevServer(
          { environment: primaryEnv, colonies, dashboard: { port, open } },
          { port, open },
        );
      },

      teardown: async () => {
        for (const rt of self.runtimes) {
          await rt.stop();
        }
        self.runtimes = [];
      },
    };

    if (!options.headless) {
      await deployment.dashboard({ port: options.port, open: options.open });
    }

    return deployment;
  }

  async teardown(): Promise<void> {
    for (const rt of this.runtimes) {
      await rt.stop();
    }
    this.runtimes = [];
  }
}

/**
 * Create a local host that runs colonies in the current process.
 *
 * @example
 * await mandible('my-swarm')
 *   .environment(env)
 *   .host(local())
 *   .colony('worker', c => c.sense('task:ready').do('work', handler))
 *   .deploy();
 */
export function local(options?: { name?: string }): LocalHost {
  return new LocalHost(options);
}
