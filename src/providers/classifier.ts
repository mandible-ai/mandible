// ============================================================
// withClassifier — Classification as a mark-leaving act
// ============================================================
// A classifier looks at a signal, asks a (cheap) model what kind of
// task it is, and writes the answer back onto the signal as tags —
// `complexity:high`, `kind:bug`, whatever your schema produces.
// It deposits nothing and withdraws nothing. The signal stays in the
// environment, now carrying marks that every later reader can use:
// a model router, a retry, a Critic walking lineage, a human looking
// at labels on a GitHub issue.
//
// Classify once, persist in the substrate, never re-classify: the
// classifier stamps `classified:<name>` and is a no-op on any signal
// that already carries that mark.
//
// Two ways to use it:
//
//   // 1. Inline — the router classifies on a miss
//   withModelRouter({
//     classify: withClassifier({ model: 'haiku', schema, prompt, tags }),
//     routes: [byTag('complexity:high', opus), byTag('complexity:low', haiku)],
//     fallback: sonnet,
//   })
//
//   // 2. A classifier colony — marks appear before any worker touches the task
//   colony('classifier')
//     .in(env)
//     .sense('task:ready', { filter: (s) => !isClassified(s) })
//     .do('classify', withClassifier({ model: 'haiku', schema, prompt, tags, release: true }))
//     .claim('lease', 30_000)
//     .build();
// ============================================================

import type { Signal, ActionContext } from '../core/types.js';
import type { ActionHandler } from './types.js';
import {
  generateStructured,
  assertNoDynamicModelWithBedrock,
  type StructuredCallOptions,
} from './structured-output.js';

export const CLASSIFIED_TAG_PREFIX = 'classified:';

export interface ClassifierConfig<T = Record<string, unknown>, R = Record<string, unknown>>
  extends StructuredCallOptions<T, R> {
  /**
   * Name recorded as `classified:<name>` once this classifier has run.
   * Lets several classifiers coexist on one signal. Default: 'default'.
   */
  name?: string;

  /** Turn the model's structured answer into tags to stamp on the signal. */
  tags: (result: R, signal: Signal<T>) => string[];

  /** Optionally merge fields into the signal's payload as well. */
  payload?: (result: R, signal: Signal<T>) => Record<string, unknown>;

  /**
   * When a produced tag looks like `prefix:value`, drop any existing tag
   * with the same `prefix:` before adding it (default true). Keeps one
   * `complexity:*` on the signal instead of accumulating contradictions.
   */
  replace?: boolean;

  /**
   * Stamp `classified:<name>` and skip signals that already carry it
   * (default true). Set false to force re-classification every time.
   */
  mark?: boolean;

  /**
   * Release the colony's claim after marking (default false). Set true
   * when the classifier is its own colony, so workers can claim the
   * signal immediately instead of waiting for the lease to expire.
   * Leave false when used inline in a router — the router still owns
   * the signal.
   */
  release?: boolean;

  /** Observability hook — called with the tags that were written (or [] on skip). */
  onClassified?: (signal: Signal<T>, tags: string[], result: R | undefined) => void;
}

/** True if `signal` already carries a `classified:<name>` mark. */
export function isClassified(signal: Signal<any>, name = 'default'): boolean {
  return signal.meta.tags?.includes(`${CLASSIFIED_TAG_PREFIX}${name}`) ?? false;
}

/**
 * Creates an action handler that classifies a signal and writes the
 * result back as tags. Deposits nothing; withdraws nothing.
 */
export function withClassifier<T = Record<string, unknown>, R = Record<string, unknown>>(
  config: ClassifierConfig<T, R>
): ActionHandler<T> {
  const {
    name = 'default',
    tags: toTags,
    payload: toPayload,
    replace = true,
    mark = true,
    release = false,
    onClassified,
    ...call
  } = config;

  assertNoDynamicModelWithBedrock('withClassifier', call.model, call.bedrockConfig);
  const marker = `${CLASSIFIED_TAG_PREFIX}${name}`;

  return async (signal: Signal<T>, ctx: ActionContext) => {
    if (mark && isClassified(signal, name)) {
      onClassified?.(signal, [], undefined);
      if (release) await ctx.release(signal.id);
      return;
    }

    const { result, model } = await generateStructured<T, R>(call, signal, ctx);

    const newTags = toTags(result, signal);
    const merged = mergeTags(signal.meta.tags ?? [], newTags, replace);
    if (mark) merged.push(marker);

    const payloadChanges = toPayload?.(result, signal);

    // Mutate locally first so a router (or a retry) sees the marks immediately,
    // then persist. Environments without update() keep the in-memory marks.
    signal.meta.tags = merged;
    if (payloadChanges) Object.assign(signal.payload as Record<string, unknown>, payloadChanges);

    try {
      await ctx.enrich(signal.id, { tags: merged, ...(payloadChanges ? { payload: payloadChanges } : {}) });
    } catch (err: any) {
      ctx.log(`Classifier "${name}" could not persist marks: ${err.message}`, 'warn');
    }

    onClassified?.(signal, newTags, result);
    ctx.log(`Classified as [${newTags.join(', ')}] on ${model}`);

    if (release) await ctx.release(signal.id);
  };
}

/**
 * Merge new tags into existing ones. With `replace`, a new `prefix:value`
 * evicts existing `prefix:*` tags. Always drops an existing
 * `classified:*` marker for the same name (caller re-adds it).
 */
export function mergeTags(existing: string[], incoming: string[], replace: boolean): string[] {
  const prefixes = new Set<string>();
  if (replace) {
    for (const tag of incoming) {
      const idx = tag.lastIndexOf(':');
      if (idx > 0) prefixes.add(tag.slice(0, idx + 1));
    }
  }
  const kept = existing.filter(t => {
    if (incoming.includes(t)) return false;
    for (const p of prefixes) if (t.startsWith(p)) return false;
    return true;
  });
  return [...kept, ...incoming];
}
