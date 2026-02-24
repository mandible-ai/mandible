// ============================================================
// Local Host — runs colonies as local Node processes
// ============================================================
// The simplest host: starts ColonyRuntime instances in the
// current process. Call dashboard() separately if needed.
//
// This is the default host when none is specified. It works
// with any Environment — filesystem, remote signal server,
// GitHub, Dolt, etc.
// ============================================================

import { randomUUID } from 'node:crypto';
import type {
  Host,
  HostMetadata,
  DashboardOptions,
  ColonyDefinition,
  Environment,
} from '../core/types.js';

export interface LocalHostMetadata extends HostMetadata {
  /** Per-colony runtime info */
  colonies: Record<string, { status: string }>;
}

export class LocalHost implements Host<LocalHostMetadata> {
  readonly name: string;
  private runtimes: Array<import('../core/runtime.js').ColonyRuntime> = [];
  private _colonies: Array<{ name: string; state: string }> = [];
  private _environments: Environment[] = [];
  private _colonyDefs: ColonyDefinition[] = [];
  private _metadata: LocalHostMetadata = { id: '', startedAt: new Date(0), colonies: {} };
  private _eventBus: import('../core/events.js').EventBus | null = null;
  private _bufferedEvents: import('../core/events.js').RuntimeEventData[] = [];

  constructor(options?: { name?: string }) {
    this.name = options?.name ?? 'local';
  }

  get metadata(): LocalHostMetadata { return this._metadata; }
  get colonies(): Array<{ name: string; state: string }> { return this._colonies; }
  get environments(): Environment[] { return this._environments; }
  get eventBus() { return this._eventBus; }

  async start(colonies: ColonyDefinition[]): Promise<void> {
    const { createRuntime } = await import('../core/runtime.js');
    const { EventBus } = await import('../core/events.js');
    const eventBus = new EventBus();
    this._eventBus = eventBus;

    this._colonyDefs = colonies;

    // Buffer events from startup so dashboard can replay them
    eventBus.on((event) => {
      if (this._bufferedEvents.length < 1000) {
        this._bufferedEvents.push(event);
      }
    });

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

    // Populate metadata
    const colonyMeta: Record<string, { status: string }> = {};
    for (const c of colonies) {
      colonyMeta[c.name] = { status: 'running' };
    }
    this._metadata = {
      id: randomUUID(),
      startedAt: new Date(),
      colonies: colonyMeta,
    };
  }

  async stop(): Promise<void> {
    for (const rt of this.runtimes) {
      await rt.stop();
    }
    this.runtimes = [];
    this._colonies = [];
  }

  async dashboard(options?: DashboardOptions): Promise<void> {
    const port = options?.port ?? 4040;
    const open = options?.open ?? true;
    const { startDashboard, LocalDashboardSource } = await import('../cli/server.js');
    if (this._environments.length === 0) throw new Error('No environments to observe');
    const source = new LocalDashboardSource(
      this._eventBus!,
      this._environments,
      () => this.runtimes.map(rt => ({
        name: rt.name,
        state: rt.state,
        activeCount: rt.activeCount,
        concurrency: rt.concurrency,
        stats: rt.stats,
      })),
      this._bufferedEvents,
    );
    await startDashboard(source, { port, open });
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
