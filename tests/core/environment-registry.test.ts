// PURPOSE: Tests for the environment registry — register, deserialize, type guard, roundtrips
// PURPOSE: Verifies that each built-in environment serializes and round-trips correctly

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerEnvironment,
  deserializeEnvironment,
  isSerializableEnvironment,
} from '../../src/core/environment-registry.js';
import type {
  Environment,
  EnvironmentConfig,
  SerializableEnvironment,
  Signal,
  SignalQuery,
  Subscription,
  DecayResult,
  SignalMeta,
} from '../../src/core/types.js';
import { FilesystemEnvironment } from '../../src/environments/filesystem/adapter.js';
import { GitHubEnvironment } from '../../src/environments/github/adapter.js';
import { DoltEnvironment } from '../../src/environments/dolt/adapter.js';

// ── Registry basics ──────────────────────────────────────────

describe('environment registry', () => {
  it('deserializes a registered type', () => {
    // FilesystemEnvironment self-registers on import
    const env = deserializeEnvironment({ type: 'filesystem', root: '/tmp/test-signals', name: 'test' });
    expect(env).toBeInstanceOf(FilesystemEnvironment);
    expect(env.name).toBe('test');
  });

  it('throws for unknown type with helpful message', () => {
    expect(() => deserializeEnvironment({ type: 'redis' })).toThrow(/Unknown environment type "redis"/);
    expect(() => deserializeEnvironment({ type: 'redis' })).toThrow(/Registered types:/);
  });

  it('registers a custom type', () => {
    const mockEnv: Environment = {
      name: 'mock',
      observe: async () => [],
      deposit: async () => ({} as Signal),
      withdraw: async () => {},
      claim: async () => false,
      release: async () => {},
      watch: () => ({ unsubscribe: () => {} }),
      history: async () => [],
      decay: async () => ({ decayed: 0, evaporated: 0, claimsReleased: 0 }),
      snapshot: async () => [],
    };

    registerEnvironment('mock', (config) => {
      mockEnv.name; // uses config
      return mockEnv;
    });

    const result = deserializeEnvironment({ type: 'mock', name: 'test-mock' });
    expect(result).toBe(mockEnv);
  });
});

// ── Type guard ───────────────────────────────────────────────

describe('isSerializableEnvironment', () => {
  it('returns true for an environment with serialize()', () => {
    const env = new FilesystemEnvironment({ root: '/tmp/test', name: 'test' });
    expect(isSerializableEnvironment(env)).toBe(true);
  });

  it('returns false for a plain Environment without serialize()', () => {
    const plain: Environment = {
      name: 'plain',
      observe: async () => [],
      deposit: async () => ({} as Signal),
      withdraw: async () => {},
      claim: async () => false,
      release: async () => {},
      watch: () => ({ unsubscribe: () => {} }),
      history: async () => [],
      decay: async () => ({ decayed: 0, evaporated: 0, claimsReleased: 0 }),
      snapshot: async () => [],
    };
    expect(isSerializableEnvironment(plain)).toBe(false);
  });
});

// ── Roundtrip: FilesystemEnvironment ─────────────────────────

describe('FilesystemEnvironment serialization', () => {
  it('serializes with correct type and fields', () => {
    const env = new FilesystemEnvironment({ root: '/data/signals', name: 'my-fs' });
    const config = env.serialize();
    expect(config).toEqual({ type: 'filesystem', name: 'my-fs', root: '/data/signals' });
  });

  it('round-trips via registry', () => {
    const original = new FilesystemEnvironment({ root: '/data/signals', name: 'my-fs' });
    const config = original.serialize();
    const restored = deserializeEnvironment(config) as FilesystemEnvironment;
    expect(restored).toBeInstanceOf(FilesystemEnvironment);
    expect(restored.name).toBe('my-fs');
    expect(restored.serialize()).toEqual(config);
  });

  it('uses default root when not specified', () => {
    const env = deserializeEnvironment({ type: 'filesystem', name: 'default-root' }) as FilesystemEnvironment;
    expect(env.name).toBe('default-root');
    // Verify it round-trips with the default
    const config = env.serialize();
    expect(config.root).toBe('/tmp/mandible-signals');
  });
});

// ── Roundtrip: GitHubEnvironment ─────────────────────────────

describe('GitHubEnvironment serialization', () => {
  it('serializes with correct type and fields (token omitted for security)', () => {
    const env = new GitHubEnvironment({
      owner: 'acme',
      repo: 'widgets',
      token: 'ghp_test123',
      name: 'gh-test',
      pollInterval: 15_000,
    });
    const config = env.serialize();
    // Tokens deliberately never serialize: this config travels in deploy
    // requests and the zone's workload spec. Zones read GITHUB_TOKEN from
    // process.env, supplied by the host's secret delivery.
    expect(config).toEqual({
      type: 'github',
      name: 'gh-test',
      owner: 'acme',
      repo: 'widgets',
      pollInterval: 15_000,
    });
    // Token intentionally NOT serialized — never persist secrets
    expect(config).not.toHaveProperty('token');
  });

  it('round-trips via registry (token comes from env, not serialized config)', () => {
    const original = new GitHubEnvironment({
      owner: 'acme',
      repo: 'widgets',
      token: 'ghp_test123',
      name: 'gh-test',
    });
    const config = original.serialize();
    const restored = deserializeEnvironment(config) as GitHubEnvironment;
    expect(restored).toBeInstanceOf(GitHubEnvironment);
    expect(restored.name).toBe('gh-test');
    // Re-serialization should produce the same config (no token in either)
    expect(restored.serialize()).toEqual(config);
  });

  it('omits non-serializable fields (typeMapper, issueFilter)', () => {
    const env = new GitHubEnvironment({
      owner: 'acme',
      repo: 'widgets',
      token: 'ghp_test123',
      typeMapper: () => 'custom',
      issueFilter: () => true,
    });
    const config = env.serialize();
    expect(config).not.toHaveProperty('typeMapper');
    expect(config).not.toHaveProperty('issueFilter');
  });
});

// ── Roundtrip: DoltEnvironment ───────────────────────────────

describe('DoltEnvironment serialization', () => {
  it('serializes with correct type and fields', () => {
    const env = new DoltEnvironment({
      owner: 'test-owner',
      database: 'signals_db',
      branch: 'feature-x',
      name: 'dolt-test',
    });
    const config = env.serialize();
    expect(config).toEqual({
      type: 'dolt',
      name: 'dolt-test',
      owner: 'test-owner',
      database: 'signals_db',
      branch: 'feature-x',
      apiBase: undefined,
    });
  });

  it('round-trips via registry', () => {
    const original = new DoltEnvironment({
      owner: 'test-owner',
      database: 'signals_db',
      name: 'dolt-test',
    });
    const config = original.serialize();
    const restored = deserializeEnvironment(config) as DoltEnvironment;
    expect(restored).toBeInstanceOf(DoltEnvironment);
    expect(restored.name).toBe('dolt-test');
    expect(restored.serialize()).toEqual(config);
  });
});

// ── DockerHost serialization output ──────────────────────────

describe('Environment serialization output compatibility', () => {
  // These tests verify the serialized output matches what the old constructor.name
  // approach produced, ensuring wire format compatibility.

  it('FilesystemEnvironment produces same JSON as before', () => {
    const env = new FilesystemEnvironment({ root: '/data/sigs', name: 'fs-env' });
    const config = env.serialize();
    // Old output was: { type: 'filesystem', root: '/data/sigs', name: 'fs-env' }
    expect(config.type).toBe('filesystem');
    expect(config.root).toBe('/data/sigs');
    expect(config.name).toBe('fs-env');
  });

  it('GitHubEnvironment serializes without token (security: secrets never serialized)', () => {
    const env = new GitHubEnvironment({
      owner: 'acme',
      repo: 'repo',
      token: 'tok',
      name: 'gh',
      pollInterval: 5000,
    });
    const config = env.serialize();
    // Shape intentionally changed from the old output: token no longer
    // serializes (it leaked into deploy requests and the workload spec).
    expect(config.type).toBe('github');
    expect(config.owner).toBe('acme');
    expect(config.repo).toBe('repo');
    expect(config).not.toHaveProperty('token'); // Security: token never serialized
    expect(config.name).toBe('gh');
    expect(config.pollInterval).toBe(5000);
  });
});
