// ============================================================
// Docker Host — runs colonies as Docker containers
// ============================================================
// Starts each colony as a Docker container via the Mandible
// Cloud API. Colonies connect to a signal server over WebSocket.
//
// The host manages the container lifecycle: create, wait for
// ready, monitor, and stop.
// ============================================================

import { randomUUID } from 'node:crypto';
import type {
  Host,
  HostMetadata,
  DashboardOptions,
  ColonyDefinition,
  Environment,
  HostResources,
} from '../core/types.js';
import { isSerializableEnvironment } from '../core/environment-registry.js';
import type { DeployColonyConfig } from '../cloud/types.js';

export interface DockerHostConfig {
  /** Mandible Cloud API URL */
  apiUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Project ID (created if not provided) */
  project?: string;
  /** Default container image for colonies */
  image?: string;
  /** Default resource allocation per colony */
  resources?: HostResources;
  /** Human-readable name */
  name?: string;
  /** Timeout for waiting for containers to be ready (ms). Default: 30_000 */
  readyTimeout?: number;
}

export interface DockerHostMetadata extends HostMetadata {
  /** Cloud project ID */
  projectId: string;
  /** Signal server WebSocket URL */
  signalServerUrl: string;
  /** Cloud dashboard URL */
  dashboardUrl: string;
  /** Per-colony zone info */
  zones: Record<string, { zoneId: string; state: string }>;
}

export class DockerHost implements Host<DockerHostMetadata> {
  readonly name: string;
  private config: DockerHostConfig;
  private projectId?: string;
  private client?: import('../cloud/client.js').MandibleCloudClient;
  private _colonies: Array<{ name: string; state: string; zoneId?: string }> = [];
  private _environments: Environment[] = [];
  private _colonyDefs: ColonyDefinition[] = [];
  private _metadata: DockerHostMetadata = {
    id: '', startedAt: new Date(0), projectId: '', signalServerUrl: '', dashboardUrl: '', zones: {},
  };

  constructor(config: DockerHostConfig) {
    this.name = config.name ?? 'docker';
    this.config = config;
    this.projectId = config.project;
  }

  get metadata(): DockerHostMetadata { return this._metadata; }
  get colonies(): Array<{ name: string; state: string; zoneId?: string }> { return this._colonies; }
  get environments(): Environment[] { return this._environments; }

  async start(colonies: ColonyDefinition[]): Promise<void> {
    const { MandibleCloudClient } = await import('../cloud/client.js');
    this.client = new MandibleCloudClient({
      apiUrl: this.config.apiUrl,
      apiKey: this.config.apiKey,
      project: this.projectId,
    });
    const client = this.client;

    this._colonyDefs = colonies;

    // Create project if needed
    if (!this.projectId) {
      const project = await client.createProject({
        name: `mandible-${Date.now()}`,
      });
      this.projectId = project.id;
    }

    // Serialize environment config so the colony runner can reconstruct it inside the zone
    const envConfig = this.serializeEnvironment(colonies[0]?.environment);

    // Map colony definitions to deploy configs
    const image = this.config.image ?? 'mandible-colony:latest';
    const deployConfigs: DeployColonyConfig[] = colonies.map(def => ({
      name: def.name,
      image,
      sensors: def.sensors.map(s => ({
        query: {
          type: s.query.type,
          unclaimed: s.query.unclaimed,
          minConcentration: s.query.minConcentration,
          tags: s.query.tags,
        },
        pollInterval: s.pollInterval,
      })),
      claimStrategy: def.claimStrategy,
      concurrency: typeof def.concurrency === 'number' ? def.concurrency : (def.concurrency.target ?? def.concurrency.min),
      config: def.config as Record<string, unknown>,
      resources: def.resources ?? this.config.resources,
      environmentConfig: envConfig,
    }));

    // Deploy via Cloud API
    const result = await client.deploy(
      { colonies: deployConfigs },
      this.projectId,
    );

    // Wait for all zones to reach running state
    const timeout = this.config.readyTimeout ?? 30_000;
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const zones = await client.listZones(this.projectId);
      const running = zones.filter(z => z.state === 'running');
      if (running.length >= colonies.length) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    // Collect unique environments
    const envMap = new Map<string, Environment>();
    for (const def of colonies) {
      envMap.set(def.environment.name, def.environment);
    }
    this._environments = Array.from(envMap.values());
    this._colonies = result.colonies.map(c => ({
      name: c.name,
      state: c.state,
      zoneId: c.zoneId,
    }));

    // Populate metadata
    const zones: Record<string, { zoneId: string; state: string }> = {};
    for (const c of result.colonies) {
      zones[c.name] = { zoneId: c.zoneId, state: c.state };
    }
    this._metadata = {
      id: randomUUID(),
      startedAt: new Date(),
      projectId: this.projectId,
      signalServerUrl: result.signalServerUrl,
      dashboardUrl: result.dashboardUrl,
      zones,
    };
  }

  async stop(): Promise<void> {
    if (!this.projectId || !this.client) return;
    await this.client.stop(this.projectId);
    this._colonies = [];
  }

  async dashboard(options?: DashboardOptions): Promise<void> {
    const port = options?.port ?? 4040;
    const open = options?.open ?? true;
    const { startDashboard, LocalDashboardSource } = await import('../cli/server.js');
    const { EventBus } = await import('../core/events.js');
    if (this._environments.length === 0) throw new Error('No environments to observe');

    const eventBus = new EventBus();
    // Wire environment onEvent to the bus (if supported)
    for (const env of this._environments) {
      if ('onEvent' in env && typeof (env as any).onEvent === 'function') {
        (env as any).onEvent((event: any) => eventBus.emit(event));
      }
    }

    const emptyStats = {
      signalsSensed: 0, signalsClaimed: 0, signalsProcessed: 0,
      signalsDeposited: 0, claimConflicts: 0, errors: 0, avgProcessingMs: 0,
    };

    const source = new LocalDashboardSource(
      eventBus,
      this._environments,
      () => this._colonies.map(c => ({
        name: c.name,
        state: c.state,
        activeCount: 0,
        concurrency: (() => { const cc = this._colonyDefs.find(d => d.name === c.name)?.concurrency ?? 1; return typeof cc === 'number' ? cc : (cc.target ?? cc.min); })(),
        stats: emptyStats,
      })),
    );
    await startDashboard(source, { port, open });
  }

  /**
   * Serialize an Environment instance into a JSON-safe config object
   * that the colony runner can use to reconstruct the environment inside the zone.
   */
  private serializeEnvironment(env?: Environment): Record<string, unknown> | undefined {
    if (!env) return undefined;
    if (isSerializableEnvironment(env)) return env.serialize();
    return { type: 'unknown', name: env.name };
  }
}

/**
 * Create a Docker host that runs colonies as Docker containers.
 *
 * @example
 * await mandible('my-swarm')
 *   .environment(signalServerEnv)
 *   .host(docker({
 *     apiUrl: 'http://localhost:9091',
 *     apiKey: ADMIN_KEY,
 *     image: 'mandible-colony:latest',
 *   }))
 *   .colony('worker', c => c.sense('task:ready').do('work', handler))
 *   .start();
 */
export function docker(config: DockerHostConfig): DockerHost {
  return new DockerHost(config);
}
