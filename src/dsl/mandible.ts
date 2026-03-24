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
//   const host = await mandible('code-review')
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
//     .start();
//
//   // Cloud — same environments, different host:
//   import { cloud } from '@mandible-ai/cloud';
//
//   const host = await mandible('review')
//     .environment(env)                // same environment, real signal substrate
//     .host(cloud({ apiKey: CLOUD_KEY })) // colonies run in Edera microVMs
//     .colony('scout', {
//       module: './scout.js',
//       export: 'configureScout',
//       args: [TARGET_REPO],
//     })
//     .start();
//
//   // Dashboard is opt-in after start:
//   await host.dashboard({ port: 4040 });
//
// ============================================================

import { ColonyBuilder, colony as colonyBuilder } from './builder.js';
import type {
  Environment, ColonyDefinition,
  Host,
} from '../core/types.js';
import type { ColonyModuleRef } from '../cloud/types.js';

type ColonyConfigurator = (builder: ColonyBuilder) => ColonyBuilder;

interface ColonyEntry {
  name: string;
  configurator?: ColonyConfigurator;
  moduleRef?: ColonyModuleRef;
}

/** Check if a value is a ColonyModuleRef (has module + export fields) */
function isModuleRef(value: unknown): value is ColonyModuleRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    'module' in value &&
    'export' in value &&
    typeof (value as ColonyModuleRef).module === 'string' &&
    typeof (value as ColonyModuleRef).export === 'string'
  );
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

  /**
   * Add a colony.
   *
   * Accepts either a configurator closure (for local usage) or a module
   * reference (for cloud deployment where closures can't be serialized).
   *
   * @example Closure (local host):
   * .colony('scout', c => c.sense('task:ready').do('work', handler))
   *
   * @example Module ref (cloud host):
   * .colony('scout', { module: './scout.js', export: 'configureScout', args: [repoRoot] })
   */
  colony(name: string, configure: ColonyConfigurator | ColonyModuleRef): this {
    if (isModuleRef(configure)) {
      this._colonies.push({ name, moduleRef: configure });
    } else {
      this._colonies.push({ name, configurator: configure });
    }
    return this;
  }

  /** Get the raw colony entries (used by CloudHost for bundling) */
  get colonyEntries(): ReadonlyArray<Readonly<ColonyEntry>> {
    return this._colonies;
  }

  /**
   * Start colonies on the configured host.
   * What "start" means depends on the host:
   * - local():  starts Node runtimes in the current process
   * - docker(): launches Docker containers on local daemon
   * - cloud():  launches Edera microVMs via Cloud API
   *
   * Returns the host — use host.stop() to shut down,
   * host.dashboard() to open the live dashboard,
   * host.metadata for deployment info.
   */
  async start(): Promise<Host> {
    const env = this.requireEnv();
    const host = await this.resolveHost();
    const definitions = await this.buildDefinitions(env);

    // Pass colony entries to the host if it supports module refs (CloudHost)
    if ('setColonyEntries' in host && typeof (host as any).setColonyEntries === 'function') {
      (host as any).setColonyEntries(this._colonies);
    }

    await host.start(definitions);
    return host;
  }

  /**
   * Build colony definitions without starting anything.
   * Useful for testing or custom orchestration.
   */
  async build(env?: Environment): Promise<ColonyDefinition[]> {
    const targetEnv = env ?? this._env;
    if (!targetEnv) {
      throw new Error(
        `"${this._name}" requires an environment. Call .environment(env) or pass one to .build(env).`,
      );
    }
    return this.buildDefinitions(targetEnv);
  }

  private async buildDefinitions(env: Environment): Promise<ColonyDefinition[]> {
    const results: ColonyDefinition[] = [];
    for (const entry of this._colonies) {
      if (entry.configurator) {
        const builder = entry.configurator(colonyBuilder(entry.name));
        if (!builder.hasEnvironment()) {
          builder.in(env);
        }
        results.push(builder.build());
      } else if (entry.moduleRef) {
        // For module refs, resolve via dynamic import (works for local host)
        const configurator = await resolveModuleRef(entry.moduleRef);
        const builder = configurator(colonyBuilder(entry.name));
        if (!builder.hasEnvironment()) {
          builder.in(env);
        }
        results.push(builder.build());
      }
    }
    return results;
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
 * Resolve a ColonyModuleRef to a live configurator function via dynamic import.
 * Used by LocalHost to run module-ref-based colonies locally.
 */
async function resolveModuleRef(ref: ColonyModuleRef): Promise<ColonyConfigurator> {
  const mod = await import(ref.module);
  const fn = mod[ref.export];
  if (typeof fn !== 'function') {
    throw new Error(
      `Module "${ref.module}" does not export a function named "${ref.export}"`,
    );
  }
  const result = fn(...(ref.args ?? []));
  if (typeof result !== 'function') {
    throw new Error(
      `"${ref.export}" from "${ref.module}" must return a configurator function (builder => builder), got ${typeof result}`,
    );
  }
  return result;
}

/**
 * Entry point for the mandible DSL.
 *
 * @example
 * const env = new FilesystemEnvironment({ root: '/tmp/demo' });
 * const host = await mandible('my-swarm')
 *   .environment(env)         // where signals live
 *   .host(local())            // where code runs (optional, defaults to local)
 *   .colony('worker', c => c
 *     .sense('task:new')
 *     .do('process', async (signal, ctx) => { ... })
 *   )
 *   .start();
 *
 * // Deployment metadata available immediately:
 * console.log(host.metadata.id, host.metadata.startedAt);
 *
 * // Dashboard is opt-in:
 * await host.dashboard({ port: 4040 });
 */
export function mandible(name: string): MandibleBuilder {
  return new MandibleBuilder(name);
}
