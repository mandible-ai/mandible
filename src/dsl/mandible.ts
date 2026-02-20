// ============================================================
// Mandible DSL — Multi-Colony Orchestration
// ============================================================
// Two orthogonal axes:
//   .environment(env) — where signals live (the observable world)
//   .host(host)       — where colony code runs (the process model)
//
// Usage:
//
//   import { mandible, FilesystemEnvironment, local } from '@mandible-ai/mandible';
//
//   const env = new FilesystemEnvironment({ root: '/tmp/demo' });
//
//   await mandible('code-review')
//     .environment(env)
//     .host(local())              // optional, local() is the default
//     .colony('shaper', c => c
//       .sense('task:ready', { unclaimed: true })
//       .do('shape', async (signal, ctx) => { ... })
//       .concurrency(2)
//     )
//     .colony('critic', c => c
//       .sense('artifact:shaped', { unclaimed: true })
//       .do('review', async (signal, ctx) => { ... })
//     )
//     .deploy();
//
//   // Cloud deployment — same environments, different host:
//   import { cloud } from '@mandible-ai/cloud';
//
//   await mandible('review')
//     .environment(env)                // same environment, real signal substrate
//     .host(cloud({ apiKey: CLOUD_KEY })) // colonies run in Edera microVMs
//     .colony('worker', c => c.sense('task:ready').do('work', handler))
//     .deploy();
//
// ============================================================

import { ColonyBuilder, colony as colonyBuilder } from './builder.js';
import type {
  Environment, ColonyDefinition,
  Deployment, DeployOptions,
  Host,
} from '../core/types.js';

type ColonyConfigurator = (builder: ColonyBuilder) => ColonyBuilder;

interface ColonyEntry {
  name: string;
  configurator: ColonyConfigurator;
}

export class MandibleBuilder {
  private _name: string;
  private _env?: Environment;
  private _host?: Host;
  private _colonies: ColonyEntry[] = [];

  constructor(name: string) {
    this._name = name;
  }

  /** Set the environment colonies observe (where signals live) */
  environment(env: Environment): this {
    this._env = env;
    return this;
  }

  /**
   * Set the host where colony code runs (the process model).
   * If not specified, defaults to LocalHost (runs in current process).
   */
  host(host: Host): this {
    this._host = host;
    return this;
  }

  /** Add a colony */
  colony(name: string, configure: ColonyConfigurator): this {
    this._colonies.push({ name, configurator: configure });
    return this;
  }

  /**
   * Deploy colonies using the configured host.
   * What "deploy" means depends on the host:
   * - local():  starts Node runtimes in the current process + dashboard
   * - docker(): launches Docker containers via Cloud API
   * - cloud():  launches Edera microVMs via Cloud API
   */
  async deploy(options: DeployOptions = {}): Promise<Deployment> {
    const env = this.requireEnv();
    const host = await this.resolveHost();
    const definitions = this.buildDefinitions(env);
    return host.deploy(definitions, options);
  }

  /**
   * Build colony definitions without starting anything.
   * Useful for testing or custom orchestration.
   */
  build(env?: Environment): ColonyDefinition[] {
    const targetEnv = env ?? this._env;
    if (!targetEnv) {
      throw new Error(
        `"${this._name}" requires an environment. Call .environment(env) or pass one to .build(env).`,
      );
    }
    return this.buildDefinitions(targetEnv);
  }

  private buildDefinitions(env: Environment): ColonyDefinition[] {
    return this._colonies.map(entry => {
      const builder = entry.configurator(colonyBuilder(entry.name));
      return builder.in(env).build();
    });
  }

  private async resolveHost(): Promise<Host> {
    if (this._host) return this._host;
    // Default: run locally
    const { LocalHost } = await import('../hosts/local.js');
    return new LocalHost();
  }

  private requireEnv(): Environment {
    if (!this._env) {
      throw new Error(
        `"${this._name}" requires an environment. Call .environment(env) first.`,
      );
    }
    return this._env;
  }
}

/**
 * Entry point for the mandible DSL.
 *
 * @example
 * const env = new FilesystemEnvironment({ root: '/tmp/demo' });
 * await mandible('my-swarm')
 *   .environment(env)         // where signals live
 *   .host(local())            // where code runs (optional, defaults to local)
 *   .colony('worker', c => c
 *     .sense('task:new')
 *     .do('process', async (signal, ctx) => { ... })
 *   )
 *   .deploy();
 */
export function mandible(name: string): MandibleBuilder {
  return new MandibleBuilder(name);
}

