// ============================================================
// withModelRouter — Stigmergic Model Routing
// ============================================================
// Routes signals to different LLM providers/models based on
// signal properties (tags, type, payload, concentration).
//
// Instead of a central classifier, the environment itself encodes
// routing intent: GitHub labels become tags, depositors set
// concentration, prior failures leave escalation marks. The colony
// reacts to what's already in the substrate — and leaves its own
// marks behind:
//
//   route:<name>     — which route handled the signal
//   escalation:<n>   — how many times routing has been bumped
//                      after a failure
//
// Those tags are written back via ctx.enrich(), so downstream
// colonies (a Critic, say) can see which tier produced an artifact
// by walking caused_by, and a retry after failure routes higher
// instead of hammering the same model.
//
// Usage:
//
//   colony('worker')
//     .in(githubEnv)
//     .sense('task:ready', { unclaimed: true })
//     .retry(3)
//     .do('process', withModelRouter({
//       routes: [
//         byEscalation(1, withClaudeCode({ model: 'opus', prompt })),   // retry after failure
//         byTag('complexity:high', withClaudeCode({ model: 'opus', prompt })),
//         byTag('complexity:low', withStructuredOutput({ model: 'haiku', ... })),
//       ],
//       fallback: withClaudeCode({ model: 'sonnet', prompt }),
//     }))
//     .build();
//
// Model strings accept tier aliases ('fable' | 'opus' | 'sonnet' |
// 'haiku') — see ./models.ts — so colonies never pin dated IDs.
// ============================================================

import type { Signal, ActionContext, Environment, SignalQuery } from '../core/types.js';
import { matchType, matchesQuery } from '../core/signal.js';
import { walkLineage } from './context.js';
import type { ActionHandler } from './types.js';

export const ROUTE_TAG_PREFIX = 'route:';
export const ESCALATION_TAG_PREFIX = 'escalation:';

/**
 * A single route: a match predicate paired with the handler to use.
 * `name` is recorded on the signal as `route:<name>` when it fires.
 */
export interface ModelRoute<T = Record<string, unknown>> {
  name: string;
  match: (signal: Signal<T>) => boolean | Promise<boolean>;
  use: ActionHandler<T>;
}

/**
 * Config for the model router.
 */
export interface ModelRouterConfig<T = Record<string, unknown>> {
  routes: ModelRoute<T>[];

  /**
   * Handler when no route matches. Required: the enclosing rule has
   * already claimed the signal by the time the router runs, so a
   * router with no total coverage would strand signals until their
   * lease expires.
   */
  fallback: ActionHandler<T>;

  /**
   * Classifier to run when no route matches — typically withClassifier().
   * It writes marks (tags) onto the signal; the routes are then evaluated
   * once more before falling back. Signals that arrive already marked
   * (e.g. labeled GitHub issues) never trigger it.
   */
  classify?: ActionHandler<T>;

  /**
   * Leave a `route:<name>` tag on the signal before dispatch (default true).
   * Written through ctx.enrich() — on a GitHub environment this shows up
   * as a label on the issue. Silently skipped if the environment has no
   * update() support.
   */
  trail?: boolean;

  /**
   * On handler failure, bump the signal's `escalation:<n>` tag before
   * rethrowing (default true). Combined with colony `.retry(n)`, the
   * next attempt sees the higher level and `byEscalation()` routes can
   * send it to a stronger model.
   */
  escalate?: boolean;

  /** Observability hook — called with the chosen route (index -1 = fallback). */
  onRoute?: (signal: Signal<T>, route: { index: number; name: string }) => void;
}

/**
 * Creates an action handler that dispatches to different providers
 * based on signal properties. First matching route wins.
 */
export function withModelRouter<T = Record<string, unknown>>(
  config: ModelRouterConfig<T>
): ActionHandler<T> {
  const { routes, fallback, classify, trail = true, escalate = true, onRoute } = config;

  if (!fallback) {
    throw new Error('withModelRouter requires a `fallback` handler so every claimed signal has somewhere to go.');
  }

  type Chosen = { index: number; name: string; use: ActionHandler<T> };

  const pick = async (signal: Signal<T>): Promise<Chosen | undefined> => {
    for (let i = 0; i < routes.length; i++) {
      if (await routes[i].match(signal)) {
        return { index: i, name: routes[i].name, use: routes[i].use };
      }
    }
    return undefined;
  };

  return async (signal: Signal<T>, ctx: ActionContext) => {
    let chosen = await pick(signal);

    // No mark to route on? Ask the classifier to leave one, then look again.
    if (!chosen && classify) {
      await classify(signal, ctx);
      chosen = await pick(signal);
    }

    chosen ??= { index: -1, name: 'fallback', use: fallback };

    onRoute?.(signal, { index: chosen.index, name: chosen.name });

    if (trail) {
      await leaveTrail(signal, ctx, ROUTE_TAG_PREFIX, chosen.name);
    }

    try {
      await chosen.use(signal, ctx);
    } catch (err) {
      if (escalate) {
        const next = escalationLevel(signal) + 1;
        await leaveTrail(signal, ctx, ESCALATION_TAG_PREFIX, String(next));
        ctx.log(`Route "${chosen.name}" failed; escalation level now ${next}`, 'warn');
      }
      throw err;
    }
  };
}

// ----------------------------------------------------------
// Trail helpers — reading and writing routing marks on signals
// ----------------------------------------------------------

/** Current escalation level of a signal (0 if never escalated). */
export function escalationLevel(signal: Signal<any>): number {
  const tag = signal.meta.tags?.find(t => t.startsWith(ESCALATION_TAG_PREFIX));
  if (!tag) return 0;
  const n = parseInt(tag.slice(ESCALATION_TAG_PREFIX.length), 10);
  return Number.isFinite(n) ? n : 0;
}

/** The route name recorded on a signal, if any. */
export function routedVia(signal: Signal<any>): string | undefined {
  const tag = signal.meta.tags?.find(t => t.startsWith(ROUTE_TAG_PREFIX));
  return tag?.slice(ROUTE_TAG_PREFIX.length);
}

/**
 * Replace any existing `<prefix>*` tag with `<prefix><value>`, mutating the
 * local signal (so runtime retries see it) and persisting via ctx.enrich()
 * when the environment supports it.
 */
async function leaveTrail(
  signal: Signal<any>,
  ctx: ActionContext,
  prefix: string,
  value: string,
): Promise<void> {
  const kept = (signal.meta.tags ?? []).filter(t => !t.startsWith(prefix));
  const tags = [...kept, `${prefix}${value}`];
  signal.meta.tags = tags;
  try {
    await ctx.enrich(signal.id, { tags });
  } catch {
    // Environment has no update() — the local mutation still guides retries.
  }
}

// ----------------------------------------------------------
// Route helpers — convenience matchers for common patterns
// ----------------------------------------------------------

/**
 * Route signals that have a specific tag.
 * Natural fit for GitHub labels → model tier mapping.
 */
export function byTag<T = Record<string, unknown>>(
  tag: string,
  handler: ActionHandler<T>,
): ModelRoute<T> {
  return {
    name: `tag:${tag}`,
    match: (signal) => signal.meta.tags?.includes(tag) ?? false,
    use: handler,
  };
}

/**
 * Route signals whose concentration meets or exceeds a threshold.
 *
 * Note: concentration decays with time by default, so this reads as
 * "fresh signals → this handler". To use it as an explicit priority
 * channel, have depositors set `concentration` and turn off decay for
 * the colony with `.decay(false)`.
 */
export function byConcentration<T = Record<string, unknown>>(
  minConcentration: number,
  handler: ActionHandler<T>,
): ModelRoute<T> {
  return {
    name: `concentration>=${minConcentration}`,
    match: (signal) => signal.meta.concentration >= minConcentration,
    use: handler,
  };
}

/**
 * Route signals matching a type pattern. Uses the same glob rules as
 * sensors: `*` matches within a segment, `**` across segments.
 */
export function byType<T = Record<string, unknown>>(
  typePattern: string,
  handler: ActionHandler<T>,
): ModelRoute<T> {
  return {
    name: `type:${typePattern}`,
    match: (signal) => matchType(signal.type, typePattern),
    use: handler,
  };
}

/**
 * Route signals based on a payload field value.
 * Useful when the environment encodes routing hints in the payload.
 */
export function byPayload<T = Record<string, unknown>>(
  field: string,
  value: unknown,
  handler: ActionHandler<T>,
): ModelRoute<T> {
  return {
    name: `payload:${field}=${String(value)}`,
    match: (signal) => (signal.payload as Record<string, unknown>)[field] === value,
    use: handler,
  };
}

/**
 * Route signals whose escalation level is at or above `minLevel`.
 * Place these first so a retried-after-failure signal is caught before
 * the ordinary tiering rules.
 */
export function byEscalation<T = Record<string, unknown>>(
  minLevel: number,
  handler: ActionHandler<T>,
): ModelRoute<T> {
  return {
    name: `escalation>=${minLevel}`,
    match: (signal) => escalationLevel(signal) >= minLevel,
    use: handler,
  };
}

/**
 * Route signals whose ancestry (via caused_by) contains a signal matching
 * the query — routing driven by trails of past outcomes. A task whose
 * previous artifact drew `review:changes-needed` can go straight to a
 * stronger model without anyone throwing an error first.
 *
 * Walks up to `depth` levels (default 3). Requires the environment
 * because lineage lives there, not on the signal.
 */
export function byLineage<T = Record<string, unknown>>(
  opts: {
    environment: Environment;
    type?: string | string[];
    tags?: string[];
    filter?: (ancestor: Signal) => boolean;
    depth?: number;
  },
  handler: ActionHandler<T>,
): ModelRoute<T> {
  const { environment, depth = 3, ...query } = opts;
  const label = Array.isArray(query.type) ? query.type.join('|') : (query.type ?? '*');
  return {
    name: `lineage:${label}`,
    match: async (signal) => {
      const ancestors = await walkLineage(signal as unknown as Signal, environment, depth);
      return ancestors.some(a => matchesQuery(a, query as SignalQuery));
    },
    use: handler,
  };
}

// ----------------------------------------------------------
// Model selector — lightweight alternative to full routing
// ----------------------------------------------------------

/**
 * Creates a model selector function for use with dynamic model configs.
 * Maps signal properties to model strings (aliases or full IDs) without
 * switching providers.
 *
 * @example
 *   withClaudeCode({
 *     model: selectModel({
 *       rules: [
 *         { match: (s) => s.meta.tags?.includes('hard'), model: 'opus' },
 *         { match: (s) => escalationLevel(s) > 0, model: 'opus' },
 *         { match: (s) => s.meta.concentration < 0.3, model: 'haiku' },
 *       ],
 *       default: 'sonnet',
 *     }),
 *     prompt: ...
 *   })
 */
export function selectModel<T = Record<string, unknown>>(config: {
  rules: Array<{ match: (signal: Signal<T>) => boolean; model: string }>;
  default: string;
}): (signal: Signal<T>) => string {
  return (signal: Signal<T>) => {
    for (const rule of config.rules) {
      if (rule.match(signal)) return rule.model;
    }
    return config.default;
  };
}
