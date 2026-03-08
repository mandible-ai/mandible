// PURPOSE: Interactive project scaffolding for mandible
// PURPOSE: Generates mandible.config.ts with a working ping-pong colony pair

import { writeFile, readFile, access } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { constants } from 'node:fs';

// ── Types ───────────────────────────────────────────────────────

export interface InitFlags {
  name?: string;
  env?: 'filesystem' | 'dolt' | 'github';
  owner?: string;
  database?: string;
  repo?: string;
  output?: string;
  yes?: boolean;
}

export interface InitConfig {
  name: string;
  env: 'filesystem' | 'dolt' | 'github';
  envOptions: {
    root?: string;
    owner?: string;
    database?: string;
    repo?: string;
  };
}

// ── Flag parsing ────────────────────────────────────────────────

export function parseInitFlags(args: string[]): InitFlags {
  const flags: InitFlags = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--name':
        flags.name = args[++i];
        break;
      case '--env':
        flags.env = args[++i] as InitFlags['env'];
        break;
      case '--owner':
        flags.owner = args[++i];
        break;
      case '--database':
        flags.database = args[++i];
        break;
      case '--repo':
        flags.repo = args[++i];
        break;
      case '--output':
        flags.output = args[++i];
        break;
      case '-y':
      case '--yes':
        flags.yes = true;
        break;
    }
  }

  return flags;
}

// ── Interactive prompts ─────────────────────────────────────────

export async function promptForConfig(flags: InitFlags): Promise<InitConfig> {
  const { input, select } = await import('@inquirer/prompts');

  const name = flags.name ?? await input({
    message: 'Project name:',
    default: basename(process.cwd()),
  });

  const env = flags.env ?? await select<'filesystem' | 'dolt' | 'github'>({
    message: 'Environment:',
    choices: [
      { name: 'Filesystem (local files)', value: 'filesystem' as const },
      { name: 'DoltHub (versioned database)', value: 'dolt' as const },
      { name: 'GitHub (issues + PRs)', value: 'github' as const },
    ],
  });

  const envOptions: InitConfig['envOptions'] = {};

  switch (env) {
    case 'filesystem':
      envOptions.root = await input({
        message: 'Root path for filesystem environment:',
        default: './.mandible-env',
      });
      break;
    case 'dolt':
      envOptions.owner = flags.owner ?? await input({
        message: 'DoltHub owner (user or org):',
      });
      envOptions.database = flags.database ?? await input({
        message: 'DoltHub database name:',
      });
      break;
    case 'github': {
      const repo = flags.repo ?? await input({
        message: 'GitHub repo (owner/repo):',
      });
      envOptions.repo = repo;
      break;
    }
  }

  return { name, env, envOptions };
}

// ── Defaults for -y (non-interactive) ───────────────────────────

function defaultConfig(): InitConfig {
  return {
    name: basename(process.cwd()),
    env: 'filesystem',
    envOptions: { root: './.mandible-env' },
  };
}

function mergeDefaults(flags: InitFlags): InitConfig {
  const config = defaultConfig();
  if (flags.name) config.name = flags.name;
  if (flags.env) config.env = flags.env;
  if (flags.env === 'dolt') {
    config.envOptions = {
      owner: flags.owner ?? 'your-owner',
      database: flags.database ?? 'your-database',
    };
  } else if (flags.env === 'github') {
    config.envOptions = {
      repo: flags.repo ?? 'owner/repo',
    };
  }
  return config;
}

// ── Config generation ───────────────────────────────────────────

export function generateConfig(config: InitConfig): string {
  switch (config.env) {
    case 'filesystem':
      return generateFilesystemConfig(config);
    case 'dolt':
      return generateDoltConfig(config);
    case 'github':
      return generateGitHubConfig(config);
  }
}

function generateFilesystemConfig(config: InitConfig): string {
  const root = config.envOptions.root ?? './.mandible-env';
  return `// PURPOSE: Mandible colony configuration
// PURPOSE: Run: npx mandible dev

import { colony, FilesystemEnvironment } from '@mandible-ai/mandible';
import type { Signal, ActionContext } from '@mandible-ai/mandible';
import { resolve } from 'node:path';

const env = new FilesystemEnvironment({
  root: resolve('${root}'),
  name: '${config.name}',
});

const colonies = [
  ...colony('pinger')
    .in(env)
    .sense('ping:request', { unclaimed: true })
    .do('ping', async (signal: Signal, ctx: ActionContext) => {
      const payload = signal.payload as Record<string, unknown>;
      console.log('[pinger] got "' + (payload.message ?? 'hello') + '"');
      await ctx.deposit('ping:response', {
        message: payload.message ?? 'hello',
        respondedTo: signal.id,
      });
      await ctx.withdraw(signal.id);
    })
    .concurrency(1)
    .claim('exclusive')
    .poll(3000)
    .build(),

  ...colony('ponger')
    .in(env)
    .sense('ping:response', { unclaimed: true })
    .do('pong', async (signal: Signal, ctx: ActionContext) => {
      const payload = signal.payload as Record<string, unknown>;
      console.log('[ponger] got "' + (payload.message ?? 'hello') + '"');
      await ctx.deposit('ping:request', {
        message: payload.message ?? 'hello',
        respondedTo: signal.id,
      });
      await ctx.withdraw(signal.id);
    })
    .concurrency(1)
    .claim('exclusive')
    .poll(3000)
    .build(),
];

export default { environment: env, colonies };
`;
}

function generateDoltConfig(config: InitConfig): string {
  const owner = config.envOptions.owner ?? 'your-owner';
  const database = config.envOptions.database ?? 'your-database';
  return `// PURPOSE: Mandible colony configuration
// PURPOSE: Run: npx mandible dev

import { colony, DoltEnvironment } from '@mandible-ai/mandible';
import type { Signal, ActionContext } from '@mandible-ai/mandible';

const env = new DoltEnvironment({
  owner: '${owner}',
  database: '${database}',
});

const colonies = [
  ...colony('pinger')
    .in(env)
    .sense('ping:request', { unclaimed: true })
    .do('ping', async (signal: Signal, ctx: ActionContext) => {
      const payload = signal.payload as Record<string, unknown>;
      console.log('[pinger] got "' + (payload.message ?? 'hello') + '"');
      await ctx.deposit('ping:response', {
        message: payload.message ?? 'hello',
        respondedTo: signal.id,
      });
      await ctx.withdraw(signal.id);
    })
    .concurrency(1)
    .claim('exclusive')
    .poll(3000)
    .build(),

  ...colony('ponger')
    .in(env)
    .sense('ping:response', { unclaimed: true })
    .do('pong', async (signal: Signal, ctx: ActionContext) => {
      const payload = signal.payload as Record<string, unknown>;
      console.log('[ponger] got "' + (payload.message ?? 'hello') + '"');
      await ctx.deposit('ping:request', {
        message: payload.message ?? 'hello',
        respondedTo: signal.id,
      });
      await ctx.withdraw(signal.id);
    })
    .concurrency(1)
    .claim('exclusive')
    .poll(3000)
    .build(),
];

export default { environment: env, colonies };
`;
}

function generateGitHubConfig(config: InitConfig): string {
  const repo = config.envOptions.repo ?? 'owner/repo';
  const [owner, repoName] = repo.split('/');
  return `// PURPOSE: Mandible colony configuration
// PURPOSE: Run: npx mandible dev

import { colony, GitHubEnvironment } from '@mandible-ai/mandible';
import type { Signal, ActionContext } from '@mandible-ai/mandible';

const env = new GitHubEnvironment({
  owner: '${owner}',
  repo: '${repoName}',
  token: process.env.GITHUB_TOKEN,
});

const colonies = [
  ...colony('pinger')
    .in(env)
    .sense('ping:request', { unclaimed: true })
    .do('ping', async (signal: Signal, ctx: ActionContext) => {
      const payload = signal.payload as Record<string, unknown>;
      console.log('[pinger] got "' + (payload.message ?? 'hello') + '"');
      await ctx.deposit('ping:response', {
        message: payload.message ?? 'hello',
        respondedTo: signal.id,
      });
      await ctx.withdraw(signal.id);
    })
    .concurrency(1)
    .claim('exclusive')
    .poll(3000)
    .build(),

  ...colony('ponger')
    .in(env)
    .sense('ping:response', { unclaimed: true })
    .do('pong', async (signal: Signal, ctx: ActionContext) => {
      const payload = signal.payload as Record<string, unknown>;
      console.log('[ponger] got "' + (payload.message ?? 'hello') + '"');
      await ctx.deposit('ping:request', {
        message: payload.message ?? 'hello',
        respondedTo: signal.id,
      });
      await ctx.withdraw(signal.id);
    })
    .concurrency(1)
    .claim('exclusive')
    .poll(3000)
    .build(),
];

export default { environment: env, colonies };
`;
}

// ── Gitignore helper ────────────────────────────────────────────

export function shouldUpdateGitignore(envType: string): string | null {
  return envType === 'filesystem' ? '.mandible-env' : null;
}

// ── Orchestrator ────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runInit(args: string[]): Promise<void> {
  const flags = parseInitFlags(args);
  const outputPath = resolve(process.cwd(), flags.output ?? 'mandible.config.ts');

  // Collect config — skip prompts if -y
  let config: InitConfig;
  if (flags.yes) {
    config = mergeDefaults(flags);
  } else {
    config = await promptForConfig(flags);
  }

  // Generate source
  const source = generateConfig(config);

  // Check if output file exists — prompt to overwrite (unless -y)
  if (await fileExists(outputPath)) {
    if (!flags.yes) {
      const { confirm } = await import('@inquirer/prompts');
      const overwrite = await confirm({
        message: `${outputPath} already exists. Overwrite?`,
        default: false,
      });
      if (!overwrite) {
        console.log('Aborted.');
        return;
      }
    }
  }

  // Write the config file
  await writeFile(outputPath, source, 'utf-8');

  // Offer to add .mandible-env to .gitignore
  const gitignoreEntry = shouldUpdateGitignore(config.env);
  if (gitignoreEntry) {
    const gitignorePath = resolve(process.cwd(), '.gitignore');
    let shouldAdd = flags.yes;

    if (!flags.yes) {
      const { confirm } = await import('@inquirer/prompts');
      shouldAdd = await confirm({
        message: `Add ${gitignoreEntry} to .gitignore?`,
        default: true,
      });
    }

    if (shouldAdd) {
      let content = '';
      if (await fileExists(gitignorePath)) {
        content = await readFile(gitignorePath, 'utf-8');
      }
      if (!content.includes(gitignoreEntry)) {
        const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
        await writeFile(gitignorePath, content + separator + gitignoreEntry + '\n', 'utf-8');
        console.log(`  Added ${gitignoreEntry} to .gitignore`);
      }
    }
  }

  const relPath = outputPath.replace(process.cwd() + '/', '');
  console.log(`\n  Created ${relPath}`);
  console.log(`  Run: npx mandible dev\n`);
}
