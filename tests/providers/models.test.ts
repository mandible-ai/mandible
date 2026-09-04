// PURPOSE: Tests for model alias resolution
// PURPOSE: Verifies alias table, env overrides, programmatic overrides, passthrough

import { describe, it, expect, afterEach } from 'vitest';
import {
  MODEL_ALIASES,
  DEFAULT_MODEL_ALIAS,
  resolveModel,
  isModelAlias,
  setModelAliases,
  resetModelAliases,
  currentModelAliases,
} from '../../src/providers/models.js';

afterEach(() => {
  resetModelAliases();
  delete process.env.MANDIBLE_MODEL_OPUS;
  delete process.env.MANDIBLE_MODEL_SONNET;
});

describe('MODEL_ALIASES', () => {
  it('uses undated model IDs', () => {
    for (const id of Object.values(MODEL_ALIASES)) {
      expect(id).not.toMatch(/-\d{8}$/);
    }
  });

  it('default alias is a known alias', () => {
    expect(isModelAlias(DEFAULT_MODEL_ALIAS)).toBe(true);
  });
});

describe('resolveModel', () => {
  it('resolves each alias to its table entry', () => {
    expect(resolveModel('fable')).toBe(MODEL_ALIASES.fable);
    expect(resolveModel('opus')).toBe(MODEL_ALIASES.opus);
    expect(resolveModel('sonnet')).toBe(MODEL_ALIASES.sonnet);
    expect(resolveModel('haiku')).toBe(MODEL_ALIASES.haiku);
  });

  it('passes full model IDs through unchanged', () => {
    expect(resolveModel('claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(resolveModel('us.anthropic.claude-sonnet-4-6')).toBe('us.anthropic.claude-sonnet-4-6');
    expect(resolveModel('gpt-4o')).toBe('gpt-4o');
  });

  it('is case-sensitive — "Opus" is not an alias', () => {
    expect(resolveModel('Opus')).toBe('Opus');
  });

  it('honors MANDIBLE_MODEL_<ALIAS> env override', () => {
    process.env.MANDIBLE_MODEL_OPUS = 'claude-opus-4-8';
    expect(resolveModel('opus')).toBe('claude-opus-4-8');
    // Other aliases unaffected
    expect(resolveModel('sonnet')).toBe(MODEL_ALIASES.sonnet);
  });

  it('programmatic override beats env override', () => {
    process.env.MANDIBLE_MODEL_OPUS = 'from-env';
    setModelAliases({ opus: 'from-code' });
    expect(resolveModel('opus')).toBe('from-code');
  });

  it('resetModelAliases clears programmatic overrides', () => {
    setModelAliases({ sonnet: 'pinned' });
    expect(resolveModel('sonnet')).toBe('pinned');
    resetModelAliases();
    expect(resolveModel('sonnet')).toBe(MODEL_ALIASES.sonnet);
  });

  it('setModelAliases with undefined removes an override', () => {
    setModelAliases({ sonnet: 'pinned' });
    setModelAliases({ sonnet: undefined });
    expect(resolveModel('sonnet')).toBe(MODEL_ALIASES.sonnet);
  });
});

describe('currentModelAliases', () => {
  it('reflects overrides', () => {
    setModelAliases({ haiku: 'custom-haiku' });
    const table = currentModelAliases();
    expect(table.haiku).toBe('custom-haiku');
    expect(table.opus).toBe(MODEL_ALIASES.opus);
  });
});
