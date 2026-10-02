// PURPOSE: Declaration surface for tenant secrets — environments state what
// they require; colony definitions and module refs carry declared names.

import { describe, it, expect } from 'vitest';
import { GitHubEnvironment } from '../../src/environments/github/adapter.js';
import { DoltEnvironment } from '../../src/environments/dolt/adapter.js';
import type { ColonyDefinition, Environment } from '../../src/core/types.js';
import type { ColonyModuleRef } from '../../src/cloud/types.js';
import { colony } from '../../src/dsl/builder.js';
import { FilesystemEnvironment } from '../../src/environments/filesystem/index.js';

describe('secret declarations', () => {
  it('GitHubEnvironment declares GITHUB_TOKEN by default', () => {
    const env = new GitHubEnvironment({ owner: 'acme', repo: 'app' });
    expect(env.requiredSecrets).toEqual(['GITHUB_TOKEN']);
  });

  it('GitHubEnvironment declares GITHUB_TOKEN even with an inline token', () => {
    // Inline tokens no longer travel in serialized config (they leaked into
    // the deploy request and workload spec) — a cloud zone must be supplied
    // the secret, so the declaration stands.
    const env = new GitHubEnvironment({ owner: 'acme', repo: 'app', token: 'ghp_inline' });
    expect(env.requiredSecrets).toEqual(['GITHUB_TOKEN']);
  });

  it('GitHubEnvironment serialization never carries a token', () => {
    const env = new GitHubEnvironment({ owner: 'acme', repo: 'app', token: 'ghp_inline' });
    expect(JSON.stringify(env.serialize())).not.toContain('ghp_inline');
  });

  it('GitHubEnvironment allows opting out for anonymous public-repo access', () => {
    const env = new GitHubEnvironment({ owner: 'acme', repo: 'app', requiredSecrets: [] });
    expect(env.requiredSecrets).toEqual([]);
  });

  it('DoltEnvironment defaults to no declarations and accepts an override', () => {
    const pub = new DoltEnvironment({ owner: 'acme', database: 'metrics' });
    expect(pub.requiredSecrets).toEqual([]);
    const priv = new DoltEnvironment({ owner: 'acme', database: 'metrics', requiredSecrets: ['DOLTHUB_TOKEN'] });
    expect(priv.requiredSecrets).toEqual(['DOLTHUB_TOKEN']);
  });

  it('ColonyDefinition and ColonyModuleRef accept declared secret names', () => {
    // Compile-time surface check: these must typecheck.
    const ref: ColonyModuleRef = { module: './shaper.ts', export: 'configure', secrets: ['GITHUB_TOKEN'] };
    const def = { secrets: ['GITHUB_TOKEN'] } as Partial<ColonyDefinition>;
    expect(ref.secrets).toEqual(['GITHUB_TOKEN']);
    expect(def.secrets).toEqual(['GITHUB_TOKEN']);
  });

  it('environments without secret needs require no change', () => {
    const bare: Partial<Environment> = { name: 'x' };
    expect(bare.requiredSecrets).toBeUndefined();
  });
});

// A closure colony declares secrets the same way a module ref does: by name,
// on the thing that describes the colony.
describe('ColonyBuilder.secrets', () => {
  const env = new FilesystemEnvironment({ root: '/tmp/mandible-secret-declarations', name: 'test' });
  const worker = () => colony('worker').in(env).sense('task:new').do('work', async () => {});

  it('carries declared names onto the definition', () => {
    expect(worker().secrets(['B']).build().secrets).toEqual(['B']);
  });

  it('accumulates across calls, without duplicates', () => {
    const def = worker().secrets(['A', 'B']).secrets(['B', 'C']).build();
    expect(def.secrets).toEqual(['A', 'B', 'C']);
  });

  it('leaves the definition without secrets when none are declared', () => {
    expect(worker().build().secrets).toBeUndefined();
    expect(worker().secrets([]).build().secrets).toBeUndefined();
  });

  it('does not hand the definition the caller\'s array', () => {
    const declared = ['A'];
    const def = worker().secrets(declared).build();
    def.secrets!.push('MUTATED');
    expect(declared).toEqual(['A']);
  });
});
