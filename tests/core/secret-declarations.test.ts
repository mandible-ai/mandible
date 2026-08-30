// PURPOSE: Declaration surface for tenant secrets — environments state what
// they require; colony definitions and module refs carry declared names.

import { describe, it, expect } from 'vitest';
import { GitHubEnvironment } from '../../src/environments/github/adapter.js';
import type { ColonyDefinition, Environment } from '../../src/core/types.js';
import type { ColonyModuleRef } from '../../src/cloud/types.js';

describe('secret declarations', () => {
  it('GitHubEnvironment requires GITHUB_TOKEN when no token is configured', () => {
    const env = new GitHubEnvironment({ owner: 'acme', repo: 'app' });
    expect(env.requiredSecrets).toEqual(['GITHUB_TOKEN']);
  });

  it('GitHubEnvironment requires nothing when a token is passed inline', () => {
    const env = new GitHubEnvironment({ owner: 'acme', repo: 'app', token: 'ghp_inline' });
    expect(env.requiredSecrets).toEqual([]);
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
