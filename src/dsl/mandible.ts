// ============================================================
// Mandible DSL — Multi-Colony Orchestration
// ============================================================
// Usage:
//
//   import { mandible, FilesystemEnvironment } from '@mandible-ai/mandible';
//
//   const env = new FilesystemEnvironment({ root: '/tmp/demo' });
//
//   await mandible('code-review')
//     .environment(env)
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
//   // Cloud deployment (requires @mandible-ai/cloud):
//   import { CloudEnvironment } from '@mandible-ai/cloud';
//   const env = new CloudEnvironment({ apiKey: KEY, project: 'review' });
//   await mandible('review').environment(env).colony(...).deploy();
//
// ============================================================

import { ColonyBuilder, colony as colonyBuilder } from './builder.js';
import type {
  Environment, ColonyDefinition,
  Deployment, DeployOptions, Deployable,
} from '../core/types.js';
import { isDeployable } from '../core/types.js';

type ColonyConfigurator = (builder: ColonyBuilder) => ColonyBuilder;

interface ColonyEntry {
  name: string;
  configurator: ColonyConfigurator;
}

export class MandibleBuilder {
  private _name: string;
  private _env?: Environment;
  private _colonies: ColonyEntry[] = [];

  constructor(name: string) {
    this._name = name;
  }

  /** Set the environment colonies operate in */
  environment(env: Environment): this {
    this._env = env;
    return this;
  }

  /** Add a colony */
  colony(name: string, configure: ColonyConfigurator): this {
    this._colonies.push({ name, configurator: configure });
    return this;
  }

  /**
   * Deploy colonies into the configured environment.
   * What "deploy" means depends on the environment:
   * - FilesystemEnvironment: starts local runtimes + dashboard
   * - CloudEnvironment (@mandible-ai/cloud): launches Edera zones via Cloud API
   */
  async deploy(options: DeployOptions = {}): Promise<Deployment> {
    const env = this.requireEnv();

    if (!isDeployable(env)) {
      throw new Error(
        `Environment "${env.name}" does not support deployment. ` +
        `Use an environment that implements Deployable (e.g. FilesystemEnvironment, CloudEnvironment).`,
      );
    }

    const definitions = this.buildDefinitions(env);
    return env.deploy(definitions, options);
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
 *   .environment(env)
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
