// PURPOSE: Tests for signal factory and utilities
// PURPOSE: Covers createSignal, matchesQuery, decay, expiration, priority sorting

import { describe, it, expect } from 'vitest';
import {
  createSignal,
  matchesQuery,
  decayConcentration,
  isExpired,
  isClaimExpired,
  prioritize,
} from '../../src/core/signal.js';
import type { Signal } from '../../src/core/types.js';

// ── Helper ──────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> & { meta?: Partial<Signal['meta']> } = {}): Signal {
  const base = createSignal('task:ready', { name: 'test' });
  return {
    ...base,
    ...overrides,
    meta: { ...base.meta, ...overrides.meta },
  };
}

// ── createSignal ────────────────────────────────────────────

describe('createSignal', () => {
  it('generates a unique id with sig_ prefix', () => {
    const s = createSignal('task:ready', {});
    expect(s.id).toMatch(/^sig_/);
  });

  it('generates unique ids across calls', () => {
    const ids = Array.from({ length: 100 }, () => createSignal('x', {}).id);
    expect(new Set(ids).size).toBe(100);
  });

  it('sets type and payload from arguments', () => {
    const s = createSignal('review:approved', { score: 95 });
    expect(s.type).toBe('review:approved');
    expect(s.payload).toEqual({ score: 95 });
  });

  it('defaults concentration to 1.0', () => {
    const s = createSignal('x', {});
    expect(s.meta.concentration).toBe(1.0);
  });

  it('defaults deposited_by to unknown', () => {
    const s = createSignal('x', {});
    expect(s.meta.deposited_by).toBe('unknown');
  });

  it('sets deposited_at to a recent timestamp', () => {
    const before = Date.now();
    const s = createSignal('x', {});
    const after = Date.now();
    expect(s.meta.deposited_at).toBeGreaterThanOrEqual(before);
    expect(s.meta.deposited_at).toBeLessThanOrEqual(after);
  });

  it('applies optional deposited_by', () => {
    const s = createSignal('x', {}, { deposited_by: 'shaper' });
    expect(s.meta.deposited_by).toBe('shaper');
  });

  it('applies optional concentration', () => {
    const s = createSignal('x', {}, { concentration: 0.5 });
    expect(s.meta.concentration).toBe(0.5);
  });

  it('applies optional ttl', () => {
    const s = createSignal('x', {}, { ttl: 30_000 });
    expect(s.meta.ttl).toBe(30_000);
  });

  it('applies optional tags', () => {
    const s = createSignal('x', {}, { tags: ['urgent', 'v2'] });
    expect(s.meta.tags).toEqual(['urgent', 'v2']);
  });

  it('applies optional caused_by', () => {
    const s = createSignal('x', {}, { caused_by: ['sig_parent'] });
    expect(s.meta.caused_by).toEqual(['sig_parent']);
  });

  it('leaves optional fields undefined when not provided', () => {
    const s = createSignal('x', {});
    expect(s.meta.ttl).toBeUndefined();
    expect(s.meta.tags).toBeUndefined();
    expect(s.meta.caused_by).toBeUndefined();
    expect(s.meta.claimed_by).toBeUndefined();
  });

  it('preserves generic payload type', () => {
    const s = createSignal<{ count: number }>('x', { count: 42 });
    expect(s.payload.count).toBe(42);
  });
});

// ── matchesQuery: type matching ─────────────────────────────

describe('matchesQuery — type matching', () => {
  it('matches exact type', () => {
    const s = makeSignal({ type: 'task:ready' });
    expect(matchesQuery(s, { type: 'task:ready' })).toBe(true);
  });

  it('rejects non-matching exact type', () => {
    const s = makeSignal({ type: 'task:ready' });
    expect(matchesQuery(s, { type: 'task:done' })).toBe(false);
  });

  it('matches wildcard suffix task:*', () => {
    const s = makeSignal({ type: 'task:ready' });
    expect(matchesQuery(s, { type: 'task:*' })).toBe(true);
  });

  it('matches wildcard prefix *:ready', () => {
    const s = makeSignal({ type: 'task:ready' });
    expect(matchesQuery(s, { type: '*:ready' })).toBe(true);
  });

  it('does not match wildcard across colon segments', () => {
    // * matches within a segment (non-colon chars), not across colons
    const s = makeSignal({ type: 'task:sub:ready' });
    expect(matchesQuery(s, { type: 'task:*' })).toBe(false);
  });

  it('matches ** across colon segments', () => {
    expect(matchesQuery(makeSignal({ type: 'task:sub:ready' }), { type: 'task:**' })).toBe(true);
    expect(matchesQuery(makeSignal({ type: 'task:ready' }), { type: 'task:**' })).toBe(true);
    expect(matchesQuery(makeSignal({ type: 'review:done' }), { type: 'task:**' })).toBe(false);
    // ** and * can mix
    expect(matchesQuery(makeSignal({ type: 'a:b:c:ready' }), { type: '**:ready' })).toBe(true);
  });

  it('matches bare * against any type', () => {
    expect(matchesQuery(makeSignal({ type: 'task:ready' }), { type: '*' })).toBe(true);
    expect(matchesQuery(makeSignal({ type: 'review:approved' }), { type: '*' })).toBe(true);
    expect(matchesQuery(makeSignal({ type: 'x' }), { type: '*' })).toBe(true);
  });

  it('matches with array of type patterns (OR logic)', () => {
    const s = makeSignal({ type: 'review:approved' });
    expect(matchesQuery(s, { type: ['task:*', 'review:*'] })).toBe(true);
  });

  it('rejects when no array pattern matches', () => {
    const s = makeSignal({ type: 'artifact:shaped' });
    expect(matchesQuery(s, { type: ['task:*', 'review:*'] })).toBe(false);
  });

  it('matches everything when no type specified', () => {
    const s = makeSignal({ type: 'anything:here' });
    expect(matchesQuery(s, {})).toBe(true);
  });
});

// ── matchesQuery: concentration filter ──────────────────────

describe('matchesQuery — concentration filter', () => {
  it('passes when concentration meets threshold', () => {
    const s = makeSignal({ meta: { concentration: 0.8 } });
    expect(matchesQuery(s, { minConcentration: 0.5 })).toBe(true);
  });

  it('passes when concentration equals threshold', () => {
    const s = makeSignal({ meta: { concentration: 0.5 } });
    expect(matchesQuery(s, { minConcentration: 0.5 })).toBe(true);
  });

  it('rejects when concentration is below threshold', () => {
    const s = makeSignal({ meta: { concentration: 0.3 } });
    expect(matchesQuery(s, { minConcentration: 0.5 })).toBe(false);
  });

  it('ignores concentration when not specified', () => {
    const s = makeSignal({ meta: { concentration: 0.01 } });
    expect(matchesQuery(s, {})).toBe(true);
  });
});

// ── matchesQuery: unclaimed filter ──────────────────────────

describe('matchesQuery — unclaimed filter', () => {
  it('passes unclaimed signals when unclaimed=true', () => {
    const s = makeSignal();
    expect(matchesQuery(s, { unclaimed: true })).toBe(true);
  });

  it('rejects claimed signals when unclaimed=true', () => {
    const s = makeSignal({ meta: { claimed_by: 'critic' } });
    expect(matchesQuery(s, { unclaimed: true })).toBe(false);
  });

  it('passes claimed signals when unclaimed is not set', () => {
    const s = makeSignal({ meta: { claimed_by: 'critic' } });
    expect(matchesQuery(s, {})).toBe(true);
  });
});

// ── matchesQuery: tags filter ───────────────────────────────

describe('matchesQuery — tags filter', () => {
  it('passes when signal has all required tags', () => {
    const s = makeSignal({ meta: { tags: ['urgent', 'v2', 'backend'] } });
    expect(matchesQuery(s, { tags: ['urgent', 'v2'] })).toBe(true);
  });

  it('rejects when signal is missing a required tag', () => {
    const s = makeSignal({ meta: { tags: ['urgent'] } });
    expect(matchesQuery(s, { tags: ['urgent', 'v2'] })).toBe(false);
  });

  it('rejects when signal has no tags', () => {
    const s = makeSignal();
    expect(matchesQuery(s, { tags: ['urgent'] })).toBe(false);
  });

  it('ignores tags filter when empty array', () => {
    const s = makeSignal();
    expect(matchesQuery(s, { tags: [] })).toBe(true);
  });
});

// ── matchesQuery: time filter ───────────────────────────────

describe('matchesQuery — after filter', () => {
  it('passes signals deposited after the threshold', () => {
    const s = makeSignal({ meta: { deposited_at: 2000 } });
    expect(matchesQuery(s, { after: 1000 })).toBe(true);
  });

  it('rejects signals deposited at or before the threshold', () => {
    const s = makeSignal({ meta: { deposited_at: 1000 } });
    expect(matchesQuery(s, { after: 1000 })).toBe(false);
    expect(matchesQuery(s, { after: 2000 })).toBe(false);
  });
});

// ── matchesQuery: custom filter ─────────────────────────────

describe('matchesQuery — custom filter', () => {
  it('applies custom filter predicate', () => {
    const s = makeSignal({ payload: { priority: 'high' } });
    expect(matchesQuery(s, {
      filter: (sig) => sig.payload.priority === 'high',
    })).toBe(true);
  });

  it('rejects when custom filter returns false', () => {
    const s = makeSignal({ payload: { priority: 'low' } });
    expect(matchesQuery(s, {
      filter: (sig) => sig.payload.priority === 'high',
    })).toBe(false);
  });
});

// ── matchesQuery: combined filters ──────────────────────────

describe('matchesQuery — combined filters', () => {
  it('requires all filters to pass (AND logic)', () => {
    const s = makeSignal({
      type: 'task:ready',
      meta: {
        concentration: 0.8,
        tags: ['urgent'],
        deposited_at: 5000,
      },
    });

    expect(matchesQuery(s, {
      type: 'task:*',
      minConcentration: 0.5,
      tags: ['urgent'],
      after: 1000,
      unclaimed: true,
    })).toBe(true);
  });

  it('fails if any single filter rejects', () => {
    const s = makeSignal({
      type: 'task:ready',
      meta: { concentration: 0.3 }, // below threshold
    });

    expect(matchesQuery(s, {
      type: 'task:*',          // passes
      minConcentration: 0.5,   // fails
    })).toBe(false);
  });
});

// ── decayConcentration ──────────────────────────────────────

describe('decayConcentration', () => {
  it('reduces concentration based on elapsed time', () => {
    const s = makeSignal({
      meta: { deposited_at: 1000, concentration: 1.0 },
    });
    // 10 seconds elapsed at 0.01/sec = 0.1 decay → 0.9
    const result = decayConcentration(s, 0.01, 11_000);
    expect(result).toBeCloseTo(0.9, 2);
  });

  it('returns 0 when decay exceeds concentration', () => {
    const s = makeSignal({
      meta: { deposited_at: 0, concentration: 0.5 },
    });
    // 100 seconds at 0.01/sec = 1.0 decay → max(0, 0.5-1.0) = 0
    const result = decayConcentration(s, 0.01, 100_000);
    expect(result).toBe(0);
  });

  it('returns full concentration when no time elapsed', () => {
    const s = makeSignal({
      meta: { deposited_at: 5000, concentration: 0.8 },
    });
    const result = decayConcentration(s, 0.01, 5000);
    expect(result).toBeCloseTo(0.8, 5);
  });

  it('handles high decay rates', () => {
    const s = makeSignal({
      meta: { deposited_at: 0, concentration: 1.0 },
    });
    // 1 second at 0.5/sec = 0.5 decay → 0.5
    const result = decayConcentration(s, 0.5, 1000);
    expect(result).toBeCloseTo(0.5, 5);
  });

  it('never returns negative', () => {
    const s = makeSignal({
      meta: { deposited_at: 0, concentration: 0.1 },
    });
    const result = decayConcentration(s, 1.0, 10_000);
    expect(result).toBe(0);
  });
});

// ── isExpired ───────────────────────────────────────────────

describe('isExpired', () => {
  it('returns false when no TTL is set', () => {
    const s = makeSignal();
    expect(isExpired(s, Date.now() + 999_999)).toBe(false);
  });

  it('returns false when within TTL', () => {
    const s = makeSignal({
      meta: { deposited_at: 1000, ttl: 10_000 },
    });
    expect(isExpired(s, 5000)).toBe(false);
  });

  it('returns false at exact TTL boundary', () => {
    const s = makeSignal({
      meta: { deposited_at: 1000, ttl: 10_000 },
    });
    expect(isExpired(s, 11_000)).toBe(false);
  });

  it('returns true when past TTL', () => {
    const s = makeSignal({
      meta: { deposited_at: 1000, ttl: 10_000 },
    });
    expect(isExpired(s, 11_001)).toBe(true);
  });
});

// ── isClaimExpired ──────────────────────────────────────────

describe('isClaimExpired', () => {
  it('returns false when not claimed', () => {
    const s = makeSignal();
    expect(isClaimExpired(s)).toBe(false);
  });

  it('returns false when claimed_by is set but claimed_at is missing', () => {
    const s = makeSignal({ meta: { claimed_by: 'shaper' } });
    expect(isClaimExpired(s)).toBe(false);
  });

  it('returns false when claim_lease is missing', () => {
    const s = makeSignal({
      meta: { claimed_by: 'shaper', claimed_at: 1000 },
    });
    expect(isClaimExpired(s)).toBe(false);
  });

  it('returns false when claim is within lease', () => {
    const s = makeSignal({
      meta: { claimed_by: 'shaper', claimed_at: 1000, claim_lease: 30_000 },
    });
    expect(isClaimExpired(s, 15_000)).toBe(false);
  });

  it('returns false at exact lease boundary', () => {
    const s = makeSignal({
      meta: { claimed_by: 'shaper', claimed_at: 1000, claim_lease: 30_000 },
    });
    expect(isClaimExpired(s, 31_000)).toBe(false);
  });

  it('returns true when claim lease has expired', () => {
    const s = makeSignal({
      meta: { claimed_by: 'shaper', claimed_at: 1000, claim_lease: 30_000 },
    });
    expect(isClaimExpired(s, 31_001)).toBe(true);
  });
});

// ── prioritize ──────────────────────────────────────────────

describe('prioritize', () => {
  it('sorts by concentration descending', () => {
    const low = makeSignal({ meta: { concentration: 0.2 } });
    const mid = makeSignal({ meta: { concentration: 0.5 } });
    const high = makeSignal({ meta: { concentration: 0.9 } });

    const sorted = prioritize([low, mid, high]);
    expect(sorted.map(s => s.meta.concentration)).toEqual([0.9, 0.5, 0.2]);
  });

  it('breaks ties by newest first', () => {
    const older = makeSignal({ meta: { concentration: 0.5, deposited_at: 1000 } });
    const newer = makeSignal({ meta: { concentration: 0.5, deposited_at: 2000 } });

    const sorted = prioritize([older, newer]);
    expect(sorted[0].meta.deposited_at).toBe(2000);
    expect(sorted[1].meta.deposited_at).toBe(1000);
  });

  it('treats concentrations within 0.001 as equal (uses age tiebreak)', () => {
    const a = makeSignal({ meta: { concentration: 0.5005, deposited_at: 1000 } });
    const b = makeSignal({ meta: { concentration: 0.5000, deposited_at: 2000 } });

    const sorted = prioritize([a, b]);
    // Diff is 0.0005 < 0.001 threshold → treated as equal → sorted by age
    expect(sorted[0].meta.deposited_at).toBe(2000);
  });

  it('does not mutate the original array', () => {
    const signals = [
      makeSignal({ meta: { concentration: 0.3 } }),
      makeSignal({ meta: { concentration: 0.9 } }),
    ];
    const original = [...signals];

    prioritize(signals);
    expect(signals[0].meta.concentration).toBe(original[0].meta.concentration);
    expect(signals[1].meta.concentration).toBe(original[1].meta.concentration);
  });

  it('returns empty array for empty input', () => {
    expect(prioritize([])).toEqual([]);
  });

  it('handles single element', () => {
    const s = makeSignal();
    expect(prioritize([s])).toEqual([s]);
  });
});
