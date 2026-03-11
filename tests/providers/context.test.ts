// PURPOSE: Tests for the context assembly module (assembleContext, withContext)
// PURPOSE: Covers lineage walking, sibling discovery, related signals, formatting, edge cases

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assembleContext, withContext } from '../../src/providers/context.js';
import type { Signal, Environment, SignalQuery } from '../../src/core/types.js';
import type { ContextAssemblyConfig } from '../../src/providers/types.js';

// ── Helpers ─────────────────────────────────────────────────

let idCounter = 0;

function makeSignal(overrides: Partial<Signal> & { id?: string; type?: string } = {}): Signal {
  idCounter++;
  const { meta: metaOverrides, ...rest } = overrides;
  return {
    id: rest.id ?? `sig_${idCounter}`,
    type: rest.type ?? 'task:ready',
    payload: rest.payload ?? { name: 'test-task', description: 'Do something' },
    ...rest,
    meta: {
      deposited_at: Date.now() - 60_000, // 1 minute ago
      deposited_by: 'test-colony',
      concentration: 1.0,
      ...(metaOverrides ?? {}),
    },
  };
}

/**
 * Build a mock Environment from a set of signals.
 * `active` = signals returned by observe(); `historical` = returned by history().
 */
function makeEnv(
  active: Signal[] = [],
  historical: Signal[] = []
): Environment {
  return {
    name: 'test-env',
    async observe(query: SignalQuery) {
      let results = [...active];
      if (query.type) {
        const pattern = typeof query.type === 'string' ? query.type : query.type[0];
        if (pattern.includes('*')) {
          const prefix = pattern.replace('*', '');
          results = results.filter(s => s.type.startsWith(prefix));
        } else {
          results = results.filter(s => s.type === pattern);
        }
      }
      if (query.filter) {
        results = results.filter(query.filter);
      }
      if (query.limit) {
        results = results.slice(0, query.limit);
      }
      return results;
    },
    async history(query: SignalQuery & { includeWithdrawn?: boolean }) {
      let results = [...historical];
      if (query.filter) {
        results = results.filter(query.filter);
      }
      if (query.limit) {
        results = results.slice(0, query.limit);
      }
      return results;
    },
    async deposit() { throw new Error('not implemented'); },
    async withdraw() {},
    async claim() { return false; },
    async release() {},
    watch() { return { unsubscribe() {} }; },
    async decay() { return { decayed: 0, evaporated: 0, claimsReleased: 0 }; },
    async snapshot() { return active; },
  };
}

beforeEach(() => {
  idCounter = 0;
});

// ── assembleContext — basic behavior ─────────────────────────

describe('assembleContext', () => {
  it('returns current signal section with no config', async () => {
    const signal = makeSignal({ id: 'sig_1', type: 'task:ready' });
    const env = makeEnv();

    const result = await assembleContext(signal, env);

    expect(result).toContain('## Current Signal');
    expect(result).toContain('**Type:** task:ready');
    expect(result).toContain('**ID:** sig_1');
    expect(result).toContain('**Deposited by:** test-colony');
    expect(result).toContain('**Concentration:** 1.00');
  });

  it('includes payload as JSON code block', async () => {
    const signal = makeSignal({ payload: { name: 'build-api', priority: 'high' } });
    const env = makeEnv();

    const result = await assembleContext(signal, env);

    expect(result).toContain('```json');
    expect(result).toContain('"name": "build-api"');
    expect(result).toContain('"priority": "high"');
  });

  it('includes tags when present', async () => {
    const signal = makeSignal({ meta: { tags: ['urgent', 'backend'] } as any });
    const env = makeEnv();

    const result = await assembleContext(signal, env);

    expect(result).toContain('**Tags:** urgent, backend');
  });

  it('omits tags line when no tags', async () => {
    const signal = makeSignal();
    const env = makeEnv();

    const result = await assembleContext(signal, env);

    expect(result).not.toContain('**Tags:**');
  });

  // ── Lineage walking ────────────────────────────────────────

  describe('lineage walking', () => {
    it('walks a simple linear chain', async () => {
      const grandparent = makeSignal({ id: 'gp', type: 'task:created' });
      const parent = makeSignal({
        id: 'p',
        type: 'task:shaped',
        meta: { caused_by: ['gp'] } as any,
      });
      const child = makeSignal({
        id: 'c',
        type: 'artifact:ready',
        meta: { caused_by: ['p'] } as any,
      });

      const env = makeEnv([grandparent, parent]);

      const result = await assembleContext(child, env, {
        includeLineage: true,
        lineageDepth: 3,
      });

      expect(result).toContain('## Causal Lineage');
      expect(result).toContain('[task:shaped]');
      expect(result).toContain('[task:created]');
    });

    it('respects lineageDepth limit', async () => {
      const gp = makeSignal({ id: 'gp', type: 'task:created' });
      const parent = makeSignal({
        id: 'p',
        type: 'task:shaped',
        meta: { caused_by: ['gp'] } as any,
      });
      const child = makeSignal({
        id: 'c',
        type: 'artifact:ready',
        meta: { caused_by: ['p'] } as any,
      });

      const env = makeEnv([gp, parent]);

      const result = await assembleContext(child, env, {
        includeLineage: true,
        lineageDepth: 1,
      });

      expect(result).toContain('[task:shaped]');
      // grandparent should NOT appear (depth 1 = only direct parent)
      expect(result).not.toContain('[task:created]');
    });

    it('defaults lineageDepth to 3', async () => {
      // Build 4-level chain: root -> a -> b -> c -> target
      const root = makeSignal({ id: 'root', type: 'task:root' });
      const a = makeSignal({ id: 'a', type: 'task:a', meta: { caused_by: ['root'] } as any });
      const b = makeSignal({ id: 'b', type: 'task:b', meta: { caused_by: ['a'] } as any });
      const c = makeSignal({ id: 'c', type: 'task:c', meta: { caused_by: ['b'] } as any });
      const target = makeSignal({ id: 'target', type: 'task:target', meta: { caused_by: ['c'] } as any });

      const env = makeEnv([root, a, b, c]);

      const result = await assembleContext(target, env, { includeLineage: true });

      // Default depth=3: c, b, a should appear; root (depth 4) should not
      expect(result).toContain('[task:c]');
      expect(result).toContain('[task:b]');
      expect(result).toContain('[task:a]');
      expect(result).not.toContain('[task:root]');
    });

    it('falls back to history when parent not in active signals', async () => {
      const parent = makeSignal({ id: 'p', type: 'task:done' });
      const child = makeSignal({
        id: 'c',
        type: 'artifact:ready',
        meta: { caused_by: ['p'] } as any,
      });

      // parent is withdrawn — only in history
      const env = makeEnv([], [parent]);

      const result = await assembleContext(child, env, {
        includeLineage: true,
        lineageDepth: 2,
      });

      expect(result).toContain('[task:done]');
    });

    it('handles missing parent gracefully', async () => {
      const child = makeSignal({
        id: 'c',
        type: 'artifact:ready',
        meta: { caused_by: ['nonexistent'] } as any,
      });

      const env = makeEnv();

      const result = await assembleContext(child, env, {
        includeLineage: true,
      });

      // Should still produce output, just no lineage section
      expect(result).toContain('## Current Signal');
      expect(result).not.toContain('## Causal Lineage');
    });

    it('handles circular caused_by chains without infinite recursion', async () => {
      // A -> B -> A (cycle)
      const signalA = makeSignal({
        id: 'a',
        type: 'task:a',
        meta: { caused_by: ['b'] } as any,
      });
      const signalB = makeSignal({
        id: 'b',
        type: 'task:b',
        meta: { caused_by: ['a'] } as any,
      });

      const env = makeEnv([signalA, signalB]);

      // This should NOT hang or throw — depth limit prevents infinite recursion
      const result = await assembleContext(signalA, env, {
        includeLineage: true,
        lineageDepth: 10,
      });

      expect(result).toContain('## Causal Lineage');
      expect(result).toContain('[task:b]');
    });

    it('deduplicates signals in diamond DAG', async () => {
      // Diamond: child caused by B and C, both caused by root
      const root = makeSignal({ id: 'root', type: 'task:root' });
      const b = makeSignal({ id: 'b', type: 'task:b', meta: { caused_by: ['root'] } as any });
      const c = makeSignal({ id: 'c', type: 'task:c', meta: { caused_by: ['root'] } as any });
      const child = makeSignal({
        id: 'child',
        type: 'task:child',
        meta: { caused_by: ['b', 'c'] } as any,
      });

      const env = makeEnv([root, b, c]);

      const result = await assembleContext(child, env, {
        includeLineage: true,
        lineageDepth: 3,
      });

      // root should appear only once (deduplicated)
      const rootMatches = result.match(/\[task:root\]/g);
      expect(rootMatches?.length).toBe(1);
    });

    it('handles signal with multiple parents', async () => {
      const p1 = makeSignal({ id: 'p1', type: 'review:approved' });
      const p2 = makeSignal({ id: 'p2', type: 'test:passed' });
      const child = makeSignal({
        id: 'c',
        type: 'deploy:ready',
        meta: { caused_by: ['p1', 'p2'] } as any,
      });

      const env = makeEnv([p1, p2]);

      const result = await assembleContext(child, env, {
        includeLineage: true,
      });

      expect(result).toContain('[review:approved]');
      expect(result).toContain('[test:passed]');
    });

    it('skips lineage section when includeLineage is false', async () => {
      const parent = makeSignal({ id: 'p', type: 'task:done' });
      const child = makeSignal({
        id: 'c',
        type: 'artifact:ready',
        meta: { caused_by: ['p'] } as any,
      });

      const env = makeEnv([parent]);

      const result = await assembleContext(child, env, {
        includeLineage: false,
      });

      expect(result).not.toContain('## Causal Lineage');
    });

    it('skips lineage when signal has no caused_by', async () => {
      const signal = makeSignal({ id: 's', type: 'task:ready' });
      const env = makeEnv();

      const result = await assembleContext(signal, env, {
        includeLineage: true,
        lineageDepth: 3,
      });

      expect(result).not.toContain('## Causal Lineage');
    });
  });

  // ── Sibling discovery ──────────────────────────────────────

  describe('sibling discovery', () => {
    it('finds siblings sharing the same parent', async () => {
      const parent = makeSignal({ id: 'parent', type: 'task:created' });
      const sibling1 = makeSignal({
        id: 'sib1',
        type: 'artifact:code',
        meta: { caused_by: ['parent'] } as any,
      });
      const sibling2 = makeSignal({
        id: 'sib2',
        type: 'artifact:test',
        meta: { caused_by: ['parent'] } as any,
      });
      const target = makeSignal({
        id: 'target',
        type: 'artifact:docs',
        meta: { caused_by: ['parent'] } as any,
      });

      const env = makeEnv([parent, sibling1, sibling2, target]);

      const result = await assembleContext(target, env, {
        includeSiblings: true,
      });

      expect(result).toContain('## Related Signals (Same Origin)');
      expect(result).toContain('[artifact:code]');
      expect(result).toContain('[artifact:test]');
      // Should NOT include the target signal itself
      expect(result).not.toMatch(/\[artifact:docs\].*conc:/);
    });

    it('excludes self from siblings', async () => {
      const parent = makeSignal({ id: 'parent', type: 'task:created' });
      const target = makeSignal({
        id: 'target',
        type: 'artifact:code',
        meta: { caused_by: ['parent'] } as any,
      });

      const env = makeEnv([parent, target]);

      const result = await assembleContext(target, env, {
        includeSiblings: true,
      });

      // Only current signal section, no siblings section (only sibling is self)
      expect(result).not.toContain('## Related Signals (Same Origin)');
    });

    it('skips siblings when signal has no caused_by', async () => {
      const signal = makeSignal({ id: 's', type: 'task:ready' });
      const env = makeEnv([signal]);

      const result = await assembleContext(signal, env, {
        includeSiblings: true,
      });

      expect(result).not.toContain('## Related Signals (Same Origin)');
    });

    it('skips siblings section when includeSiblings is false', async () => {
      const parent = makeSignal({ id: 'parent', type: 'task:created' });
      const sibling = makeSignal({
        id: 'sib',
        type: 'artifact:code',
        meta: { caused_by: ['parent'] } as any,
      });
      const target = makeSignal({
        id: 'target',
        type: 'artifact:docs',
        meta: { caused_by: ['parent'] } as any,
      });

      const env = makeEnv([parent, sibling, target]);

      const result = await assembleContext(target, env, {
        includeSiblings: false,
      });

      expect(result).not.toContain('## Related Signals (Same Origin)');
    });
  });

  // ── Related signals by pattern ─────────────────────────────

  describe('related signals by pattern', () => {
    it('fetches related signals matching type pattern', async () => {
      const review1 = makeSignal({ id: 'r1', type: 'review:approved', payload: { text: 'LGTM' } });
      const review2 = makeSignal({ id: 'r2', type: 'review:changes-needed', payload: { text: 'Fix tests' } });
      const unrelated = makeSignal({ id: 'u', type: 'task:ready' });

      const env = makeEnv([review1, review2, unrelated]);
      const signal = makeSignal({ id: 's', type: 'artifact:ready' });

      const result = await assembleContext(signal, env, {
        includeRelated: ['review:*'],
      });

      expect(result).toContain('## Related: review:*');
      expect(result).toContain('[review:approved]');
      expect(result).toContain('[review:changes-needed]');
      expect(result).not.toContain('[task:ready]');
    });

    it('handles multiple related patterns', async () => {
      const review = makeSignal({ id: 'r1', type: 'review:done', payload: { text: 'ok' } });
      const test = makeSignal({ id: 't1', type: 'test:passed', payload: { name: 'unit' } });

      const env = makeEnv([review, test]);
      const signal = makeSignal({ id: 's', type: 'deploy:ready' });

      const result = await assembleContext(signal, env, {
        includeRelated: ['review:*', 'test:*'],
      });

      expect(result).toContain('## Related: review:*');
      expect(result).toContain('## Related: test:*');
    });

    it('skips section when no signals match pattern', async () => {
      const env = makeEnv([]);
      const signal = makeSignal({ id: 's', type: 'task:ready' });

      const result = await assembleContext(signal, env, {
        includeRelated: ['review:*'],
      });

      expect(result).not.toContain('## Related: review:*');
    });

    it('skips related when includeRelated is empty array', async () => {
      const review = makeSignal({ id: 'r1', type: 'review:done', payload: { text: 'ok' } });
      const env = makeEnv([review]);
      const signal = makeSignal({ id: 's', type: 'task:ready' });

      const result = await assembleContext(signal, env, {
        includeRelated: [],
      });

      expect(result).not.toContain('## Related');
    });
  });

  // ── Custom context builder ─────────────────────────────────

  describe('custom context builder', () => {
    it('appends custom context section', async () => {
      const signal = makeSignal();
      const env = makeEnv();

      const result = await assembleContext(signal, env, {
        custom: async () => 'The repo has 42 open PRs and CI is green.',
      });

      expect(result).toContain('## Additional Context');
      expect(result).toContain('The repo has 42 open PRs and CI is green.');
    });

    it('receives signal and env arguments', async () => {
      const signal = makeSignal({ id: 'sig_custom', type: 'task:ready' });
      const env = makeEnv();
      const customFn = vi.fn().mockResolvedValue('custom data');

      await assembleContext(signal, env, { custom: customFn });

      expect(customFn).toHaveBeenCalledWith(signal, env);
    });

    it('skips section when custom returns empty string', async () => {
      const signal = makeSignal();
      const env = makeEnv();

      const result = await assembleContext(signal, env, {
        custom: async () => '',
      });

      expect(result).not.toContain('## Additional Context');
    });
  });

  // ── Section separators ─────────────────────────────────────

  describe('section formatting', () => {
    it('separates sections with horizontal rules', async () => {
      const parent = makeSignal({ id: 'p', type: 'task:created' });
      const child = makeSignal({
        id: 'c',
        type: 'artifact:ready',
        meta: { caused_by: ['p'] } as any,
      });

      const env = makeEnv([parent]);

      const result = await assembleContext(child, env, {
        includeLineage: true,
      });

      expect(result).toContain('\n\n---\n\n');
    });
  });

  // ── Formatting helpers (via assembleContext output) ─────────

  describe('formatting', () => {
    it('summarizes payload with name field', async () => {
      const parent = makeSignal({
        id: 'p',
        type: 'task:created',
        payload: { name: 'Build authentication module' },
      });
      const child = makeSignal({
        id: 'c',
        type: 'artifact:ready',
        meta: { caused_by: ['p'] } as any,
      });

      const env = makeEnv([parent]);

      const result = await assembleContext(child, env, {
        includeLineage: true,
      });

      expect(result).toContain('Build authentication module');
    });

    it('truncates long payload summaries to 60 chars', async () => {
      const longName = 'A'.repeat(100);
      const parent = makeSignal({
        id: 'p',
        type: 'task:created',
        payload: { name: longName },
      });
      const child = makeSignal({
        id: 'c',
        type: 'artifact:ready',
        meta: { caused_by: ['p'] } as any,
      });

      const env = makeEnv([parent]);

      const result = await assembleContext(child, env, {
        includeLineage: true,
      });

      expect(result).toContain('A'.repeat(60) + '...');
      expect(result).not.toContain('A'.repeat(61));
    });

    it('falls back to key listing when no meaningful string field', async () => {
      const parent = makeSignal({
        id: 'p',
        type: 'task:created',
        payload: { count: 42, items: [1, 2], flag: true },
      });
      const child = makeSignal({
        id: 'c',
        type: 'artifact:ready',
        meta: { caused_by: ['p'] } as any,
      });

      const env = makeEnv([parent]);

      const result = await assembleContext(child, env, {
        includeLineage: true,
      });

      expect(result).toContain('{count, items, flag}');
    });

    it('truncates key listing with ellipsis for many keys', async () => {
      const parent = makeSignal({
        id: 'p',
        type: 'task:created',
        payload: { a: 1, b: 2, c: 3, d: 4, e: 5 },
      });
      const child = makeSignal({
        id: 'c',
        type: 'artifact:ready',
        meta: { caused_by: ['p'] } as any,
      });

      const env = makeEnv([parent]);

      const result = await assembleContext(child, env, {
        includeLineage: true,
      });

      expect(result).toContain('{a, b, c, ...}');
    });

    it('shows empty object for empty payload', async () => {
      const parent = makeSignal({
        id: 'p',
        type: 'task:created',
        payload: {},
      });
      const child = makeSignal({
        id: 'c',
        type: 'artifact:ready',
        meta: { caused_by: ['p'] } as any,
      });

      const env = makeEnv([parent]);

      const result = await assembleContext(child, env, {
        includeLineage: true,
      });

      expect(result).toContain('{}');
    });

    it('formats age correctly for recent signals', async () => {
      const signal = makeSignal({
        meta: { deposited_at: Date.now() - 30_000 } as any, // 30s ago
      });
      const env = makeEnv();

      const result = await assembleContext(signal, env);

      expect(result).toMatch(/\d+s ago/);
    });

    it('formats age correctly for older signals', async () => {
      const signal = makeSignal({
        meta: { deposited_at: Date.now() - 7200_000 } as any, // 2 hours ago
      });
      const env = makeEnv();

      const result = await assembleContext(signal, env);

      expect(result).toContain('2h ago');
    });

    it('truncates large payloads in signal section', async () => {
      // Build a payload larger than 2000 chars when serialized
      const largePayload: Record<string, unknown> = {};
      for (let i = 0; i < 100; i++) {
        largePayload[`field_${i}`] = 'x'.repeat(50);
      }
      const signal = makeSignal({ payload: largePayload });
      const env = makeEnv();

      const result = await assembleContext(signal, env);

      // After fix: should be truncated
      expect(result).toContain('**Payload:**');
      // The full serialized payload would be >7000 chars; output should be limited
      expect(result.length).toBeLessThan(10_000);
    });
  });

  // ── Combined features ──────────────────────────────────────

  describe('combined config options', () => {
    it('assembles all sections together', async () => {
      const parent = makeSignal({ id: 'parent', type: 'task:created', payload: { name: 'auth' } });
      const sibling = makeSignal({
        id: 'sib',
        type: 'artifact:test',
        meta: { caused_by: ['parent'] } as any,
      });
      const review = makeSignal({
        id: 'rev',
        type: 'review:done',
        payload: { text: 'Approved' },
      });
      const target = makeSignal({
        id: 'target',
        type: 'artifact:code',
        meta: { caused_by: ['parent'] } as any,
      });

      const env = makeEnv([parent, sibling, review, target]);

      const result = await assembleContext(target, env, {
        includeLineage: true,
        lineageDepth: 2,
        includeSiblings: true,
        includeRelated: ['review:*'],
        custom: async () => 'Build pipeline status: green',
      });

      expect(result).toContain('## Current Signal');
      expect(result).toContain('## Causal Lineage');
      expect(result).toContain('## Related Signals (Same Origin)');
      expect(result).toContain('## Related: review:*');
      expect(result).toContain('## Additional Context');
      expect(result).toContain('Build pipeline status: green');
    });
  });
});

// ── withContext ───────────────────────────────────────────────

describe('withContext', () => {
  it('returns a function that combines base prompt with context', async () => {
    const signal = makeSignal({ id: 's', type: 'task:ready' });
    const env = makeEnv();

    const builder = withContext({});
    const result = await builder('Implement the feature', signal, env);

    expect(result).toContain('Implement the feature');
    expect(result).toContain('# Context from Environment');
    expect(result).toContain('## Current Signal');
  });

  it('passes config through to assembleContext', async () => {
    const parent = makeSignal({ id: 'p', type: 'task:origin' });
    const child = makeSignal({
      id: 'c',
      type: 'artifact:ready',
      meta: { caused_by: ['p'] } as any,
    });
    const env = makeEnv([parent]);

    const builder = withContext({ includeLineage: true, lineageDepth: 1 });
    const result = await builder('Review this artifact', child, env);

    expect(result).toContain('Review this artifact');
    expect(result).toContain('## Causal Lineage');
    expect(result).toContain('[task:origin]');
  });

  it('separates base prompt and context with horizontal rule', async () => {
    const signal = makeSignal();
    const env = makeEnv();

    const builder = withContext({});
    const result = await builder('Do the thing', signal, env);

    expect(result).toContain('Do the thing\n\n---\n\n# Context from Environment');
  });
});
