// PURPOSE: Scout colony — scans a repository for issues using a Claude agent.
// PURPOSE: Deposits one `issue:detected` signal per issue found, plus a `scan:completed` summary.

import type { Signal } from '../../src/core/types.js';
import type { AgentResult, SignalDeposit, BedrockConfig } from '../../src/providers/types.js';
import type { ColonyBuilder } from '../../src/dsl/builder.js';
import { withClaudeCode } from '../../src/providers/claude-code.js';

// ----------------------------------------------------------
// Signal payload types
// ----------------------------------------------------------

export interface ScanTriggerPayload {
  scope: 'full' | 'incremental';
  triggered_by: string;
}

export interface IssueDetectedPayload {
  category: 'dependency' | 'dead-code' | 'test-coverage' | 'security' | 'style' | 'stale-todo' | 'other';
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  files: string[];
  suggested_fix?: string;
}

// ----------------------------------------------------------
// Scout colony config
// ----------------------------------------------------------

export interface ScoutColonyOptions {
  /** Signal types to sense. Defaults to ['scan:trigger']. */
  senseTypes?: string | string[];
  /** Model to use. Defaults to 'sonnet'. */
  model?: string;
  /** Max budget per scan in USD. Defaults to 0.50. */
  maxBudgetUsd?: number;
  /** Max conversation turns. Defaults to 50. */
  maxTurns?: number;
  /** Allowed tools. Defaults to read-only tools. */
  allowedTools?: string[];
  /** Disallowed tools. Defaults to ['Edit', 'Write']. */
  disallowedTools?: string[];
  /** Route through AWS Bedrock instead of direct Anthropic API. */
  bedrock?: BedrockConfig;
}

// ----------------------------------------------------------
// Scout colony configurator
// ----------------------------------------------------------

/**
 * Returns a colony configurator for use with the mandible() DSL.
 *
 * @example
 * await mandible('repo-maintenance')
 *   .environment(env)
 *   .colony('scout', configureScout(repoRoot))
 *   .start();
 */
export function configureScout(
  repoRoot: string,
  options: ScoutColonyOptions = {}
) {
  const {
    senseTypes = 'scan:trigger',
    model = 'sonnet',
    maxBudgetUsd = 0.50,
    maxTurns = 50,
    allowedTools = ['Read', 'Glob', 'Grep', 'Bash'],
    disallowedTools = ['Edit', 'Write'],
    bedrock,
  } = options;

  const types = Array.isArray(senseTypes) ? senseTypes : [senseTypes];

  return (c: ColonyBuilder) => {
    for (const t of types) {
      c = c.sense(t, { unclaimed: true });
    }
    return c
      .do('scan-repo', withClaudeCode({
        model,

        systemPrompt: [
          'You are a Scout agent in a repo-maintenance colony.',
          'Your job is to scan a repository and identify issues.',
          '',
          'Categories to check:',
          '- dependency: outdated or vulnerable dependencies',
          '- dead-code: unused exports, unreachable code, unused files',
          '- test-coverage: untested code paths, missing edge cases',
          '- security: potential vulnerabilities (injection, secrets, etc.)',
          '- style: inconsistent formatting, naming, or patterns',
          '- stale-todo: TODO/FIXME/HACK comments that should be addressed',
          '',
          'For each issue found, include:',
          '- category (one of the above)',
          '- severity: low, medium, high, or critical',
          '- title: short one-line summary',
          '- description: what the issue is and why it matters',
          '- files: which files are affected',
          '- suggested_fix: optional fix suggestion',
          '',
          'IMPORTANT: Output your findings as a JSON array inside a ```json code block.',
          'Each element must match the schema above. Example:',
          '```json',
          '[',
          '  {',
          '    "category": "stale-todo",',
          '    "severity": "low",',
          '    "title": "Stale TODO in auth.ts",',
          '    "description": "TODO comment from 6 months ago about refactoring auth flow",',
          '    "files": ["src/auth.ts"],',
          '    "suggested_fix": "Either implement the refactor or remove the TODO"',
          '  }',
          ']',
          '```',
          '',
          'If no issues are found, output an empty array: ```json\n[]\n```',
        ].join('\n'),

        prompt: (signal) => {
          const p = signal.payload as Record<string, unknown>;
          const scope = p.scope ?? 'full';
          return [
            `## Repository Scan Request`,
            '',
            `**Scope:** ${scope}`,
            `**Triggered by:** ${p.triggered_by ?? 'manual'}`,
            '',
            'Scan this repository for issues across all categories.',
            'Focus on actionable findings — skip minor style nitpicks unless they indicate a pattern.',
            'Use the Glob, Grep, and Read tools to explore the codebase.',
            'Do NOT modify any files.',
          ].join('\n');
        },

        allowedTools,
        disallowedTools,
        workingDirectory: repoRoot,
        maxBudgetUsd,
        maxTurns,
        bedrock,

        output: (result: AgentResult, signal: Signal): SignalDeposit[] => {
          const issues = parseScoutOutput(result.text);
          const deposits: SignalDeposit[] = [];

          for (const issue of issues) {
            deposits.push({
              type: 'issue:detected',
              payload: issue as unknown as Record<string, unknown>,
              tags: [issue.category, issue.severity],
              ttl: 60 * 60_000, // 60 min — survive long enough for fixer to work the backlog
            });
          }

          deposits.push({
            type: 'scan:completed',
            payload: {
              scope: (signal.payload as any).scope ?? 'full',
              issueCount: issues.length,
              costUsd: result.costUsd,
              durationMs: result.durationMs,
            },
            tags: ['summary'],
          });

          return deposits;
        },

        autoWithdraw: true,
      }))
      .concurrency(1)
      .claim('none')
      .poll(3000);
  };
}

// ----------------------------------------------------------
// Output parser
// ----------------------------------------------------------

/**
 * Extracts JSON issue array from the agent's markdown-formatted output.
 * Looks for a ```json code block, parses it, and validates the shape.
 */
export function parseScoutOutput(text: string): IssueDetectedPayload[] {
  if (!text) return [];

  // Try to find a JSON code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : text.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // If the whole text isn't valid JSON, try to find an array in it
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        parsed = JSON.parse(arrayMatch[0]);
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  // Validate and normalize each issue
  const validCategories = new Set(['dependency', 'dead-code', 'test-coverage', 'security', 'style', 'stale-todo', 'other']);
  const validSeverities = new Set(['low', 'medium', 'high', 'critical']);

  return parsed
    .filter((item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null &&
      typeof item.title === 'string' &&
      typeof item.description === 'string'
    )
    .map((item) => ({
      category: validCategories.has(item.category as string)
        ? (item.category as IssueDetectedPayload['category'])
        : 'other',
      severity: validSeverities.has(item.severity as string)
        ? (item.severity as IssueDetectedPayload['severity'])
        : 'medium',
      title: item.title as string,
      description: item.description as string,
      files: Array.isArray(item.files)
        ? (item.files as string[]).filter(f => typeof f === 'string')
        : [],
      ...(typeof item.suggested_fix === 'string' ? { suggested_fix: item.suggested_fix } : {}),
    }));
}
