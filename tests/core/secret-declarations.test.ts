// PURPOSE: Declaration surface for tenant secrets — environments state what
// they require; colony definitions and module refs carry declared names.

import { describe, it, expect } from 'vitest';
import { GitHubEnvironment } from '../../src/environments/github/adapter.js';
import { DoltEnvironment } from '../../src/environments/dolt/adapter.js';
import type { ColonyDefinition, Environment } from '../../src/core/types.js';
import type { ColonyModuleRef } from '../../src/cloud/types.js';

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

  it('GitHubEnvironment declares nothing in sts mode — the OIDC exchange needs no tenant secret', () => {
    const env = new GitHubEnvironment({ owner: 'acme', repo: 'app', sts: { identity: 'mandible-bot' } });
    expect(env.requiredSecrets).toEqual([]);
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
