// PURPOSE: Tests for withSkill provider (skill-based colony provider)
// PURPOSE: Covers skill loading, frontmatter parsing, system prompt composition,
//          delegation to withToolLoop, tool validation warnings

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Signal, ActionContext } from '../../src/core/types.js';
import {
  parseFrontmatter,
  loadSkills,
} from '../../src/providers/skill.js';
import type { Skill, SkillMeta } from '../../src/providers/skill.js';
import type { ToolLoopResult } from '../../src/providers/tool-loop.js';

// ── Mock fs ─────────────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

// ── Mock fetch (for withToolLoop delegation) ────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  (readFile as any).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Helpers ─────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig_test_001',
    type: 'pr:needs-review',
    payload: { pr: 42, diff: '+ added line' },
    meta: {
      deposited_at: Date.now(),
      deposited_by: 'test',
      concentration: 1.0,
    },
    ...overrides,
  };
}

function makeContext(): ActionContext & {
  deposits: Array<{ type: string; payload: any; options: any }>;
  withdrawals: string[];
  logs: string[];
} {
  const deposits: Array<{ type: string; payload: any; options: any }> = [];
  const withdrawals: string[] = [];
  const logs: string[] = [];

  return {
    colony: 'test-colony',
    deposits,
    withdrawals,
    logs,
    async deposit(type, payload, options) {
      deposits.push({ type, payload, options });
      return {
        id: `sig_deposited_${deposits.length}`,
        type,
        payload: payload ?? {},
        meta: { deposited_at: Date.now(), deposited_by: 'test-colony', concentration: 1.0 },
      };
    },
    async withdraw(signalId) {
      withdrawals.push(signalId);
    },
    log(message) {
      logs.push(message);
    },
  };
}

function mockModelsResponse() {
  return new Response(
    JSON.stringify({ data: [{ id: 'Qwen3-Coder-Next' }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function mockChatResponse(content: string) {
  return new Response(
    JSON.stringify({
      choices: [{
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

const sampleSkillMd = `---
model: Qwen3-Coder-Next
tools: [file_read, grep, bash]
maxTurns: 25
tags: [review, quality]
---

# Code Review

You are a code reviewer. When reviewing code:

1. Check for correctness
2. Check for security issues
3. Check for performance problems

Output your review as JSON:
\`\`\`json
{"approved": true, "feedback": "LGTM"}
\`\`\`
`;

const sampleSkillNoFrontmatter = `# Security Audit

Check for common vulnerabilities:
- SQL injection
- XSS
- CSRF
- Hardcoded secrets
`;

// ── parseFrontmatter ────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('parses YAML frontmatter with all types', () => {
    const { meta, body } = parseFrontmatter(sampleSkillMd);

    expect(meta).toBeDefined();
    expect(meta!.model).toBe('Qwen3-Coder-Next');
    expect(meta!.tools).toEqual(['file_read', 'grep', 'bash']);
    expect(meta!.maxTurns).toBe(25);
    expect(meta!.tags).toEqual(['review', 'quality']);
    expect(body).toContain('# Code Review');
    expect(body).not.toContain('---');
  });

  it('returns body without meta when no frontmatter', () => {
    const { meta, body } = parseFrontmatter(sampleSkillNoFrontmatter);

    expect(meta).toBeUndefined();
    expect(body).toContain('# Security Audit');
  });

  it('handles boolean values in frontmatter', () => {
    const content = `---
strict: true
lenient: false
---

Content here`;

    const { meta } = parseFrontmatter(content);
    expect(meta!.strict).toBe(true);
    expect(meta!.lenient).toBe(false);
  });

  it('handles empty frontmatter', () => {
    const content = `---
---

Just content`;

    const { meta, body } = parseFrontmatter(content);
    expect(meta).toEqual({});
    expect(body).toBe('Just content');
  });
});

// ── loadSkills ──────────────────────────────────────────────

describe('loadSkills', () => {
  it('loads skills by name from skillsDir', async () => {
    (readFile as any).mockResolvedValueOnce(sampleSkillMd);

    const skills = await loadSkills(['code-review'], './skills');

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('code-review');
    expect(skills[0].content).toContain('# Code Review');
    expect(skills[0].meta?.model).toBe('Qwen3-Coder-Next');
    expect(readFile).toHaveBeenCalledWith(
      expect.stringContaining('skills/code-review/SKILL.md'),
      'utf-8'
    );
  });

  it('loads multiple skills', async () => {
    (readFile as any)
      .mockResolvedValueOnce(sampleSkillMd)
      .mockResolvedValueOnce(sampleSkillNoFrontmatter);

    const skills = await loadSkills(['code-review', 'security-audit'], './skills');

    expect(skills).toHaveLength(2);
    expect(skills[0].name).toBe('code-review');
    expect(skills[1].name).toBe('security-audit');
  });

  it('accepts pre-loaded Skill objects', async () => {
    const preloaded: Skill = {
      name: 'custom',
      content: 'Custom instructions',
      path: '/inline',
    };

    const skills = await loadSkills([preloaded], './skills');

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('custom');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('loads skill from absolute path ending in .md', async () => {
    (readFile as any).mockResolvedValueOnce(sampleSkillMd);

    const skills = await loadSkills(['/my/custom/SKILL.md'], './skills');

    expect(skills).toHaveLength(1);
    expect(readFile).toHaveBeenCalledWith('/my/custom/SKILL.md', 'utf-8');
  });

  it('throws on missing skill', async () => {
    (readFile as any).mockRejectedValueOnce(new Error('ENOENT: no such file'));

    await expect(
      loadSkills(['nonexistent'], './skills')
    ).rejects.toThrow(/Failed to load skill "nonexistent"/);
  });
});

// ── withSkill (integration with withToolLoop) ───────────────

describe('withSkill', () => {
  let withSkill: typeof import('../../src/providers/skill.js').withSkill;

  beforeEach(async () => {
    const mod = await import('../../src/providers/skill.js');
    withSkill = mod.withSkill;
  });

  it('loads skills and delegates to withToolLoop', async () => {
    // Mock skill loading
    (readFile as any).mockResolvedValueOnce(sampleSkillMd);

    // Skill frontmatter has model, so withToolLoop skips /v1/models — only chat call
    mockFetch
      .mockResolvedValueOnce(mockChatResponse('Review complete: LGTM'));

    const handler = withSkill({
      endpoint: 'http://localhost:8001',
      skills: ['code-review'],
      skillsDir: './skills',
      tools: [], // no tools for this test
      prompt: 'Review this PR',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    // Should have loaded the skill
    expect(ctx.logs).toContainEqual(expect.stringContaining('Loaded 1 skill(s): code-review'));

    // Should have deposited a result
    expect(ctx.deposits).toHaveLength(1);

    // The system prompt sent to vLLM should contain skill content
    // Model from frontmatter → no /v1/models call → chat is calls[0]
    const chatCall = mockFetch.mock.calls[0];
    const body = JSON.parse(chatCall[1].body);
    const systemMsg = body.messages.find((m: any) => m.role === 'system');
    expect(systemMsg.content).toContain('# Code Review');
    expect(systemMsg.content).toContain('Skill: code-review');
  });

  it('composes multiple skills into system prompt', async () => {
    (readFile as any)
      .mockResolvedValueOnce(sampleSkillMd)
      .mockResolvedValueOnce(sampleSkillNoFrontmatter);

    // First skill (code-review) has model in frontmatter → no /v1/models call
    mockFetch
      .mockResolvedValueOnce(mockChatResponse('Done'));

    const handler = withSkill({
      endpoint: 'http://localhost:8001',
      skills: ['code-review', 'security-audit'],
      skillsDir: './skills',
      tools: [],
      prompt: 'Review',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const chatCall = mockFetch.mock.calls[0];
    const body = JSON.parse(chatCall[1].body);
    const systemMsg = body.messages.find((m: any) => m.role === 'system');
    expect(systemMsg.content).toContain('Skill: code-review');
    expect(systemMsg.content).toContain('Skill: security-audit');
    expect(systemMsg.content).toContain('# Security Audit');
  });

  it('prepends base systemPrompt before skills', async () => {
    (readFile as any).mockResolvedValueOnce(sampleSkillNoFrontmatter);

    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockChatResponse('Done'));

    const handler = withSkill({
      endpoint: 'http://localhost:8001',
      skills: ['security-audit'],
      skillsDir: './skills',
      tools: [],
      prompt: 'Audit',
      systemPrompt: 'You are a senior security engineer.',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const chatCall = mockFetch.mock.calls[1];
    const body = JSON.parse(chatCall[1].body);
    const systemMsg = body.messages.find((m: any) => m.role === 'system');
    // Base prompt comes first, then skills
    const baseIdx = systemMsg.content.indexOf('senior security engineer');
    const skillIdx = systemMsg.content.indexOf('# Security Audit');
    expect(baseIdx).toBeLessThan(skillIdx);
  });

  it('uses model from skill frontmatter when not specified in config', async () => {
    (readFile as any).mockResolvedValueOnce(sampleSkillMd);

    // Skill frontmatter model → passed to withToolLoop → no /v1/models call
    mockFetch
      .mockResolvedValueOnce(mockChatResponse('Done'));

    const handler = withSkill({
      endpoint: 'http://localhost:8001',
      skills: ['code-review'],
      skillsDir: './skills',
      tools: [],
      prompt: 'Review',
      // No model specified — should use skill's recommended model
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const chatCall = mockFetch.mock.calls[0];
    const body = JSON.parse(chatCall[1].body);
    expect(body.model).toBe('Qwen3-Coder-Next');
  });

  it('config model takes precedence over skill frontmatter', async () => {
    (readFile as any).mockResolvedValueOnce(sampleSkillMd);

    // Explicit model → no /v1/models call
    mockFetch
      .mockResolvedValueOnce(mockChatResponse('Done'));

    const handler = withSkill({
      endpoint: 'http://localhost:8001',
      model: 'my-override-model',
      skills: ['code-review'],
      skillsDir: './skills',
      tools: [],
      prompt: 'Review',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    const chatCall = mockFetch.mock.calls[0];
    const body = JSON.parse(chatCall[1].body);
    expect(body.model).toBe('my-override-model');
  });

  it('warns when skill expects tools that are not available', async () => {
    // Skill wants [file_read, grep, bash] but we provide no tools
    (readFile as any).mockResolvedValueOnce(sampleSkillMd);

    // Skill has model in frontmatter → no /v1/models call
    mockFetch
      .mockResolvedValueOnce(mockChatResponse('Done'));

    const handler = withSkill({
      endpoint: 'http://localhost:8001',
      skills: ['code-review'],
      skillsDir: './skills',
      tools: [], // No tools provided
      prompt: 'Review',
    });

    const ctx = makeContext();
    await handler(makeSignal(), ctx);

    // Should log a warning about missing tools
    const warnings = ctx.logs.filter(l => l.includes('Warning'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('file_read');
    expect(warnings[0]).toContain('grep');
    expect(warnings[0]).toContain('bash');
  });

  it('caches loaded skills across invocations', async () => {
    (readFile as any).mockResolvedValueOnce(sampleSkillNoFrontmatter);

    // No model in frontmatter → withToolLoop calls /v1/models each time
    // First invocation: models + chat. Second invocation: models + chat.
    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockChatResponse('First'))
      .mockImplementation((url: string) => {
        // Handle both models and chat for subsequent invocations
        if (url.includes('/v1/models')) {
          return Promise.resolve(mockModelsResponse());
        }
        return Promise.resolve(mockChatResponse('Subsequent'));
      });

    const handler = withSkill({
      endpoint: 'http://localhost:8001',
      skills: ['security-audit'],
      skillsDir: './skills',
      tools: [],
      prompt: 'Audit',
    });

    const ctx1 = makeContext();
    await handler(makeSignal(), ctx1);

    const ctx2 = makeContext();
    await handler(makeSignal(), ctx2);

    // readFile should only be called once (cached after first load)
    expect(readFile).toHaveBeenCalledTimes(1);

    // Both should succeed
    expect(ctx1.deposits).toHaveLength(1);
    expect(ctx2.deposits).toHaveLength(1);
  });

  it('auto-withdraws triggering signal', async () => {
    (readFile as any).mockResolvedValueOnce(sampleSkillNoFrontmatter);

    mockFetch
      .mockResolvedValueOnce(mockModelsResponse())
      .mockResolvedValueOnce(mockChatResponse('Done'));

    const handler = withSkill({
      endpoint: 'http://localhost:8001',
      skills: ['security-audit'],
      skillsDir: './skills',
      tools: [],
      prompt: 'Audit',
    });

    const signal = makeSignal();
    const ctx = makeContext();
    await handler(signal, ctx);

    expect(ctx.withdrawals).toContain('sig_test_001');
  });
});
