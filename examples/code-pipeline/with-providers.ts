#!/usr/bin/env tsx
// ============================================================
// Code Pipeline Demo — With Real LLM Providers
// ============================================================
// Same pipeline as index.ts, but using action providers
// instead of simulated work functions.
//
// Shaper:  withAgent (Claude Code SDK) — full coding agent
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
import { FilesystemEnvironment } from '../../src/environments/filesystem/index.js';
import { colony } from '../../src/dsl/index.js';
import { createRuntime } from '../../src/core/runtime.js';
import { withAgent } from '../../src/providers/agent.js';
import { withStructuredOutput } from '../../src/providers/structured-output.js';
import { withBash } from '../../src/providers/bash.js';
import { assembleContext } from '../../src/providers/context.js';

const ENV_ROOT = resolve('/tmp/stigmergy-demo-providers');
const WORKSPACE = resolve('/tmp/stigmergy-workspace');

async function setup() {
  await rm(ENV_ROOT, { recursive: true, force: true });
  await rm(WORKSPACE, { recursive: true, force: true });
  await mkdir(ENV_ROOT, { recursive: true });
  await mkdir(WORKSPACE, { recursive: true });
  console.log(`\n🌿 Environment: ${ENV_ROOT}`);
  console.log(`📁 Workspace:   ${WORKSPACE}\n`);
}

// ----------------------------------------------------------
// Colony definitions using real providers
// ----------------------------------------------------------

function defineColonies(env: FilesystemEnvironment) {

  // ── SHAPER — Full coding agent via Claude Code SDK ─────
  const shaperDef = colony('shaper')
    .in(env)
    .sense('task:ready', { unclaimed: true, minConcentration: 0.1 })
    .do('shape-code', withAgent({
      model: 'claude-sonnet-4-5-20250929',

      systemPrompt: [
        'You are a senior TypeScript engineer in a coding colony.',
        'You receive task specifications and implement them as clean, well-typed code.',
        'Create the implementation in the working directory.',
        'Include basic tests. Follow existing code conventions.',
        'Be concise — implement exactly what is asked, nothing more.',
      ].join('\n'),

      prompt: async (signal) => {
        // Assemble context from signal lineage
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

      tools: ['file_edit', 'bash'],
      workingDirectory: (signal) => resolve(WORKSPACE, String(signal.payload.name)),
      maxTokens: 4096,

      output: {
        type: 'artifact:shaped',
        tags: ['needs-review'],
      },
    }))
    .concurrency(2)
    .claim('lease', 120_000) // 2 min lease for agent work
    .poll(2000)
    .build();

  // ── CRITIC — Structured output via Anthropic SDK ───────
  const criticDef = colony('critic')
    .in(env)
    .sense('artifact:shaped', { unclaimed: true, minConcentration: 0.1 })
    .do('review-code', withStructuredOutput({
      model: 'claude-sonnet-4-5-20250929',
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

      // Schema would be a Zod object in real usage:
      // schema: z.object({
      //   approved: z.boolean(),
      //   feedback: z.string(),
      //   severity: z.enum(['minor', 'major', 'blocking']),
      //   suggestions: z.array(z.string()).optional(),
      // }),

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
    .poll(2000)
    .build();

  // ── KEEPER — Bash commands for mechanical merge ────────
  const keeperDef = colony('keeper')
    .in(env)
    .sense('review:approved', { unclaimed: true, minConcentration: 0.1 })
    .do('merge-artifact', withBash({
      command: (signal) => {
        const artifact = (signal.payload as any).artifact ?? {};
        const task = artifact.task ?? artifact.name ?? 'unknown';
        // In a real setup this would be:
        //   git merge feature/${task} --no-ff -m "Merge: ${task}"
        // For the demo, we just echo success
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
    .poll(2000)
    .build();

  return { shaperDef, criticDef, keeperDef };
}

// ----------------------------------------------------------
// Main
// ----------------------------------------------------------

async function main() {
  await setup();

  const env = new FilesystemEnvironment({ root: ENV_ROOT, name: 'code-pipeline' });
  const { shaperDef, criticDef, keeperDef } = defineColonies(env);

  const shaperRuntime = createRuntime(shaperDef, { rate: 0.002, interval: 15_000 });
  const criticRuntime = createRuntime(criticDef, { rate: 0.002, interval: 15_000 });
  const keeperRuntime = createRuntime(keeperDef, { rate: 0.002, interval: 15_000 });

  console.log('🚀 Starting colonies with LLM providers...\n');
  await Promise.all([
    shaperRuntime.start(),
    criticRuntime.start(),
    keeperRuntime.start(),
  ]);

  // Seed tasks
  console.log('📋 Seeding tasks...\n');
  const tasks = [
    { name: 'auth-middleware', priority: 'high', description: 'Add JWT authentication middleware for Express' },
    { name: 'rate-limiter', priority: 'medium', description: 'Implement sliding window rate limiter' },
  ];

  for (const task of tasks) {
    const signal = await env.deposit({
      type: 'task:ready',
      payload: task,
      meta: { deposited_by: 'orchestrator', tags: [task.priority] },
    });
    console.log(`   → task:ready "${task.name}" (${signal.id})`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log('   Colonies self-organizing with real LLM providers.');
  console.log('   Shaper: Claude Code SDK | Critic: Anthropic | Keeper: Bash');
  console.log('─'.repeat(60) + '\n');

  // Let colonies work
  await sleep(60_000);

  // Report
  console.log('\n' + '═'.repeat(60));
  const snapshot = await env.snapshot();
  console.log(`\n   Active signals: ${snapshot.length}`);
  for (const s of snapshot) {
    console.log(`     [${s.type}] ${JSON.stringify(s.payload).slice(0, 80)}`);
  }

  console.log('\n   Colony stats:');
  console.log(`     Shaper:  ${shaperRuntime.stats.signalsProcessed} processed`);
  console.log(`     Critic:  ${criticRuntime.stats.signalsProcessed} processed`);
  console.log(`     Keeper:  ${keeperRuntime.stats.signalsProcessed} processed`);

  await Promise.all([
    shaperRuntime.stop(),
    criticRuntime.stop(),
    keeperRuntime.stop(),
  ]);
  console.log('\n✅ Done.\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
