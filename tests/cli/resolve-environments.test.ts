import { describe, it, expect } from 'vitest';
import { resolveEnvironments, type SimpleConfig } from '../../src/cli/server.js';
import type { Environment, Signal, SignalInput, SignalQuery, Subscription, DecayResult } from '../../src/core/types.js';

function stubEnv(name: string): Environment {
  return {
    name,
    async deposit(_input: SignalInput): Promise<Signal> { return {} as Signal; },
    async observe(_query?: SignalQuery): Promise<Signal[]> { return []; },
    async claim() { return false; },
    async release() {},
    async withdraw() { return undefined; },
    watch(_q: SignalQuery, _cb: (s: Signal) => void): Subscription { return { unsubscribe() {} }; },
    async snapshot(): Promise<Signal[]> { return []; },
    async decay(): Promise<DecayResult> { return { decayed: 0, removed: 0, details: [] }; },
    async history() { return []; },
  };
}

describe('resolveEnvironments', () => {
  it('prefers explicit environments[] array', () => {
    const e1 = stubEnv('alpha');
    const e2 = stubEnv('beta');
    const config: SimpleConfig = {
      environments: [e1, e2],
      environment: stubEnv('ignored'),
      colonies: [],
    };
    const result = resolveEnvironments(config);
    expect(result).toEqual([e1, e2]);
  });

  it('falls back to singular environment field', () => {
    const env = stubEnv('single');
    const config: SimpleConfig = {
      environment: env,
      colonies: [],
    };
    const result = resolveEnvironments(config);
    expect(result).toEqual([env]);
  });

  it('auto-discovers from colony definitions, deduplicated by name', () => {
    const e1 = stubEnv('shared');
    const e2 = stubEnv('other');
    const config: SimpleConfig = {
      colonies: [
        { name: 'a', environment: e1, rules: [] },
        { name: 'b', environment: e1, rules: [] },
        { name: 'c', environment: e2, rules: [] },
      ] as any,
    };
    const result = resolveEnvironments(config);
    expect(result).toHaveLength(2);
    expect(result.map(e => e.name)).toEqual(['shared', 'other']);
  });

  it('returns empty array when nothing is configured', () => {
    const config: SimpleConfig = { colonies: [] };
    expect(resolveEnvironments(config)).toEqual([]);
  });

  it('ignores empty environments[] and falls back', () => {
    const env = stubEnv('fallback');
    const config: SimpleConfig = {
      environments: [],
      environment: env,
      colonies: [],
    };
    const result = resolveEnvironments(config);
    expect(result).toEqual([env]);
  });
});
