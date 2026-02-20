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
  StartOptions,
  Environment,
} from '../core/types.js';

export class LocalHost implements Host {
  readonly name: string;
  private runtimes: Array<{ stop(): Promise<void>; name: string }> = [];
  private _colonies: Array<{ name: string; state: string }> = [];
  private _environments: Environment[] = [];
  private _colonyDefs: ColonyDefinition[] = [];
  private _options: StartOptions = {};

  constructor(options?: { name?: string }) {
    this.name = options?.name ?? 'local';
  }

  get colonies(): Array<{ name: string; state: string }> { return this._colonies; }
  get environments(): Environment[] { return this._environments; }

  async start(colonies: ColonyDefinition[], options: StartOptions = {}): Promise<void> {
    const { createRuntime } = await import('../core/runtime.js');
    const { EventBus } = await import('../core/events.js');
    const eventBus = new EventBus();

    this._colonyDefs = colonies;
    this._options = options;

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
    this._environments = Array.from(envMap.values());
    this._colonies = colonies.map(c => ({ name: c.name, state: 'running' }));

    if (!options.headless) {
      await this.dashboard({ port: options.port, open: options.open });
    }
  }

  async stop(): Promise<void> {
    for (const rt of this.runtimes) {
      await rt.stop();
    }
    this.runtimes = [];
    this._colonies = [];
  }

  async dashboard(options?: { port?: number; open?: boolean }): Promise<void> {
    const port = options?.port ?? this._options.port ?? 4040;
    const open = options?.open ?? this._options.open ?? true;
    const { startDevServer } = await import('../cli/server.js');
    const primaryEnv = this._environments[0];
    if (!primaryEnv) throw new Error('No environments to observe');
    await startDevServer(
      { environment: primaryEnv, colonies: this._colonyDefs, dashboard: { port, open } },
      { port, open },
    );
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
 *   .start();
 */
export function local(options?: { name?: string }): LocalHost {
  return new LocalHost(options);
}
