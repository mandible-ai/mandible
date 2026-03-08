// PURPOSE: Unit tests for mandible init scaffolding
// PURPOSE: Tests flag parsing, config generation, and gitignore helper

import { describe, it, expect } from 'vitest';
import { parseInitFlags, generateConfig, shouldUpdateGitignore } from '../../src/cli/init.js';
import type { InitConfig } from '../../src/cli/init.js';

// ── parseInitFlags ──────────────────────────────────────────────

describe('parseInitFlags', () => {
  it('parses --name --env -y correctly', () => {
    const flags = parseInitFlags(['--name', 'my-project', '--env', 'filesystem', '-y']);
    expect(flags.name).toBe('my-project');
    expect(flags.env).toBe('filesystem');
    expect(flags.yes).toBe(true);
  });

  it('defaults to undefined for unset flags', () => {
    const flags = parseInitFlags([]);
    expect(flags.name).toBeUndefined();
    expect(flags.env).toBeUndefined();
    expect(flags.owner).toBeUndefined();
    expect(flags.database).toBeUndefined();
    expect(flags.repo).toBeUndefined();
    expect(flags.output).toBeUndefined();
    expect(flags.yes).toBeUndefined();
  });

  it('handles --repo owner/repo for GitHub', () => {
    const flags = parseInitFlags(['--repo', 'mandible-ai/mandible', '--env', 'github']);
    expect(flags.repo).toBe('mandible-ai/mandible');
    expect(flags.env).toBe('github');
  });

  it('handles --owner and --database for DoltHub', () => {
    const flags = parseInitFlags(['--owner', 'my-org', '--database', 'signals-db', '--env', 'dolt']);
    expect(flags.owner).toBe('my-org');
    expect(flags.database).toBe('signals-db');
    expect(flags.env).toBe('dolt');
  });

  it('handles --output flag', () => {
    const flags = parseInitFlags(['--output', 'custom.config.ts']);
    expect(flags.output).toBe('custom.config.ts');
  });

  it('handles --yes long form', () => {
    const flags = parseInitFlags(['--yes']);
    expect(flags.yes).toBe(true);
  });

  it('ignores unknown flags', () => {
    const flags = parseInitFlags(['--unknown', 'value', '--name', 'test']);
    expect(flags.name).toBe('test');
  });
});

// ── generateConfig ──────────────────────────────────────────────

describe('generateConfig', () => {
  it('filesystem config contains FilesystemEnvironment import and root path', () => {
    const config: InitConfig = {
      name: 'test-project',
      env: 'filesystem',
      envOptions: { root: './.mandible-env' },
    };
    const source = generateConfig(config);
    expect(source).toContain("import { colony, FilesystemEnvironment } from '@mandible-ai/mandible'");
    expect(source).toContain("resolve('./.mandible-env')");
    expect(source).toContain("name: 'test-project'");
  });

  it('DoltHub config contains DoltEnvironment import with owner/database', () => {
    const config: InitConfig = {
      name: 'dolt-project',
      env: 'dolt',
      envOptions: { owner: 'my-org', database: 'signals' },
    };
    const source = generateConfig(config);
    expect(source).toContain("import { colony, DoltEnvironment } from '@mandible-ai/mandible'");
    expect(source).toContain("owner: 'my-org'");
    expect(source).toContain("database: 'signals'");
  });

  it('GitHub config contains GitHubEnvironment import with owner/repo', () => {
    const config: InitConfig = {
      name: 'gh-project',
      env: 'github',
      envOptions: { repo: 'mandible-ai/mandible' },
    };
    const source = generateConfig(config);
    expect(source).toContain("import { colony, GitHubEnvironment } from '@mandible-ai/mandible'");
    expect(source).toContain("owner: 'mandible-ai'");
    expect(source).toContain("repo: 'mandible'");
    expect(source).toContain('process.env.GITHUB_TOKEN');
  });

  it('all configs default-export { environment, colonies } shape', () => {
    const envs: InitConfig['env'][] = ['filesystem', 'dolt', 'github'];
    for (const env of envs) {
      const config: InitConfig = {
        name: 'test',
        env,
        envOptions: env === 'dolt' ? { owner: 'o', database: 'd' } : env === 'github' ? { repo: 'o/r' } : {},
      };
      const source = generateConfig(config);
      expect(source).toContain('export default { environment: env, colonies }');
    }
  });

  it('all configs contain colony pinger ping-pong pair', () => {
    const envs: InitConfig['env'][] = ['filesystem', 'dolt', 'github'];
    for (const env of envs) {
      const config: InitConfig = {
        name: 'test',
        env,
        envOptions: env === 'dolt' ? { owner: 'o', database: 'd' } : env === 'github' ? { repo: 'o/r' } : {},
      };
      const source = generateConfig(config);
      expect(source).toContain("colony('pinger')");
      expect(source).toContain("colony('ponger')");
      expect(source).toContain("'ping:request'");
      expect(source).toContain("'ping:response'");
    }
  });

  it('all configs include PURPOSE comments', () => {
    const config: InitConfig = {
      name: 'test',
      env: 'filesystem',
      envOptions: {},
    };
    const source = generateConfig(config);
    expect(source).toContain('// PURPOSE: Mandible colony configuration');
    expect(source).toContain('// PURPOSE: Run: npx mandible dev');
  });

  it('filesystem config uses resolve() for root path', () => {
    const config: InitConfig = {
      name: 'test',
      env: 'filesystem',
      envOptions: { root: './custom-root' },
    };
    const source = generateConfig(config);
    expect(source).toContain("resolve('./custom-root')");
    expect(source).toContain("import { resolve } from 'node:path'");
  });
});

// ── shouldUpdateGitignore ───────────────────────────────────────

describe('shouldUpdateGitignore', () => {
  it('returns .mandible-env for filesystem', () => {
    expect(shouldUpdateGitignore('filesystem')).toBe('.mandible-env');
  });

  it('returns null for dolt', () => {
    expect(shouldUpdateGitignore('dolt')).toBeNull();
  });

  it('returns null for github', () => {
    expect(shouldUpdateGitignore('github')).toBeNull();
  });
});
