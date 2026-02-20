// ============================================================
// Mandible DSL — Multi-Colony Orchestration
// ============================================================
// Usage:
//
//   import { mandible } from '@mandible-ai/mandible';
//
//   await mandible('code-review')
//     .cloud({ apiUrl: 'https://api.mandible.dev', apiKey: KEY })
//     .colony('shaper', c => c
//       .sense('task:ready', { unclaimed: true })
//       .do('shape', async (signal, ctx) => { ... })
//       .concurrency(2)
//     )
//     .colony('critic', c => c
//       .sense('artifact:shaped', { unclaimed: true })
//       .do('review', async (signal, ctx) => { ... })
//     )
//     .colony('keeper', c => c
//       .sense('review:approved', { unclaimed: true })
//       .do('merge', async (signal, ctx) => { ... })
//     )
//     .deploy();  // launches remote colonies via Cloud API
//
//   // Or run locally with dashboard:
//   await mandible('code-review')
//     .environment(env)
//     .colony('shaper', c => c.sense(...).do(...))
//     .dev({ port: 4040 });
//
// ============================================================

import { ColonyBuilder, colony as colonyBuilder } from './builder.js';
import { RemoteEnvironment } from '../environments/remote/index.js';
import { MandibleCloudClient } from '../cloud/client.js';
import type { CloudConfig, DeployColonyConfig, DeployResult } from '../cloud/types.js';
import type { Environment, ColonyDefinition, Signal, ActionContext } from '../core/types.js';
import type { RemoteEnvConfig } from '../environments/remote/index.js';

export interface PipelineCloudConfig {
  apiUrl?: string;
  apiKey?: string;
  project?: string;
}

export interface PipelineDeployOptions {
  project?: string;
  image?: string;
  dashboard?: boolean | { port?: number };
}

export interface PipelineDevOptions {
  port?: number;
  open?: boolean;
  seed?: () => Promise<void>;
}

type ColonyConfigurator = (builder: ColonyBuilder) => ColonyBuilder;

interface ColonyEntry {
  name: string;
  configurator: ColonyConfigurator;
  image?: string;
}

export class MandibleBuilder {
  private _name: string;
  private _env?: Environment;
  private _cloudConfig?: PipelineCloudConfig;
  private _colonies: ColonyEntry[] = [];

  constructor(name: string) {
    this._name = name;
  }

  /** Set a local environment for dev mode */
  environment(env: Environment): this {
    this._env = env;
    return this;
  }

  /** Configure cloud deployment */
  cloud(config: PipelineCloudConfig): this {
    this._cloudConfig = {
      apiUrl: config.apiUrl ?? process.env.MANDIBLE_API_URL ?? 'https://api.mandible.dev',
      apiKey: config.apiKey ?? process.env.MANDIBLE_API_KEY,
      project: config.project ?? process.env.MANDIBLE_PROJECT,
    };
    return this;
  }

  /** Add a colony to the pipeline */
  colony(name: string, configure: ColonyConfigurator, opts?: { image?: string }): this {
    this._colonies.push({ name, configurator: configure, image: opts?.image });
    return this;
  }

  /**
   * Deploy colonies to Mandible Cloud (Edera zones).
   * Creates a project if needed, deploys all colonies, and optionally
   * starts a local dashboard connected to the remote signal server.
   */
  async deploy(options: PipelineDeployOptions = {}): Promise<DeployResult> {
    const cloud = this.requireCloud();
    const client = new MandibleCloudClient({
      apiUrl: cloud.apiUrl!,
      apiKey: cloud.apiKey!,
      project: cloud.project,
    });

    // Create or reuse project
    let projectId = options.project ?? cloud.project;
    let signalServerUrl: string | undefined;

    if (!projectId) {
      const project = await client.createProject({ name: this._name });
      projectId = project.id;
      signalServerUrl = project.signalServerUrl;
      console.log(`  created project: ${projectId}`);
    } else {
      const project = await client.getProject(projectId);
      signalServerUrl = project.signalServerUrl;
    }

    // Build deploy request from colony definitions
    const deployColonies: DeployColonyConfig[] = this._colonies.map(entry => {
      const builder = entry.configurator(colonyBuilder(entry.name));
      // Build temporarily with a dummy env to extract config
      const tempEnv = this._env ?? new DummyEnvironment();
      const def = builder.in(tempEnv).build();

      return {
        name: entry.name,
        image: entry.image ?? options.image,
        sensors: def.sensors.map(s => ({
          query: {
            type: s.query.type,
            unclaimed: s.query.unclaimed,
            minConcentration: s.query.minConcentration,
            tags: s.query.tags,
          },
          pollInterval: s.pollInterval,
        })),
        claimStrategy: typeof def.claimStrategy === 'string' ? def.claimStrategy : 'exclusive',
        concurrency: def.concurrency,
        config: def.config as Record<string, unknown>,
      };
    });

    console.log(`  deploying ${deployColonies.length} colonies to ${cloud.apiUrl}...`);
    const result = await client.deploy({ colonies: deployColonies }, projectId);

    for (const col of result.colonies) {
      console.log(`    + ${col.name} [${col.state}] zone=${col.zoneId}`);
    }

    // Optionally start dashboard connected to remote environment
    if (options.dashboard !== false) {
      const dashPort = typeof options.dashboard === 'object'
        ? options.dashboard.port ?? 4040
        : 4040;

      await this.startRemoteDashboard(
        signalServerUrl!,
        cloud.apiKey!,
        projectId,
        dashPort,
      );
    }

    return result;
  }

  /**
   * Run colonies locally with a dashboard.
   * Uses the configured environment (filesystem, remote, etc).
   */
  async dev(options: PipelineDevOptions = {}): Promise<void> {
    const env = this.requireEnv();
    const port = options.port ?? 4040;
    const open = options.open ?? true;

    // Build colony definitions
    const definitions: ColonyDefinition[] = this._colonies.map(entry => {
      const builder = entry.configurator(colonyBuilder(entry.name));
      return builder.in(env).build();
    });

    // Lazy import to avoid pulling in server deps when not needed
    const { startDevServer } = await import('../cli/server.js');

    await startDevServer(
      { environment: env, colonies: definitions, dashboard: { port, open } },
      { port, open },
    );

    if (options.seed) {
      await options.seed();
    }
  }

  /**
   * Build colony definitions without starting anything.
   * Useful for testing or custom orchestration.
   */
  build(env?: Environment): ColonyDefinition[] {
    const targetEnv = env ?? this._env;
    if (!targetEnv) {
      throw new Error(`Pipeline "${this._name}" requires an environment. Call .environment(env) or pass one to .build(env).`);
    }
    return this._colonies.map(entry => {
      const builder = entry.configurator(colonyBuilder(entry.name));
      return builder.in(targetEnv).build();
    });
  }

  /** Connect to a remote signal server and start a dashboard showing remote colony events */
  private async startRemoteDashboard(
    signalServerUrl: string,
    apiKey: string,
    project: string,
    port: number,
  ): Promise<void> {
    const env = new RemoteEnvironment({
      url: signalServerUrl,
      apiKey,
      project,
      name: `dashboard:${this._name}`,
    });

    await env.connect();
    console.log(`  connected to signal server`);

    // Build dummy definitions for the dashboard (no local processing)
    const definitions: ColonyDefinition[] = this._colonies.map(entry => ({
      name: entry.name,
      environment: env,
      sensors: [],
      rules: [],
      concurrency: 0,
      claimStrategy: 'none' as const,
    }));

    const { startDevServer } = await import('../cli/server.js');

    await startDevServer(
      { environment: env, colonies: definitions, dashboard: { port, open: true } },
      { port, open: true },
    );
  }

  private requireCloud(): Required<Pick<PipelineCloudConfig, 'apiUrl'>> & PipelineCloudConfig {
    if (!this._cloudConfig) {
      // Auto-configure from environment
      this._cloudConfig = {
        apiUrl: process.env.MANDIBLE_API_URL ?? 'https://api.mandible.dev',
        apiKey: process.env.MANDIBLE_API_KEY,
        project: process.env.MANDIBLE_PROJECT,
      };
    }
    if (!this._cloudConfig.apiKey) {
      throw new Error(
        'Cloud API key required. Call .cloud({ apiKey }) or set MANDIBLE_API_KEY.',
      );
    }
    return this._cloudConfig as Required<Pick<PipelineCloudConfig, 'apiUrl'>> & PipelineCloudConfig;
  }

  private requireEnv(): Environment {
    if (!this._env) {
      throw new Error(
        `Pipeline "${this._name}" requires an environment for dev mode. Call .environment(env) first.`,
      );
    }
    return this._env;
  }
}

// Dummy environment used to extract colony config without a real env
class DummyEnvironment implements Environment {
  readonly name = '__dummy__';
  async deposit() { return {} as any; }
  async observe() { return []; }
  async claim() { return true; }
  async release() {}
  async withdraw() {}
  async decay() { return { decayed: 0, evaporated: 0, claimsReleased: 0 }; }
  async snapshot() { return []; }
  async history() { return []; }
  subscribe() { return { unsubscribe: () => {} }; }
  watch() { return { unsubscribe: () => {} }; }
}

/**
 * Entry point for the mandible DSL.
 *
 * @example
 * await mandible('my-swarm')
 *   .cloud({ apiKey: process.env.MANDIBLE_API_KEY })
 *   .colony('worker', c => c
 *     .sense('task:new')
 *     .do('process', async (signal, ctx) => { ... })
 *   )
 *   .deploy();
 */
export function mandible(name: string): MandibleBuilder {
  return new MandibleBuilder(name);
}

/** @deprecated Use mandible() instead */
export const pipeline = mandible;
