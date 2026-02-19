// PURPOSE: Fixer colony — claims issue:detected signals and attempts to fix them using a Claude agent.
// PURPOSE: Deposits fix:proposed on success or fix:failed on failure.

import type { Environment, Signal } from '../../src/core/types.js';
import type { AgentResult, SignalDeposit } from '../../src/providers/types.js';
import { colony } from '../../src/dsl/builder.js';
import { withAgent } from '../../src/providers/agent.js';

// ----------------------------------------------------------
// Signal payload types
// ----------------------------------------------------------

/** Input: what the Fixer senses (from Scout or GitHub) */
export interface IssuePayload {
  category: string;
  severity: string;
  title: string;
  description: string;
  files: string[];
  suggested_fix?: string;
  previous_feedback?: string;
}

/** Output: what the Fixer deposits on success */
export interface FixProposedPayload {
  issue_title: string;
  branch: string;
  diff_summary: string;
  files_changed: string[];
  tests_passed: boolean;
  confidence: 'high' | 'medium' | 'low';
}

/** Output: what the Fixer deposits on failure */
export interface FixFailedPayload {
  issue_title: string;
  reason: string;
  attempted_approach?: string;
}

// ----------------------------------------------------------
// Fixer colony config
// ----------------------------------------------------------

export interface FixerColonyOptions {
  /** Signal types to sense. Defaults to ['issue:detected']. */
  senseTypes?: string | string[];
  /** Colony name. Defaults to 'fixer'. */
  name?: string;
  /** Model to use. Defaults to 'claude-sonnet-4-5-20250929'. */
  model?: string;
  /** Max budget per fix in USD. Defaults to 1.00. */
  maxBudgetUsd?: number;
  /** Max conversation turns. Defaults to 80. */
  maxTurns?: number;
  /** Allowed tools. Defaults to write-capable tools. */
  allowedTools?: string[];
  /** Disallowed tools. Defaults to []. */
  disallowedTools?: string[];
  /** Max concurrent fix attempts. Defaults to 2. */
  concurrency?: number;
  /** Claim lease duration in ms. Defaults to 120_000 (2 min). */
  claimLeaseDuration?: number;
}

// ----------------------------------------------------------
// Fixer colony factory
// ----------------------------------------------------------

export function createFixerColony(
  env: Environment,
  repoRoot: string,
  options: FixerColonyOptions = {}
) {
  const {
    senseTypes = 'issue:detected',
    name = 'fixer',
    model = 'claude-sonnet-4-5-20250929',
    maxBudgetUsd = 1.00,
    maxTurns = 80,
    allowedTools = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
    disallowedTools = [],
    concurrency = 2,
    claimLeaseDuration = 120_000,
  } = options;

  const types = Array.isArray(senseTypes) ? senseTypes : [senseTypes];

  let builder = colony(name).in(env);
  for (const t of types) {
    builder = builder.sense(t, { unclaimed: true });
  }
  const def = builder
    .do('fix-issue', withAgent({
      model,

      systemPrompt: [
        'You are a Fixer agent in a repo-maintenance colony.',
        'Your job is to claim a detected issue and produce a minimal, correct fix.',
        '',
        'Workflow:',
        '1. Create a branch named `mandible/fix-{category}-{short-hash}` from the current HEAD.',
        '   Use the first 6 chars of a random hex string for the short hash.',
        '2. Analyze the issue description and affected files.',
        '3. Make the MINIMAL change needed to resolve the issue.',
        '4. Run tests (`npm test` or `npx vitest run`) to verify the fix does not break anything.',
        '5. Output a JSON result block (see below).',
        '',
        'Constraints:',
        '- Do NOT merge to main. Only work on the fix branch.',
        '- Do NOT make changes beyond what is needed for this specific issue.',
        '- If a previous_feedback field is present, it means a prior fix attempt was rejected.',
        '  Use that feedback to improve your approach.',
        '- If you cannot fix the issue, output a failure result instead.',
        '',
        'Output format — wrap in a ```json code block:',
        '```json',
        '{',
        '  "status": "success",',
        '  "issue_title": "Short title of the issue",',
        '  "branch": "mandible/fix-category-abc123",',
        '  "diff_summary": "What changed and why",',
        '  "files_changed": ["file1.ts", "file2.ts"],',
        '  "tests_passed": true,',
        '  "confidence": "high"',
        '}',
        '```',
        '',
        'On failure:',
        '```json',
        '{',
        '  "status": "failure",',
        '  "issue_title": "Short title of the issue",',
        '  "reason": "Why the fix could not be applied",',
        '  "attempted_approach": "What was tried"',
        '}',
        '```',
      ].join('\n'),

      prompt: (signal) => {
        const p = signal.payload as Record<string, unknown>;
        const lines = [
          '## Fix Request',
          '',
          `**Category:** ${p.category ?? 'unknown'}`,
          `**Severity:** ${p.severity ?? 'medium'}`,
          `**Title:** ${p.title ?? 'Untitled issue'}`,
          '',
          '### Description',
          String(p.description ?? 'No description provided.'),
          '',
        ];

        const files = p.files as string[] | undefined;
        if (files && files.length > 0) {
          lines.push('### Affected Files');
          for (const f of files) {
            lines.push(`- ${f}`);
          }
          lines.push('');
        }

        if (p.suggested_fix) {
          lines.push('### Suggested Fix');
          lines.push(String(p.suggested_fix));
          lines.push('');
        }

        if (p.previous_feedback) {
          lines.push('### Previous Feedback (from rejected attempt)');
          lines.push(String(p.previous_feedback));
          lines.push('');
          lines.push('Use this feedback to improve your fix approach.');
          lines.push('');
        }

        lines.push('Apply the fix, run tests, and output the JSON result block.');

        return lines.join('\n');
      },

      allowedTools,
      disallowedTools,
      workingDirectory: repoRoot,
      maxBudgetUsd,
      maxTurns,

      output: (result: AgentResult, signal: Signal): SignalDeposit[] => {
        const parsed = parseFixerOutput(result.text);
        const issuePayload = signal.payload as Record<string, unknown>;
        const issueTitle = String(issuePayload.title ?? 'Unknown issue');

        if (parsed.status === 'failure') {
          return [{
            type: 'fix:failed',
            payload: {
              issue_title: parsed.issue_title || issueTitle,
              reason: parsed.reason || 'Agent did not produce a valid result',
              attempted_approach: parsed.attempted_approach,
              costUsd: result.costUsd,
              durationMs: result.durationMs,
            },
            tags: ['failure'],
          }];
        }

        return [{
          type: 'fix:proposed',
          payload: {
            issue_title: parsed.issue_title || issueTitle,
            branch: parsed.branch || 'unknown',
            diff_summary: parsed.diff_summary || '',
            files_changed: parsed.files_changed || [],
            tests_passed: parsed.tests_passed ?? false,
            confidence: parsed.confidence || 'low',
            costUsd: result.costUsd,
            durationMs: result.durationMs,
          },
          tags: [parsed.confidence || 'low', parsed.tests_passed ? 'tests-pass' : 'tests-fail'],
        }];
      },

      autoWithdraw: true,
    }))
    .concurrency(concurrency)
    .claim('lease', claimLeaseDuration)
    .poll(3000)
    .build();

  return def;
}

// ----------------------------------------------------------
// Output parser
// ----------------------------------------------------------

interface ParsedFixerSuccess {
  status: 'success';
  issue_title: string;
  branch: string;
  diff_summary: string;
  files_changed: string[];
  tests_passed: boolean;
  confidence: 'high' | 'medium' | 'low';
  reason?: undefined;
  attempted_approach?: undefined;
}

interface ParsedFixerFailure {
  status: 'failure';
  issue_title: string;
  reason: string;
  attempted_approach?: string;
  branch?: undefined;
  diff_summary?: undefined;
  files_changed?: undefined;
  tests_passed?: undefined;
  confidence?: undefined;
}

export type ParsedFixerOutput = ParsedFixerSuccess | ParsedFixerFailure;

/**
 * Extracts JSON result from the agent's markdown-formatted output.
 * Looks for a ```json code block, parses it, and validates the shape.
 */
export function parseFixerOutput(text: string): ParsedFixerOutput {
  if (!text) {
    return {
      status: 'failure',
      issue_title: '',
      reason: 'Empty agent output',
    };
  }

  // Try to find a JSON code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : text.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Try to find an object in the text
    const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        parsed = JSON.parse(objectMatch[0]);
      } catch {
        return {
          status: 'failure',
          issue_title: '',
          reason: 'Could not parse agent output as JSON',
        };
      }
    } else {
      return {
        status: 'failure',
        issue_title: '',
        reason: 'Could not parse agent output as JSON',
      };
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      status: 'failure',
      issue_title: '',
      reason: 'Agent output is not a JSON object',
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Check for explicit failure
  if (obj.status === 'failure') {
    return {
      status: 'failure',
      issue_title: typeof obj.issue_title === 'string' ? obj.issue_title : '',
      reason: typeof obj.reason === 'string' ? obj.reason : 'Unknown failure',
      ...(typeof obj.attempted_approach === 'string' ? { attempted_approach: obj.attempted_approach } : {}),
    };
  }

  // Treat as success — validate and normalize
  const validConfidences = new Set(['high', 'medium', 'low']);

  return {
    status: 'success',
    issue_title: typeof obj.issue_title === 'string' ? obj.issue_title : '',
    branch: typeof obj.branch === 'string' ? obj.branch : '',
    diff_summary: typeof obj.diff_summary === 'string' ? obj.diff_summary : '',
    files_changed: Array.isArray(obj.files_changed)
      ? (obj.files_changed as unknown[]).filter((f): f is string => typeof f === 'string')
      : [],
    tests_passed: typeof obj.tests_passed === 'boolean' ? obj.tests_passed : false,
    confidence: validConfidences.has(obj.confidence as string)
      ? (obj.confidence as 'high' | 'medium' | 'low')
      : 'low',
  };
}
