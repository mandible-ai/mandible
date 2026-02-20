// ============================================================
// Cloud Host — runs colonies in Edera microVMs
// ============================================================
// Deploys colonies to the Mandible Cloud, where each colony
// runs in an isolated Edera microVM. Colonies connect to the
// managed signal server over WebSocket.
//
// This is the production deployment model. MicroVMs provide
// hardware-level isolation without the overhead of full VMs.
// ============================================================

import type {
  Host,
  ColonyDefinition,
  DeployOptions,
  Deployment,
  Environment,
} from '../core/types.js';
import type { DeployColonyConfig, ZoneResources } from './types.js';

export interface CloudHostConfig {
  /** Mandible Cloud API URL. Default: https://api.mandible.dev */
  apiUrl?: string;
  /** API key for authentication */
  apiKey: string;
  /** Project ID (created if not provided) */
  project?: string;
  /** Default resource allocation per colony */
  resources?: ZoneResources;
  /** Human-readable name */
  name?: string;
  /** Timeout for waiting for microVMs to be ready (ms). Default: 60_000 */
  readyTimeout?: number;
}

export class CloudHost implements Host {
  readonly name: string;
  private config: CloudHostConfig;
  private projectId?: string;

  constructor(config: CloudHostConfig) {
    this.name = config.name ?? 'cloud';
    this.config = config;
    this.projectId = config.project;
  }

  async deploy(colonies: ColonyDefinition[], options: DeployOptions = {}): Promise<Deployment> {
    const { MandibleCloudClient } = await import('./client.js');
    const client = new MandibleCloudClient({
      apiUrl: this.config.apiUrl ?? 'https://api.mandible.dev',
      apiKey: this.config.apiKey,
      project: this.projectId,
    });

    // Create project if needed
    if (!this.projectId) {
      const project = await client.createProject({
        name: `mandible-${Date.now()}`,
      });
      this.projectId = project.id;
    }

    // Map colony definitions to deploy configs
    const deployConfigs: DeployColonyConfig[] = colonies.map(def => ({
      name: def.name,
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
      concurrency: def.concurrency,
      config: def.config as Record<string, unknown>,
      resources: this.config.resources,
    }));

    // Deploy via Cloud API (Edera zones)
    const result = await client.deploy(
      { colonies: deployConfigs },
      this.projectId,
    );

    // Wait for all zones to reach running state (longer timeout for microVMs)
    const timeout = this.config.readyTimeout ?? 60_000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
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
    const environments = Array.from(envMap.values());

    const self = this;
    const deployment: Deployment = {
      colonies: result.colonies.map(c => ({
        name: c.name,
        state: c.state,
        zoneId: c.zoneId,
      })),
      host: this,
      environments,

      dashboard: async (opts) => {
        const port = opts?.port ?? options.port ?? 4040;
        const open = opts?.open ?? options.open ?? true;
        const { startDevServer } = await import('../cli/server.js');
        const primaryEnv = environments[0];
        if (!primaryEnv) throw new Error('No environments to observe');
        await startDevServer(
          { environment: primaryEnv, colonies, dashboard: { port, open } },
          { port, open },
        );
      },

      teardown: async () => {
        await self.teardown();
      },
    };

    if (!options.headless) {
      await deployment.dashboard({ port: options.port, open: options.open });
    }

    return deployment;
  }

  async teardown(): Promise<void> {
    if (!this.projectId) return;
    const { MandibleCloudClient } = await import('./client.js');
    const client = new MandibleCloudClient({
      apiUrl: this.config.apiUrl ?? 'https://api.mandible.dev',
      apiKey: this.config.apiKey,
      project: this.projectId,
    });
    await client.teardown(this.projectId);
  }
}

/**
 * Create a cloud host that runs colonies in Edera microVMs.
 *
 * @example
 * await mandible('my-swarm')
 *   .environment(signalServerEnv)
 *   .host(cloud({ apiKey: MANDIBLE_API_KEY }))
 *   .colony('worker', c => c.sense('task:ready').do('work', handler))
 *   .deploy();
 */
export function cloud(config: CloudHostConfig): CloudHost {
  return new CloudHost(config);
}
