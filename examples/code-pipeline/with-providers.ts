#!/usr/bin/env tsx
// ============================================================
// Code Pipeline Demo — With Real LLM Providers
// ============================================================
// Same pipeline as index.ts, but using action providers
// instead of simulated work functions.
//
// Shaper:  withClaudeCode (Claude Code SDK) — full coding agent
// Critic:  withStructuredOutput (Anthropic) — structured review
// Keeper:  withBash — git merge
//
// Prerequisites:
//   npm install @anthropic-ai/sdk @anthropic-ai/claude-agent-sdk
//   export ANTHROPIC_API_KEY=sk-ant-...
//
// Run:
//   npx tsx examples/code-pipeline/with-providers.ts
// ============================================================

import { resolve } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import {
  mandible,
  FilesystemEnvironment,
  withClaudeCode,
  withStructuredOutput,
  withBash,
  assembleContext,
} from '../../src/index.js';
import type { Signal, ActionContext } from '../../src/core/types.js';
import type { ColonyBuilder } from '../../src/dsl/builder.js';

const ENV_ROOT = resolve('/tmp/stigmergy-demo-providers');
const WORKSPACE = resolve('/tmp/stigmergy-workspace');

// Clean slate
await rm(ENV_ROOT, { recursive: true, force: true });
await rm(WORKSPACE, { recursive: true, force: true });
await mkdir(ENV_ROOT, { recursive: true });
await mkdir(WORKSPACE, { recursive: true });

const env = new FilesystemEnvironment({ root: ENV_ROOT, name: 'code-pipeline' });

// ----------------------------------------------------------
// Colony configurators using real providers
// ----------------------------------------------------------

function shaper(c: ColonyBuilder) {
  return c
    .sense('task:ready', { unclaimed: true, minConcentration: 0.1 })
    .do('shape-code', withClaudeCode({
      model: 'sonnet', // tier alias — resolves to the latest Sonnet

      systemPrompt: [
        'You are a senior TypeScript engineer in a coding colony.',
        'You receive task specifications and implement them as clean, well-typed code.',
        'Create the implementation in the working directory.',
        'Include basic tests. Follow existing code conventions.',
        'Be concise — implement exactly what is asked, nothing more.',
      ].join('\n'),

      prompt: async (signal) => {
        const context = await assembleContext(signal, env, {
          includeLineage: true,
          includeRelated: ['review:changes-needed'],
        });

        return [
          `## Task: ${signal.payload.name}`,
          `**Description:** ${signal.payload.description}`,
          `**Priority:** ${signal.payload.priority}`,
          '',
          'Implement this as a TypeScript module with tests.',
          '',
          context,
        ].join('\n');
      },

      allowedTools: ['file_edit', 'bash'],
      workingDirectory: (signal) => resolve(WORKSPACE, String(signal.payload.name)),

      output: {
        type: 'artifact:shaped',
        tags: ['needs-review'],
      },
    }))
    .concurrency(2)
    .claim('lease', 120_000)
    .poll(2000);
}

function critic(c: ColonyBuilder) {
  return c
    .sense('artifact:shaped', { unclaimed: true, minConcentration: 0.1 })
    .do('review-code', withStructuredOutput({
      model: 'sonnet', // tier alias — resolves to the latest Sonnet
      provider: 'anthropic',

      systemPrompt: [
        'You are a code reviewer in a critic colony.',
        'Review the code artifact and provide structured feedback.',
        'Be constructive but rigorous. Focus on correctness,',
        'error handling, type safety, and test coverage.',
      ].join('\n'),

      prompt: async (signal) => {
        const context = await assembleContext(signal, env, {
          includeLineage: true,
          lineageDepth: 2,
        });

        return [
          '## Code Review Request',
          '',
          `**Task:** ${signal.payload.task ?? signal.payload.text ?? 'unknown'}`,
          '',
          '### Artifact',
          '```',
          JSON.stringify(signal.payload, null, 2),
          '```',
          '',
          context,
          '',
          'Review this artifact and provide your assessment.',
        ].join('\n');
      },

      route: (result: any, signal) => {
        if (result.approved) {
          return {
            type: 'review:approved',
            payload: { ...result, artifact: signal.payload },
            tags: ['ready-to-merge'],
          };
        }
        return {
          type: 'review:changes-needed',
          payload: { ...result, artifact: signal.payload },
          tags: ['needs-rework'],
          ttl: 120_000,
        };
      },
    }))
    .concurrency(2)
    .claim('lease', 60_000)
    .poll(2000);
}

function keeper(c: ColonyBuilder) {
  return c
    .sense('review:approved', { unclaimed: true, minConcentration: 0.1 })
    .do('merge-artifact', withBash({
      command: (signal) => {
        const artifact = (signal.payload as any).artifact ?? {};
        const task = artifact.task ?? artifact.name ?? 'unknown';
        return `echo "Merged artifact: ${task}" && date`;
      },
      cwd: WORKSPACE,
      timeout: 30_000,

      output: (result, signal) => {
        const artifact = (signal.payload as any).artifact ?? {};
        if (result.exitCode === 0) {
          return {
            type: 'artifact:merged',
            payload: {
              task: artifact.task ?? artifact.name,
              stdout: result.stdout.trim(),
              durationMs: result.durationMs,
            },
            tags: ['complete'],
          };
        }
        return {
          type: 'merge:failed',
          payload: {
            task: artifact.task ?? artifact.name,
            stderr: result.stderr,
            exitCode: result.exitCode,
          },
          tags: ['needs-attention'],
        };
      },
    }))
    .concurrency(1)
    .claim('exclusive')
    .poll(2000);
}

// ----------------------------------------------------------
// Start via mandible DSL
// ----------------------------------------------------------

const host = await mandible('code-pipeline-providers')
  .environment(env)
  .colony('shaper', shaper)
  .colony('critic', critic)
  .colony('keeper', keeper)
  .start();

console.log(`Started ${host.colonies.length} colonies on ${host.name} host`);
console.log(`Environment: ${ENV_ROOT}`);
console.log(`Workspace:   ${WORKSPACE}\n`);

// Seed tasks
const tasks = [
  { name: 'auth-middleware', priority: 'high', description: 'Add JWT authentication middleware for Express' },
  { name: 'rate-limiter', priority: 'medium', description: 'Implement sliding window rate limiter' },
];

for (const task of tasks) {
  await env.deposit({
    type: 'task:ready',
    payload: task,
    meta: { deposited_by: 'seed', tags: [task.priority] },
  });
  console.log(`  seeded: task:ready "${task.name}"`);
}

console.log('\nColonies self-organizing with real LLM providers.');
console.log('Shaper: Claude Code SDK | Critic: Anthropic | Keeper: Bash\n');

await host.dashboard({ port: 4040 });
