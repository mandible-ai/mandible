// PURPOSE: Tests for the stigmergic model router
// PURPOSE: Verifies signal-driven routing, trail tags, escalation, matchers, selectors

import { describe, it, expect, vi } from 'vitest';
import {
  withModelRouter,
  selectModel,
  byTag,
  byConcentration,
  byType,
  byPayload,
  byEscalation,
  escalationLevel,
  routedVia,
} from '../../src/providers/model-router.js';
import type { Signal, ActionContext } from '../../src/core/types.js';

// ── Helpers ─────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> & { meta?: Partial<Signal['meta']> } = {}): Signal {
  return {
    id: 'sig_test_001',
    type: overrides.type ?? 'task:ready',
    payload: overrides.payload ?? {},
    meta: {
      deposited_at: Date.now(),
      deposited_by: 'test',
      concentration: 1.0,
      ...overrides.meta,
    },
  };
}

function makeCtx(opts: { enrichThrows?: boolean } = {}): ActionContext & { enriched: Array<{ id: string; tags?: string[] }> } {
  const enriched: Array<{ id: string; tags?: string[] }> = [];
  return {
    colony: 'test-colony',
    enriched,
    deposit: vi.fn().mockResolvedValue({} as Signal),
    withdraw: vi.fn().mockResolvedValue(undefined),
    enrich: vi.fn().mockImplementation(async (id: string, changes: { tags?: string[] }) => {
      if (opts.enrichThrows) throw new Error('Environment does not support update()');
      enriched.push({ id, tags: changes.tags });
      return {} as Signal;
    }),
    release: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    heartbeat: vi.fn().mockResolvedValue(undefined),
  };
}

const ok = () => vi.fn().mockResolvedValue(undefined);

// ── withModelRouter: dispatch ───────────────────────────────

describe('withModelRouter dispatch', () => {
  it('dispatches to the first matching route', async () => {
    const a = ok(); const b = ok();
    const router = withModelRouter({
      routes: [byTag('fast', a), byTag('slow', b)],
      fallback: ok(),
    });

    await router(makeSignal({ meta: { tags: ['fast'] } }), makeCtx());
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it('first match wins when multiple routes match', async () => {
    const a = ok(); const b = ok();
    const router = withModelRouter({
      routes: [
        { name: 'a', match: () => true, use: a },
        { name: 'b', match: () => true, use: b },
      ],
      fallback: ok(),
    });

    await router(makeSignal(), makeCtx());
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it('uses fallback when no route matches', async () => {
    const fallback = ok();
    const router = withModelRouter({
      routes: [{ name: 'never', match: () => false, use: ok() }],
      fallback,
    });

    await router(makeSignal(), makeCtx());
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('supports async match predicates', async () => {
    const a = ok();
    const router = withModelRouter({
      routes: [{ name: 'async', match: async () => true, use: a }],
      fallback: ok(),
    });

    await router(makeSignal(), makeCtx());
    expect(a).toHaveBeenCalledOnce();
  });

  it('throws at construction without a fallback', () => {
    expect(() => withModelRouter({
      routes: [],
      fallback: undefined as unknown as ReturnType<typeof ok>,
    })).toThrow(/requires a `fallback`/);
  });

  it('passes signal and context to the matched handler', async () => {
    const handler = ok();
    const router = withModelRouter({
      routes: [{ name: 'all', match: () => true, use: handler }],
      fallback: ok(),
    });

    const signal = makeSignal();
    const ctx = makeCtx();
    await router(signal, ctx);
    expect(handler).toHaveBeenCalledWith(signal, ctx);
  });

  it('calls onRoute with index and name', async () => {
    const onRoute = vi.fn();
    const router = withModelRouter({
      routes: [
        { name: 'never', match: () => false, use: ok() },
        byTag('hard', ok()),
      ],
      fallback: ok(),
      onRoute,
    });

    const signal = makeSignal({ meta: { tags: ['hard'] } });
    await router(signal, makeCtx());
    expect(onRoute).toHaveBeenCalledWith(signal, { index: 1, name: 'tag:hard' });
  });

  it('calls onRoute with -1/fallback for fallback', async () => {
    const onRoute = vi.fn();
    const router = withModelRouter({
      routes: [{ name: 'never', match: () => false, use: ok() }],
      fallback: ok(),
      onRoute,
    });

    await router(makeSignal(), makeCtx());
    expect(onRoute).toHaveBeenCalledWith(expect.anything(), { index: -1, name: 'fallback' });
  });

  it('propagates errors from the handler', async () => {
    const router = withModelRouter({
      routes: [{ name: 'boom', match: () => true, use: vi.fn().mockRejectedValue(new Error('LLM timeout')) }],
      fallback: ok(),
    });

    await expect(router(makeSignal(), makeCtx())).rejects.toThrow('LLM timeout');
  });
});

// ── withModelRouter: trail ──────────────────────────────────

describe('withModelRouter trail', () => {
  it('leaves a route:<name> tag on the signal before dispatch', async () => {
    const handler = vi.fn().mockImplementation(async (signal: Signal) => {
      // Tag must be visible to the handler already
      expect(signal.meta.tags).toContain('route:tag:hard');
    });
    const router = withModelRouter({
      routes: [byTag('hard', handler)],
      fallback: ok(),
    });

    const signal = makeSignal({ meta: { tags: ['hard'] } });
    const ctx = makeCtx();
    await router(signal, ctx);

    expect(handler).toHaveBeenCalledOnce();
    expect(ctx.enriched).toHaveLength(1);
    expect(ctx.enriched[0].tags).toEqual(['hard', 'route:tag:hard']);
    expect(routedVia(signal)).toBe('tag:hard');
  });

  it('records route:fallback when falling back', async () => {
    const router = withModelRouter({ routes: [], fallback: ok() });
    const signal = makeSignal();
    await router(signal, makeCtx());
    expect(routedVia(signal)).toBe('fallback');
  });

  it('replaces a stale route tag rather than accumulating', async () => {
    const router = withModelRouter({ routes: [byTag('x', ok())], fallback: ok() });
    const signal = makeSignal({ meta: { tags: ['route:old', 'x'] } });
    await router(signal, makeCtx());
    expect(signal.meta.tags?.filter(t => t.startsWith('route:'))).toEqual(['route:tag:x']);
  });

  it('trail: false skips enrichment', async () => {
    const router = withModelRouter({ routes: [], fallback: ok(), trail: false });
    const signal = makeSignal();
    const ctx = makeCtx();
    await router(signal, ctx);
    expect(ctx.enrich).not.toHaveBeenCalled();
    expect(signal.meta.tags).toBeUndefined();
  });

  it('still dispatches when the environment cannot enrich', async () => {
    const handler = ok();
    const router = withModelRouter({ routes: [], fallback: handler });
    const signal = makeSignal();
    await router(signal, makeCtx({ enrichThrows: true }));
    expect(handler).toHaveBeenCalledOnce();
    // Local mutation still happened
    expect(routedVia(signal)).toBe('fallback');
  });
});

// ── withModelRouter: escalation ─────────────────────────────

describe('withModelRouter escalation', () => {
  it('bumps escalation tag on failure and rethrows', async () => {
    const router = withModelRouter({
      routes: [],
      fallback: vi.fn().mockRejectedValue(new Error('cheap model failed')),
    });

    const signal = makeSignal();
    const ctx = makeCtx();
    await expect(router(signal, ctx)).rejects.toThrow('cheap model failed');

    expect(escalationLevel(signal)).toBe(1);
    // Two enrich calls: route trail, then escalation
    expect(ctx.enriched).toHaveLength(2);
    expect(ctx.enriched[1].tags).toContain('escalation:1');
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('escalation level now 1'), 'warn');
  });

  it('increments an existing escalation level', async () => {
    const router = withModelRouter({
      routes: [],
      fallback: vi.fn().mockRejectedValue(new Error('again')),
    });

    const signal = makeSignal({ meta: { tags: ['escalation:2'] } });
    await expect(router(signal, makeCtx())).rejects.toThrow();
    expect(escalationLevel(signal)).toBe(3);
    expect(signal.meta.tags?.filter(t => t.startsWith('escalation:'))).toEqual(['escalation:3']);
  });

  it('escalate: false leaves tags alone on failure', async () => {
    const router = withModelRouter({
      routes: [],
      fallback: vi.fn().mockRejectedValue(new Error('x')),
      escalate: false,
    });

    const signal = makeSignal();
    await expect(router(signal, makeCtx())).rejects.toThrow();
    expect(escalationLevel(signal)).toBe(0);
  });

  it('simulated runtime retry routes to a stronger tier after failure', async () => {
    const cheap = vi.fn().mockRejectedValue(new Error('haiku gave up'));
    const strong = ok();

    const router = withModelRouter({
      routes: [
        byEscalation(1, strong),
        byTag('complexity:low', cheap),
      ],
      fallback: ok(),
    });

    // Same signal object is passed on each retry, as the runtime does
    const signal = makeSignal({ meta: { tags: ['complexity:low'] } });
    const ctx = makeCtx();

    await expect(router(signal, ctx)).rejects.toThrow('haiku gave up');
    expect(cheap).toHaveBeenCalledOnce();

    await router(signal, ctx); // retry
    expect(strong).toHaveBeenCalledOnce();
    expect(cheap).toHaveBeenCalledOnce(); // not called again
    expect(routedVia(signal)).toBe('escalation>=1');
  });
});

// ── withModelRouter: classify on miss ───────────────────────

describe('withModelRouter classify', () => {
  it('runs the classifier only when no route matches, then routes on its marks', async () => {
    const opus = ok(); const haiku = ok(); const fallback = ok();
    const classifier = vi.fn().mockImplementation(async (signal: Signal) => {
      signal.meta.tags = [...(signal.meta.tags ?? []), 'complexity:high', 'classified:default'];
    });

    const router = withModelRouter({
      classify: classifier,
      routes: [byTag('complexity:high', opus), byTag('complexity:low', haiku)],
      fallback,
    });

    // Unmarked → classifier runs → routes to opus
    const unmarked = makeSignal();
    await router(unmarked, makeCtx());
    expect(classifier).toHaveBeenCalledOnce();
    expect(opus).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();

    // Already marked (e.g. a GitHub label) → classifier skipped
    await router(makeSignal({ meta: { tags: ['complexity:low'] } }), makeCtx());
    expect(classifier).toHaveBeenCalledOnce();
    expect(haiku).toHaveBeenCalledOnce();
  });

  it('falls back if the classifier leaves marks no route understands', async () => {
    const fallback = ok();
    const router = withModelRouter({
      classify: vi.fn().mockImplementation(async (s: Signal) => { s.meta.tags = ['kind:mystery']; }),
      routes: [byTag('complexity:high', ok())],
      fallback,
    });
    await router(makeSignal(), makeCtx());
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('propagates classifier errors and escalates', async () => {
    const router = withModelRouter({
      classify: vi.fn().mockRejectedValue(new Error('classifier down')),
      routes: [],
      fallback: ok(),
    });
    const signal = makeSignal();
    await expect(router(signal, makeCtx())).rejects.toThrow('classifier down');
    // Classifier failure happens before dispatch — no escalation mark, since no route ran
    expect(escalationLevel(signal)).toBe(0);
  });
});

// ── Route helpers ───────────────────────────────────────────

describe('byTag', () => {
  it('matches when signal has the tag', () => {
    const route = byTag('complexity:high', ok());
    expect(route.match(makeSignal({ meta: { tags: ['complexity:high', 'priority'] } }))).toBe(true);
    expect(route.name).toBe('tag:complexity:high');
  });

  it('does not match when tag is absent or tags undefined', () => {
    const route = byTag('complexity:high', ok());
    expect(route.match(makeSignal({ meta: { tags: ['complexity:low'] } }))).toBe(false);
    expect(route.match(makeSignal({ meta: {} }))).toBe(false);
  });
});

describe('byConcentration', () => {
  it('matches when concentration >= threshold', () => {
    const route = byConcentration(0.8, ok());
    expect(route.match(makeSignal({ meta: { concentration: 0.9 } }))).toBe(true);
    expect(route.match(makeSignal({ meta: { concentration: 0.8 } }))).toBe(true);
    expect(route.match(makeSignal({ meta: { concentration: 0.79 } }))).toBe(false);
  });
});

describe('byType', () => {
  it('matches exact type', () => {
    expect(byType('task:ready', ok()).match(makeSignal({ type: 'task:ready' }))).toBe(true);
  });

  it('uses sensor glob semantics: * within a segment, ** across', () => {
    const single = byType('task:*', ok());
    expect(single.match(makeSignal({ type: 'task:ready' }))).toBe(true);
    expect(single.match(makeSignal({ type: 'task:sub:ready' }))).toBe(false);
    expect(single.match(makeSignal({ type: 'review:done' }))).toBe(false);

    const deep = byType('task:**', ok());
    expect(deep.match(makeSignal({ type: 'task:sub:ready' }))).toBe(true);
  });

  it('escapes regex metacharacters in the pattern', () => {
    const route = byType('task.ready', ok());
    expect(route.match(makeSignal({ type: 'task.ready' }))).toBe(true);
    expect(route.match(makeSignal({ type: 'taskXready' }))).toBe(false);
  });

  it('anchored — partial matches rejected', () => {
    expect(byType('task', ok()).match(makeSignal({ type: 'task:ready' }))).toBe(false);
  });
});

describe('byPayload', () => {
  it('matches payload field value', () => {
    const route = byPayload('priority', 'critical', ok());
    expect(route.match(makeSignal({ payload: { priority: 'critical' } }))).toBe(true);
    expect(route.match(makeSignal({ payload: { priority: 'low' } }))).toBe(false);
    expect(route.match(makeSignal({ payload: {} }))).toBe(false);
  });
});

describe('byEscalation', () => {
  it('matches at or above the level', () => {
    const route = byEscalation(2, ok());
    expect(route.match(makeSignal({ meta: { tags: ['escalation:2'] } }))).toBe(true);
    expect(route.match(makeSignal({ meta: { tags: ['escalation:3'] } }))).toBe(true);
    expect(route.match(makeSignal({ meta: { tags: ['escalation:1'] } }))).toBe(false);
    expect(route.match(makeSignal())).toBe(false);
  });
});

describe('escalationLevel', () => {
  it('returns 0 for missing or malformed tag', () => {
    expect(escalationLevel(makeSignal())).toBe(0);
    expect(escalationLevel(makeSignal({ meta: { tags: ['escalation:abc'] } }))).toBe(0);
  });
});

// ── selectModel ─────────────────────────────────────────────

describe('selectModel', () => {
  it('returns model for first matching rule, default otherwise', () => {
    const selector = selectModel({
      rules: [
        { match: (s) => s.meta.tags?.includes('hard') ?? false, model: 'opus' },
        { match: (s) => s.meta.tags?.includes('easy') ?? false, model: 'haiku' },
      ],
      default: 'sonnet',
    });

    expect(selector(makeSignal({ meta: { tags: ['hard'] } }))).toBe('opus');
    expect(selector(makeSignal({ meta: { tags: ['easy'] } }))).toBe('haiku');
    expect(selector(makeSignal())).toBe('sonnet');
  });

  it('first rule wins with multiple matches', () => {
    const selector = selectModel({
      rules: [
        { match: () => true, model: 'first' },
        { match: () => true, model: 'second' },
      ],
      default: 'default',
    });
    expect(selector(makeSignal())).toBe('first');
  });

  it('can key on escalation level', () => {
    const selector = selectModel({
      rules: [{ match: (s) => escalationLevel(s) > 0, model: 'opus' }],
      default: 'haiku',
    });
    expect(selector(makeSignal({ meta: { tags: ['escalation:1'] } }))).toBe('opus');
    expect(selector(makeSignal())).toBe('haiku');
  });
});

// ── Composition ─────────────────────────────────────────────

describe('route composition', () => {
  it('tag-based tiering mirrors GitHub label workflow', async () => {
    const opus = ok(); const sonnet = ok(); const haiku = ok(); const fallback = ok();

    const router = withModelRouter({
      routes: [
        byTag('complexity:high', opus),
        byTag('complexity:medium', sonnet),
        byTag('complexity:low', haiku),
      ],
      fallback,
    });

    await router(makeSignal({ meta: { tags: ['complexity:high'] } }), makeCtx());
    await router(makeSignal({ meta: { tags: ['complexity:medium'] } }), makeCtx());
    await router(makeSignal({ meta: { tags: ['complexity:low'] } }), makeCtx());
    await router(makeSignal({ meta: { tags: ['unrelated'] } }), makeCtx());

    expect(opus).toHaveBeenCalledOnce();
    expect(sonnet).toHaveBeenCalledOnce();
    expect(haiku).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('mixed matchers respect declaration order', async () => {
    const critical = ok(); const standard = ok();
    const router = withModelRouter({
      routes: [byTag('urgent', critical), byType('task:*', standard)],
      fallback: ok(),
    });

    await router(makeSignal({ type: 'task:ready', meta: { tags: ['urgent'] } }), makeCtx());
    expect(critical).toHaveBeenCalledOnce();
    expect(standard).not.toHaveBeenCalled();
  });
});
