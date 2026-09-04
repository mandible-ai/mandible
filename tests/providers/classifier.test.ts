// PURPOSE: Tests for withClassifier — classification as a mark-leaving act
// PURPOSE: Uses a custom LLM function as provider so no SDK mocking is needed

import { describe, it, expect, vi } from 'vitest';
import { withClassifier, isClassified, mergeTags, CLASSIFIED_TAG_PREFIX } from '../../src/providers/classifier.js';
import type { Signal, ActionContext } from '../../src/core/types.js';

// ── Helpers ─────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> & { meta?: Partial<Signal['meta']> } = {}): Signal {
  return {
    id: overrides.id ?? 'sig_cls_001',
    type: overrides.type ?? 'task:ready',
    payload: overrides.payload ?? { description: 'Refactor the auth module' },
    meta: {
      deposited_at: Date.now(),
      deposited_by: 'test',
      concentration: 1.0,
      ...overrides.meta,
    },
  };
}

function makeCtx(opts: { enrichThrows?: boolean } = {}) {
  const enriched: Array<{ id: string; changes: any }> = [];
  const released: string[] = [];
  const ctx: ActionContext & { enriched: typeof enriched; released: string[] } = {
    colony: 'test-colony',
    enriched,
    released,
    deposit: vi.fn().mockResolvedValue({} as Signal),
    withdraw: vi.fn().mockResolvedValue(undefined),
    enrich: vi.fn().mockImplementation(async (id: string, changes: any) => {
      if (opts.enrichThrows) throw new Error('no update()');
      enriched.push({ id, changes });
      return {} as Signal;
    }),
    release: vi.fn().mockImplementation(async (id: string) => { released.push(id); }),
    log: vi.fn(),
    heartbeat: vi.fn().mockResolvedValue(undefined),
  };
  return ctx;
}

/** A fake LLM that returns a fixed classification and records calls. */
function fakeLLM(result: Record<string, unknown>) {
  const calls: string[] = [];
  const fn = async (prompt: string) => { calls.push(prompt); return result; };
  return Object.assign(fn, { calls });
}

// ── withClassifier ──────────────────────────────────────────

describe('withClassifier', () => {
  it('writes tags from the model result and stamps classified:<name>', async () => {
    const llm = fakeLLM({ complexity: 'high', kind: 'refactor' });
    const classify = withClassifier<Record<string, unknown>, { complexity: string; kind: string }>({
      model: 'haiku',
      provider: llm,
      prompt: (s) => `Classify: ${s.payload.description}`,
      tags: (r) => [`complexity:${r.complexity}`, `kind:${r.kind}`],
    });

    const signal = makeSignal();
    const ctx = makeCtx();
    await classify(signal, ctx);

    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]).toContain('Refactor the auth module');
    expect(signal.meta.tags).toEqual(['complexity:high', 'kind:refactor', 'classified:default']);
    expect(ctx.enriched).toHaveLength(1);
    expect(ctx.enriched[0].changes.tags).toEqual(signal.meta.tags);
    expect(isClassified(signal)).toBe(true);
    // Deposits nothing, withdraws nothing
    expect(ctx.deposit).not.toHaveBeenCalled();
    expect(ctx.withdraw).not.toHaveBeenCalled();
  });

  it('is a no-op on an already-classified signal', async () => {
    const llm = fakeLLM({ complexity: 'low' });
    const onClassified = vi.fn();
    const classify = withClassifier({
      model: 'haiku', provider: llm, prompt: 'x',
      tags: (r: any) => [`complexity:${r.complexity}`],
      onClassified,
    });

    const signal = makeSignal({ meta: { tags: ['complexity:high', 'classified:default'] } });
    const ctx = makeCtx();
    await classify(signal, ctx);

    expect(llm.calls).toHaveLength(0);
    expect(ctx.enrich).not.toHaveBeenCalled();
    expect(signal.meta.tags).toEqual(['complexity:high', 'classified:default']);
    expect(onClassified).toHaveBeenCalledWith(signal, [], undefined);
  });

  it('mark: false re-classifies every time', async () => {
    const llm = fakeLLM({ complexity: 'low' });
    const classify = withClassifier({
      model: 'haiku', provider: llm, prompt: 'x', mark: false,
      tags: (r: any) => [`complexity:${r.complexity}`],
    });

    const signal = makeSignal({ meta: { tags: ['classified:default'] } });
    await classify(signal, makeCtx());
    expect(llm.calls).toHaveLength(1); // ran despite the existing marker
    expect(signal.meta.tags).toEqual(['classified:default', 'complexity:low']); // marker left untouched, not re-added

    await classify(signal, makeCtx());
    expect(llm.calls).toHaveLength(2); // and again
  });

  it('replaces existing tags with the same prefix', async () => {
    const llm = fakeLLM({ complexity: 'low' });
    const classify = withClassifier({
      model: 'haiku', provider: llm, prompt: 'x',
      tags: (r: any) => [`complexity:${r.complexity}`],
    });

    const signal = makeSignal({ meta: { tags: ['complexity:high', 'needs-review'] } });
    await classify(signal, makeCtx());
    expect(signal.meta.tags).toEqual(['needs-review', 'complexity:low', 'classified:default']);
  });

  it('replace: false accumulates', async () => {
    const llm = fakeLLM({ complexity: 'low' });
    const classify = withClassifier({
      model: 'haiku', provider: llm, prompt: 'x', replace: false,
      tags: (r: any) => [`complexity:${r.complexity}`],
    });

    const signal = makeSignal({ meta: { tags: ['complexity:high'] } });
    await classify(signal, makeCtx());
    expect(signal.meta.tags).toEqual(['complexity:high', 'complexity:low', 'classified:default']);
  });

  it('separate names coexist on one signal', async () => {
    const a = withClassifier({ name: 'complexity', model: 'haiku', provider: fakeLLM({ c: 'high' }), prompt: 'x', tags: (r: any) => [`complexity:${r.c}`] });
    const b = withClassifier({ name: 'kind', model: 'haiku', provider: fakeLLM({ k: 'bug' }), prompt: 'x', tags: (r: any) => [`kind:${r.k}`] });

    const signal = makeSignal();
    const ctx = makeCtx();
    await a(signal, ctx);
    await b(signal, ctx);

    expect(isClassified(signal, 'complexity')).toBe(true);
    expect(isClassified(signal, 'kind')).toBe(true);
    expect(isClassified(signal, 'default')).toBe(false);
    expect(signal.meta.tags).toContain('complexity:high');
    expect(signal.meta.tags).toContain('kind:bug');
  });

  it('merges payload fields when payload() is provided', async () => {
    const llm = fakeLLM({ complexity: 'high', estimate_hours: 6 });
    const classify = withClassifier({
      model: 'haiku', provider: llm, prompt: 'x',
      tags: (r: any) => [`complexity:${r.complexity}`],
      payload: (r: any) => ({ estimate_hours: r.estimate_hours }),
    });

    const signal = makeSignal();
    const ctx = makeCtx();
    await classify(signal, ctx);

    expect(signal.payload.estimate_hours).toBe(6);
    expect(signal.payload.description).toBe('Refactor the auth module'); // preserved
    expect(ctx.enriched[0].changes.payload).toEqual({ estimate_hours: 6 });
  });

  it('release: true releases the claim after marking (and on skip)', async () => {
    const classify = withClassifier({
      model: 'haiku', provider: fakeLLM({ c: 'low' }), prompt: 'x', release: true,
      tags: (r: any) => [`complexity:${r.c}`],
    });

    const fresh = makeSignal();
    const ctx = makeCtx();
    await classify(fresh, ctx);
    expect(ctx.released).toEqual(['sig_cls_001']);

    const done = makeSignal({ id: 'sig_cls_002', meta: { tags: ['classified:default'] } });
    await classify(done, ctx);
    expect(ctx.released).toEqual(['sig_cls_001', 'sig_cls_002']);
  });

  it('does not release by default', async () => {
    const classify = withClassifier({
      model: 'haiku', provider: fakeLLM({ c: 'low' }), prompt: 'x',
      tags: (r: any) => [`complexity:${r.c}`],
    });
    const ctx = makeCtx();
    await classify(makeSignal(), ctx);
    expect(ctx.release).not.toHaveBeenCalled();
  });

  it('keeps in-memory marks when the environment cannot enrich', async () => {
    const classify = withClassifier({
      model: 'haiku', provider: fakeLLM({ c: 'low' }), prompt: 'x',
      tags: (r: any) => [`complexity:${r.c}`],
    });
    const signal = makeSignal();
    const ctx = makeCtx({ enrichThrows: true });
    await classify(signal, ctx);

    expect(signal.meta.tags).toContain('complexity:low');
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('could not persist'), 'warn');
  });

  it('validates against a schema when provided', async () => {
    const schema = {
      parse: (v: any) => {
        if (!['low', 'high'].includes(v.c)) throw new Error('bad enum');
        return v;
      },
    };
    const classify = withClassifier({
      model: 'haiku', provider: fakeLLM({ c: 'medium' }), prompt: 'x', schema,
      tags: (r: any) => [`complexity:${r.c}`],
    });
    await expect(classify(makeSignal(), makeCtx())).rejects.toThrow(/validation failed/);
  });

  it('calls onClassified with the written tags and result', async () => {
    const onClassified = vi.fn();
    const classify = withClassifier({
      model: 'haiku', provider: fakeLLM({ c: 'high' }), prompt: 'x',
      tags: (r: any) => [`complexity:${r.c}`],
      onClassified,
    });
    const signal = makeSignal();
    await classify(signal, makeCtx());
    expect(onClassified).toHaveBeenCalledWith(signal, ['complexity:high'], { c: 'high' });
  });

  it('rejects a dynamic model with a static Bedrock override at construction', () => {
    expect(() => withClassifier({
      model: () => 'x', provider: 'bedrock',
      bedrockConfig: { region: 'us-east-1', model: 'us.anthropic.something' },
      prompt: 'x', tags: () => [],
    })).toThrow(/cannot be combined/);
  });
});

// ── helpers ─────────────────────────────────────────────────

describe('mergeTags', () => {
  it('replaces by prefix when replace=true', () => {
    expect(mergeTags(['complexity:high', 'x'], ['complexity:low'], true)).toEqual(['x', 'complexity:low']);
  });

  it('does not treat bare tags as prefixes', () => {
    expect(mergeTags(['urgent', 'x'], ['urgent'], true)).toEqual(['x', 'urgent']);
  });

  it('uses the last colon as the prefix boundary', () => {
    // 'route:tag:complexity:high' → prefix 'route:tag:complexity:'
    expect(mergeTags(['route:tag:complexity:low'], ['route:tag:complexity:high'], true))
      .toEqual(['route:tag:complexity:high']);
  });

  it('dedupes exact matches regardless of replace', () => {
    expect(mergeTags(['a', 'b'], ['b'], false)).toEqual(['a', 'b']);
  });
});

describe('isClassified', () => {
  it('reads the marker by name', () => {
    expect(isClassified(makeSignal())).toBe(false);
    expect(isClassified(makeSignal({ meta: { tags: [`${CLASSIFIED_TAG_PREFIX}default`] } }))).toBe(true);
    expect(isClassified(makeSignal({ meta: { tags: [`${CLASSIFIED_TAG_PREFIX}other`] } }), 'other')).toBe(true);
    expect(isClassified(makeSignal({ meta: { tags: [`${CLASSIFIED_TAG_PREFIX}other`] } }))).toBe(false);
  });
});
