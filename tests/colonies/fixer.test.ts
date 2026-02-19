// PURPOSE: Tests for the Fixer colony factory and output parser
// PURPOSE: Covers parseFixerOutput, createFixerColony, output mapping, and config options

import { describe, it, expect } from 'vitest';
import type { Signal } from '../../src/core/types.js';
import type { AgentResult, SignalDeposit } from '../../src/providers/types.js';
import {
  parseFixerOutput,
  createFixerColony,
  type ParsedFixerOutput,
  type FixerColonyOptions,
} from '../../examples/repo-maintenance/fixer.js';

// ── Helpers ──────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig_issue_001',
    type: 'issue:detected',
    payload: {
      category: 'stale-todo',
      severity: 'low',
      title: 'Stale TODO in auth.ts',
      description: 'TODO from 6 months ago',
      files: ['src/auth.ts'],
    },
    meta: {
      deposited_at: Date.now(),
      deposited_by: 'scout',
      concentration: 1.0,
    },
    ...overrides,
  };
}

function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    text: '',
    costUsd: 0.05,
    durationMs: 3000,
    usage: { input_tokens: 2000, output_tokens: 1000 },
    subtype: 'success',
    messages: [],
    ...overrides,
  };
}

/** Stub environment that satisfies the Environment interface for factory tests */
function makeStubEnv() {
  return {
    name: 'test-env',
    observe: async () => [],
    deposit: async (s: any) => ({ ...s, id: 'sig_new', meta: { deposited_at: Date.now(), deposited_by: 'test', concentration: 1.0 } }),
    withdraw: async () => {},
    claim: async () => true,
    release: async () => {},
    watch: () => ({ unsubscribe: () => {} }),
    history: async () => [],
    decay: async () => ({ decayed: 0, evaporated: 0, claimsReleased: 0 }),
    snapshot: async () => [],
  };
}

// ── parseFixerOutput ─────────────────────────────────────────

describe('parseFixerOutput', () => {
  it('extracts valid success JSON from a markdown code block', () => {
    const text = `
I've fixed the issue. Here's the result:

\`\`\`json
{
  "status": "success",
  "issue_title": "Stale TODO in auth.ts",
  "branch": "mandible/fix-stale-todo-a1b2c3",
  "diff_summary": "Removed stale TODO comment",
  "files_changed": ["src/auth.ts"],
  "tests_passed": true,
  "confidence": "high"
}
\`\`\`
`;
    const result = parseFixerOutput(text);
    expect(result.status).toBe('success');
    expect(result.issue_title).toBe('Stale TODO in auth.ts');
    expect(result.branch).toBe('mandible/fix-stale-todo-a1b2c3');
    expect(result.diff_summary).toBe('Removed stale TODO comment');
    expect(result.files_changed).toEqual(['src/auth.ts']);
    expect(result.tests_passed).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('extracts valid failure JSON from a markdown code block', () => {
    const text = `
I was unable to fix this issue.

\`\`\`json
{
  "status": "failure",
  "issue_title": "Complex refactor needed",
  "reason": "The fix requires architectural changes beyond my scope",
  "attempted_approach": "Tried to extract the function but it has circular deps"
}
\`\`\`
`;
    const result = parseFixerOutput(text);
    expect(result.status).toBe('failure');
    expect(result.issue_title).toBe('Complex refactor needed');
    expect(result.reason).toBe('The fix requires architectural changes beyond my scope');
    expect(result.attempted_approach).toBe('Tried to extract the function but it has circular deps');
  });

  it('handles empty input gracefully', () => {
    const result = parseFixerOutput('');
    expect(result.status).toBe('failure');
    expect(result.reason).toBe('Empty agent output');
  });

  it('handles completely malformed output', () => {
    const result = parseFixerOutput('This is not JSON at all, just rambling text.');
    expect(result.status).toBe('failure');
    expect(result.reason).toContain('Could not parse');
  });

  it('maps missing fields to defaults for success', () => {
    const text = '```json\n{ "status": "success" }\n```';
    const result = parseFixerOutput(text);
    expect(result.status).toBe('success');
    expect(result.issue_title).toBe('');
    expect(result.branch).toBe('');
    expect(result.diff_summary).toBe('');
    expect(result.files_changed).toEqual([]);
    expect(result.tests_passed).toBe(false);
    expect(result.confidence).toBe('low');
  });

  it('maps missing fields to defaults for failure', () => {
    const text = '```json\n{ "status": "failure" }\n```';
    const result = parseFixerOutput(text);
    expect(result.status).toBe('failure');
    expect(result.issue_title).toBe('');
    expect(result.reason).toBe('Unknown failure');
  });

  it('normalizes invalid confidence to low', () => {
    const text = '```json\n{ "status": "success", "confidence": "super-high" }\n```';
    const result = parseFixerOutput(text);
    expect(result.confidence).toBe('low');
  });

  it('filters non-string entries from files_changed', () => {
    const text = '```json\n{ "status": "success", "files_changed": ["valid.ts", 123, null, "also-valid.ts"] }\n```';
    const result = parseFixerOutput(text);
    expect(result.files_changed).toEqual(['valid.ts', 'also-valid.ts']);
  });

  it('handles JSON without code block wrapper', () => {
    const text = '{ "status": "success", "branch": "mandible/fix-abc", "confidence": "medium" }';
    const result = parseFixerOutput(text);
    expect(result.status).toBe('success');
    expect(result.branch).toBe('mandible/fix-abc');
    expect(result.confidence).toBe('medium');
  });

  it('finds JSON object embedded in surrounding text', () => {
    const text = 'Here is my result: { "status": "success", "branch": "mandible/fix-xyz" } and some trailing text';
    const result = parseFixerOutput(text);
    expect(result.status).toBe('success');
    expect(result.branch).toBe('mandible/fix-xyz');
  });

  it('rejects arrays as invalid', () => {
    const text = '```json\n[{"status": "success"}]\n```';
    const result = parseFixerOutput(text);
    expect(result.status).toBe('failure');
    expect(result.reason).toContain('not a JSON object');
  });

  it('treats unknown status as success', () => {
    const text = '```json\n{ "status": "partial", "branch": "mandible/fix-partial" }\n```';
    const result = parseFixerOutput(text);
    expect(result.status).toBe('success');
    expect(result.branch).toBe('mandible/fix-partial');
  });

  it('treats missing status as success', () => {
    const text = '```json\n{ "branch": "mandible/fix-no-status", "confidence": "high" }\n```';
    const result = parseFixerOutput(text);
    expect(result.status).toBe('success');
    expect(result.branch).toBe('mandible/fix-no-status');
    expect(result.confidence).toBe('high');
  });
});

// ── createFixerColony ────────────────────────────────────────

describe('createFixerColony', () => {
  it('returns a valid ColonyDefinition with defaults', () => {
    const env = makeStubEnv();
    const def = createFixerColony(env as any, '/tmp/repo');

    expect(def.name).toBe('fixer');
    expect(def.environment).toBe(env);
    expect(def.concurrency).toBe(2);
    expect(def.claimStrategy).toBe('lease');
    expect(def.sensors.length).toBeGreaterThanOrEqual(1);
    expect(def.rules.length).toBe(1);
    expect(def.rules[0].name).toBe('fix-issue');
  });

  it('default sense type is issue:detected', () => {
    const env = makeStubEnv();
    const def = createFixerColony(env as any, '/tmp/repo');

    const sensorTypes = def.sensors.map(s => s.query.type);
    expect(sensorTypes).toContain('issue:detected');
  });

  it('respects custom options', () => {
    const env = makeStubEnv();
    const def = createFixerColony(env as any, '/tmp/repo', {
      name: 'github-fixer',
      concurrency: 4,
      claimLeaseDuration: 300_000,
    });

    expect(def.name).toBe('github-fixer');
    expect(def.concurrency).toBe(4);
  });

  it('supports custom sense types for GitHub', () => {
    const env = makeStubEnv();
    const def = createFixerColony(env as any, '/tmp/repo', {
      senseTypes: ['golem:*', 'issue:*'],
    });

    const sensorTypes = def.sensors.map(s => s.query.type);
    expect(sensorTypes).toContain('golem:*');
    expect(sensorTypes).toContain('issue:*');
    expect(def.sensors.length).toBe(2);
  });

  it('accepts a single string sense type', () => {
    const env = makeStubEnv();
    const def = createFixerColony(env as any, '/tmp/repo', {
      senseTypes: 'golem:issue',
    });

    const sensorTypes = def.sensors.map(s => s.query.type);
    expect(sensorTypes).toContain('golem:issue');
    expect(def.sensors.length).toBe(1);
  });

  it('sets unclaimed: true on all sensors', () => {
    const env = makeStubEnv();
    const def = createFixerColony(env as any, '/tmp/repo');

    for (const sensor of def.sensors) {
      expect(sensor.query.unclaimed).toBe(true);
    }
  });
});

// ── Output mapper (integration with parseFixerOutput) ────────

describe('output mapper', () => {
  /**
   * Extract the output mapper from a built colony definition.
   * The withAgent provider wraps it, but we can test parseFixerOutput
   * + the mapping logic together by simulating what the output mapper does.
   */

  it('produces fix:proposed for successful agent output', () => {
    const successText = `
\`\`\`json
{
  "status": "success",
  "issue_title": "Outdated dep",
  "branch": "mandible/fix-dep-abc123",
  "diff_summary": "Bumped express to 4.19.2",
  "files_changed": ["package.json"],
  "tests_passed": true,
  "confidence": "high"
}
\`\`\``;
    const parsed = parseFixerOutput(successText);
    const signal = makeSignal();
    const result = makeAgentResult({ text: successText });

    // Simulate the output mapper logic from fixer.ts
    const deposits = mapFixerOutput(parsed, signal, result);

    expect(deposits.length).toBe(1);
    expect(deposits[0].type).toBe('fix:proposed');
    expect(deposits[0].payload?.branch).toBe('mandible/fix-dep-abc123');
    expect(deposits[0].payload?.tests_passed).toBe(true);
    expect(deposits[0].payload?.confidence).toBe('high');
    expect(deposits[0].tags).toContain('high');
    expect(deposits[0].tags).toContain('tests-pass');
  });

  it('produces fix:failed for failed agent output', () => {
    const failText = `
\`\`\`json
{
  "status": "failure",
  "issue_title": "Cannot fix",
  "reason": "Requires human intervention"
}
\`\`\``;
    const parsed = parseFixerOutput(failText);
    const signal = makeSignal();
    const result = makeAgentResult({ text: failText });

    const deposits = mapFixerOutput(parsed, signal, result);

    expect(deposits.length).toBe(1);
    expect(deposits[0].type).toBe('fix:failed');
    expect(deposits[0].payload?.reason).toBe('Requires human intervention');
    expect(deposits[0].tags).toContain('failure');
  });

  it('falls back to signal title when parsed issue_title is empty', () => {
    const text = '```json\n{ "status": "success" }\n```';
    const parsed = parseFixerOutput(text);
    const signal = makeSignal();
    const result = makeAgentResult({ text });

    const deposits = mapFixerOutput(parsed, signal, result);

    expect(deposits[0].payload?.issue_title).toBe('Stale TODO in auth.ts');
  });

  it('includes cost and duration metadata in deposits', () => {
    const text = '```json\n{ "status": "success", "branch": "mandible/fix-x" }\n```';
    const parsed = parseFixerOutput(text);
    const signal = makeSignal();
    const result = makeAgentResult({ text, costUsd: 0.12, durationMs: 5000 });

    const deposits = mapFixerOutput(parsed, signal, result);

    expect(deposits[0].payload?.costUsd).toBe(0.12);
    expect(deposits[0].payload?.durationMs).toBe(5000);
  });

  it('tags tests-fail when tests_passed is false', () => {
    const text = '```json\n{ "status": "success", "tests_passed": false }\n```';
    const parsed = parseFixerOutput(text);
    const signal = makeSignal();
    const result = makeAgentResult({ text });

    const deposits = mapFixerOutput(parsed, signal, result);

    expect(deposits[0].tags).toContain('tests-fail');
  });
});

// ── Helper: simulate the output mapper logic from fixer.ts ───

function mapFixerOutput(
  parsed: ParsedFixerOutput,
  signal: Signal,
  result: AgentResult,
): SignalDeposit[] {
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
}
