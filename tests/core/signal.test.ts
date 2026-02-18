// PURPOSE: Tests for signal factory and utilities
// PURPOSE: Covers createSignal, matchesQuery, decay, expiration, priority sorting

import { describe, it, expect } from 'vitest';
import { createSignal, matchesQuery } from '../../src/core/signal.js';

describe('createSignal', () => {
  it('creates a signal with sensible defaults', () => {
    const signal = createSignal('task:ready', { name: 'test' });

    expect(signal.id).toMatch(/^sig_/);
    expect(signal.type).toBe('task:ready');
    expect(signal.payload).toEqual({ name: 'test' });
    expect(signal.meta.concentration).toBe(1.0);
    expect(signal.meta.deposited_by).toBe('unknown');
    expect(signal.meta.deposited_at).toBeGreaterThan(0);
  });
});

describe('matchesQuery', () => {
  it('matches exact type', () => {
    const signal = createSignal('task:ready', {});
    expect(matchesQuery(signal, { type: 'task:ready' })).toBe(true);
    expect(matchesQuery(signal, { type: 'task:done' })).toBe(false);
  });
});
