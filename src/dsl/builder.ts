// ============================================================
// Colony DSL — Fluent Builder
// ============================================================
// Usage:
//
//   const shaper = colony('shaper')
//     .in(env)
//     .sense('task:ready', { unclaimed: true })
//     .when(signal => signal.payload.priority > 0)
//     .do('shape-code', async (signal, ctx) => {
//       const result = await shapeCode(signal.payload);
//       await ctx.deposit('artifact:shaped', result, {
//         causedBy: [signal.id],
//       });
//       await ctx.withdraw(signal.id);
//     })
//     .concurrency(3)
//     .claim('lease', 30_000)
//     .build();
//
// ============================================================

import type {
  ColonyDefinition,
  Environment,
  SensorConfig,
  Rule,
  SignalQuery,
  Signal,
  ActionContext,
  ClaimStrategy,
  ColonyConfig,
} from '../core/types.js';

export class ColonyBuilder<T = Record<string, unknown>> {
  private _name: string;
  private _env?: Environment;
  private _sensors: SensorConfig[] = [];
  private _rules: Rule<T>[] = [];
  private _concurrency = 1;
  private _claimStrategy: ClaimStrategy = 'exclusive';
  private _claimLease?: number;
  private _config: ColonyConfig = {};
  private _pendingGuard?: (signal: Signal<T>) => boolean | Promise<boolean>;

  constructor(name: string) {
    this._name = name;
  }

  /** Set the environment this colony operates in */
  in(env: Environment): this {
    this._env = env;
    return this;
  }

  /** Add a sensor — what signal types this colony watches for */
  sense(type: string | string[], queryOpts?: Partial<Omit<SignalQuery, 'type'>>): this {
    this._sensors.push({
      query: {
        type,
        ...queryOpts,
      },
    });
    return this;
  }

  /** Add a guard condition for the next rule */
  when(predicate: (signal: Signal<T>) => boolean | Promise<boolean>): this {
    this._pendingGuard = predicate;
    return this;
  }

  /** Define a rule action. Consumes any pending `when` guard. */
  do(
    nameOrAction: string | ((signal: Signal<T>, ctx: ActionContext) => Promise<void>),
    action?: (signal: Signal<T>, ctx: ActionContext) => Promise<void>
  ): this {
    const ruleName = typeof nameOrAction === 'string' ? nameOrAction : 'default';
    const ruleAction = typeof nameOrAction === 'function' ? nameOrAction : action!;

    this._rules.push({
      name: ruleName,
      when: this._pendingGuard,
      do: ruleAction,
      priority: this._rules.length, // implicit ordering
    });

    this._pendingGuard = undefined;
    return this;
  }

  /** Set max concurrent agent tasks */
  concurrency(n: number): this {
    this._concurrency = n;
    return this;
  }

  /** Set the claim strategy */
  claim(strategy: ClaimStrategy, leaseDuration?: number): this {
    this._claimStrategy = strategy;
    if (leaseDuration) this._claimLease = leaseDuration;
    return this;
  }

  /** Set the default poll interval for sensors */
  poll(intervalMs: number): this {
    this._config.defaultPollInterval = intervalMs;
    return this;
  }

  /** Auto-withdraw signals after processing */
  autoWithdraw(enabled = true): this {
    this._config.autoWithdraw = enabled;
    return this;
  }

  /** Set action timeout */
  timeout(ms: number): this {
    this._config.actionTimeout = ms;
    return this;
  }

  /** Configure retry behavior */
  retry(maxAttempts: number, backoffMs = 1000): this {
    this._config.retry = { maxAttempts, backoffMs };
    return this;
  }

  /** Configure heartbeat — periodic signals during long-running actions */
  heartbeat(intervalMs: number, opts?: { ttl?: number; type?: string }): this {
    this._config.heartbeat = { interval: intervalMs, ttl: opts?.ttl, type: opts?.type };
    return this;
  }

  /** Additional config overrides */
  configure(config: Partial<ColonyConfig>): this {
    this._config = { ...this._config, ...config };
    return this;
  }

  /** Build the colony definition (does not start it) */
  build(): ColonyDefinition<T> {
    if (!this._env) {
      throw new Error(`Colony "${this._name}" requires an environment. Call .in(env) first.`);
    }

    if (this._sensors.length === 0) {
      throw new Error(`Colony "${this._name}" has no sensors. Call .sense() at least once.`);
    }

    if (this._rules.length === 0) {
      throw new Error(`Colony "${this._name}" has no rules. Call .do() at least once.`);
    }

    // Apply default sensor config
    for (const sensor of this._sensors) {
      sensor.pollInterval ??= this._config.defaultPollInterval ?? 2000;
      sensor.mode ??= 'poll';
    }

    return {
      name: this._name,
      environment: this._env,
      sensors: this._sensors,
      rules: this._rules,
      concurrency: this._concurrency,
      claimStrategy: this._claimStrategy,
      config: this._config,
    };
  }
}

/**
 * Entry point for the colony DSL.
 *
 * @example
 * const critic = colony('critic')
 *   .in(env)
 *   .sense('artifact:shaped', { unclaimed: true })
 *   .do('review', async (signal, ctx) => {
 *     const quality = await reviewCode(signal.payload.code);
 *     if (quality.passes) {
 *       await ctx.deposit('review:approved', { artifact: signal.id });
 *     } else {
 *       await ctx.deposit('review:changes-needed', quality.feedback);
 *     }
 *   })
 *   .concurrency(2)
 *   .claim('lease', 60_000)
 *   .build();
 */
export function colony<T = Record<string, unknown>>(name: string): ColonyBuilder<T> {
  return new ColonyBuilder<T>(name);
}
