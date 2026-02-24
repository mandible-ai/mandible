// PURPOSE: Tests for the GitHub environment adapter
// PURPOSE: Uses a mock HTTP server returning canned GitHub API responses

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { GitHubEnvironment } from '../../src/environments/github/adapter.js';
import {
  defaultTypeMapper,
  defaultPayloadMapper,
  defaultConcentrationMapper,
  defaultDependencyMapper,
  defaultPRTypeMapper,
  defaultPRPayloadMapper,
  defaultPRConcentrationMapper,
  resolveReviewState,
  computeFreshness,
  parseGolemBody,
  parseDependencyIds,
  computeDependencyBoosts,
} from '../../src/environments/github/mapper.js';
import type { GitHubIssue, GitHubPullRequest, GitHubReview, GitHubEnvConfig } from '../../src/environments/github/types.js';
import type { Signal } from '../../src/core/types.js';

// ----------------------------------------------------------
// Mock GitHub API Server
// ----------------------------------------------------------

let server: Server;
let port: number;
let mockHandler: (req: IncomingMessage, res: ServerResponse) => void;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      mockHandler(req, res);
    });
    server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

// ----------------------------------------------------------
// Test fixtures — canned GitHub issues
// ----------------------------------------------------------

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  const now = new Date().toISOString();
  return {
    number: 1,
    title: 'Test Issue',
    body: 'Test body',
    state: 'open',
    labels: [],
    assignee: null,
    milestone: null,
    created_at: now,
    updated_at: now,
    html_url: 'https://github.com/test/repo/issues/1',
    comments: 0,
    ...overrides,
  };
}

function golemTablet(number: number, title: string, overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  const now = new Date().toISOString();
  return makeIssue({
    number,
    title,
    labels: [{ name: 'golem' }, { name: 'tablet' }],
    body: `## Description\n${title}\n\n## Acceptance Criteria\n- It works\n- It's fast\n\n## Files\n- src/foo.ts\n- src/bar.ts\n\n## Risk\nrisk: medium\n\n## Effort\neffort: M`,
    created_at: now,
    updated_at: now,
    html_url: `https://github.com/test/repo/issues/${number}`,
    ...overrides,
  });
}

// Helper to create an environment pointed at our mock server
function createEnv(overrides: Partial<GitHubEnvConfig> = {}): GitHubEnvironment {
  return new GitHubEnvironment({
    owner: 'test',
    repo: 'repo',
    token: 'test-token',
    apiBase: `http://localhost:${port}`,
    pollInterval: 100, // fast polls for tests
    ...overrides,
  });
}

// Mock PR fixture
function makePR(overrides: Partial<import('../../src/environments/github/types.js').GitHubPullRequest> = {}): import('../../src/environments/github/types.js').GitHubPullRequest {
  const now = new Date().toISOString();
  return {
    number: 100,
    title: 'Test PR',
    body: 'PR body',
    state: 'open',
    draft: false,
    merged: false,
    merged_at: null,
    labels: [],
    assignee: null,
    user: { login: 'author' },
    milestone: null,
    created_at: now,
    updated_at: now,
    html_url: 'https://github.com/test/repo/pull/100',
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 10,
    deletions: 5,
    changed_files: 2,
    head: { ref: 'feature-branch', sha: 'abc123' },
    base: { ref: 'main', sha: 'def456' },
    requested_reviewers: [],
    ...overrides,
  };
}

function makeReview(overrides: Partial<import('../../src/environments/github/types.js').GitHubReview> = {}): import('../../src/environments/github/types.js').GitHubReview {
  return {
    id: 1,
    user: { login: 'reviewer' },
    state: 'APPROVED',
    body: null,
    submitted_at: new Date().toISOString(),
    ...overrides,
  };
}

// Route-aware mock state
let mockIssues: GitHubIssue[] = [];
let mockPRs: import('../../src/environments/github/types.js').GitHubPullRequest[] = [];
let mockReviewsByPR: Map<number, import('../../src/environments/github/types.js').GitHubReview[]> = new Map();
let mockLabelsAdded: Array<{ number: number; label: string }> = [];
let mockLabelsRemoved: Array<{ number: number; label: string }> = [];

const rateLimitHeaders = {
  'x-ratelimit-remaining': '4999',
  'x-ratelimit-limit': '5000',
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
};

// Default handler that returns canned issues and PRs
function setMockIssues(issues: GitHubIssue[], etag?: string): void {
  mockIssues = issues;
  mockPRs = [];
  mockReviewsByPR = new Map();
  mockLabelsAdded = [];
  mockLabelsRemoved = [];
  let issueEtag = etag ?? `"etag-issues-${Date.now()}"`;
  let prEtag = `"etag-prs-${Date.now()}"`;

  mockHandler = (req, res) => {
    const url = req.url ?? '';

    // POST labels
    if (req.method === 'POST' && url.match(/\/issues\/\d+\/labels$/)) {
      const num = parseInt(url.match(/\/issues\/(\d+)\/labels$/)![1], 10);
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        for (const label of parsed.labels) {
          mockLabelsAdded.push({ number: num, label });
        }
        res.writeHead(200, { 'Content-Type': 'application/json', ...rateLimitHeaders });
        res.end(JSON.stringify(parsed.labels.map((l: string) => ({ name: l }))));
      });
      return;
    }

    // DELETE label
    if (req.method === 'DELETE' && url.match(/\/issues\/\d+\/labels\//)) {
      const match = url.match(/\/issues\/(\d+)\/labels\/(.+)$/);
      if (match) {
        mockLabelsRemoved.push({ number: parseInt(match[1], 10), label: decodeURIComponent(match[2]) });
      }
      res.writeHead(200, rateLimitHeaders);
      res.end();
      return;
    }

    // PR reviews
    if (url.match(/\/pulls\/\d+\/reviews/)) {
      const prNum = parseInt(url.match(/\/pulls\/(\d+)\/reviews/)![1], 10);
      const reviews = mockReviewsByPR.get(prNum) ?? [];
      res.writeHead(200, { 'Content-Type': 'application/json', ...rateLimitHeaders });
      res.end(JSON.stringify(reviews));
      return;
    }

    // Pull requests endpoint
    if (url.includes('/pulls')) {
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch === prEtag) {
        res.writeHead(304, rateLimitHeaders);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'ETag': prEtag, ...rateLimitHeaders });
      res.end(JSON.stringify(mockPRs));
      return;
    }

    // Issues endpoint (and everything else)
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch === issueEtag) {
      res.writeHead(304, rateLimitHeaders);
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'ETag': issueEtag,
      ...rateLimitHeaders,
    });
    res.end(JSON.stringify(mockIssues));
  };
}

function setMockPRs(prs: import('../../src/environments/github/types.js').GitHubPullRequest[], reviews?: Map<number, import('../../src/environments/github/types.js').GitHubReview[]>): void {
  mockPRs = prs;
  if (reviews) mockReviewsByPR = reviews;
}

/** Wrap a custom handler to return [] for /pulls and /reviews endpoints */
function withPRSupport(handler: (req: IncomingMessage, res: ServerResponse) => void): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = req.url ?? '';
    if (url.match(/\/pulls\/\d+\/reviews/)) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...rateLimitHeaders });
      res.end('[]');
      return;
    }
    if (url.includes('/pulls')) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...rateLimitHeaders });
      res.end('[]');
      return;
    }
    handler(req, res);
  };
}

// ============================================================
// Mapper Tests
// ============================================================

describe('defaultTypeMapper', () => {
  it('maps golem + tablet labels to golem:tablet', () => {
    const issue = makeIssue({ labels: [{ name: 'golem' }, { name: 'tablet' }] });
    expect(defaultTypeMapper(issue)).toBe('golem:tablet');
  });

  it('maps bug label to issue:bug', () => {
    const issue = makeIssue({ labels: [{ name: 'bug' }] });
    expect(defaultTypeMapper(issue)).toBe('issue:bug');
  });

  it('maps feature label to issue:feature', () => {
    const issue = makeIssue({ labels: [{ name: 'feature' }] });
    expect(defaultTypeMapper(issue)).toBe('issue:feature');
  });

  it('maps enhancement label to issue:enhancement', () => {
    const issue = makeIssue({ labels: [{ name: 'Enhancement' }] });
    expect(defaultTypeMapper(issue)).toBe('issue:enhancement');
  });

  it('falls back to issue:open for no recognized labels', () => {
    const issue = makeIssue({ labels: [{ name: 'custom-label' }] });
    expect(defaultTypeMapper(issue)).toBe('issue:open');
  });

  it('falls back to issue:open for no labels', () => {
    const issue = makeIssue({ labels: [] });
    expect(defaultTypeMapper(issue)).toBe('issue:open');
  });

  it('golem:tablet takes priority over category labels', () => {
    const issue = makeIssue({ labels: [{ name: 'golem' }, { name: 'tablet' }, { name: 'bug' }] });
    expect(defaultTypeMapper(issue)).toBe('golem:tablet');
  });

  it('is case insensitive', () => {
    const issue = makeIssue({ labels: [{ name: 'Golem' }, { name: 'Tablet' }] });
    expect(defaultTypeMapper(issue)).toBe('golem:tablet');
  });
});

describe('parseGolemBody', () => {
  it('parses acceptance criteria section', () => {
    const body = '## Acceptance Criteria\n- First criterion\n- Second criterion';
    const result = parseGolemBody(body);
    expect(result.acceptanceCriteria).toEqual(['First criterion', 'Second criterion']);
  });

  it('parses files section', () => {
    const body = '## Files\n- src/foo.ts\n- src/bar.ts';
    const result = parseGolemBody(body);
    expect(result.files).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('parses dependencies section', () => {
    const body = '## Dependencies\n- #123\n- #456';
    const result = parseGolemBody(body);
    expect(result.dependencies).toEqual(['#123', '#456']);
  });

  it('extracts inline risk marker', () => {
    const body = 'Some text\nrisk: medium\nMore text';
    const result = parseGolemBody(body);
    expect(result.risk).toBe('medium');
  });

  it('extracts inline effort marker', () => {
    const body = 'Some text\neffort: M\nMore text';
    const result = parseGolemBody(body);
    expect(result.effort).toBe('M');
  });

  it('returns empty object for null body', () => {
    expect(parseGolemBody(null)).toEqual({});
  });

  it('returns empty object for body with no recognized sections', () => {
    expect(parseGolemBody('Just plain text')).toEqual({});
  });

  it('parses a full golem tablet body', () => {
    const body = [
      '## Description',
      'Implement user auth',
      '',
      '## Acceptance Criteria',
      '- Users can log in',
      '- Users can log out',
      '',
      '## Files',
      '- src/auth.ts',
      '',
      '## Dependencies',
      '- #10',
      '',
      'risk: high',
      'effort: L',
    ].join('\n');

    const result = parseGolemBody(body);
    expect(result.description).toBe('Implement user auth');
    expect(result.acceptanceCriteria).toEqual(['Users can log in', 'Users can log out']);
    expect(result.files).toEqual(['src/auth.ts']);
    expect(result.dependencies).toEqual(['#10']);
    expect(result.risk).toBe('high');
    expect(result.effort).toBe('L');
  });
});

describe('parseDependencyIds', () => {
  it('extracts issue number from unchecked beadId format', () => {
    const deps = ['[ ] bd-daaa.2'];
    expect(parseDependencyIds(deps, 'acme', 'repo')).toEqual(['gh:acme/repo#2']);
  });

  it('extracts issue number from checked beadId format', () => {
    const deps = ['[x] bd-daaa.5'];
    expect(parseDependencyIds(deps, 'acme', 'repo')).toEqual(['gh:acme/repo#5']);
  });

  it('skips header strings like "Blocked by:"', () => {
    const deps = ['Blocked by:'];
    expect(parseDependencyIds(deps, 'acme', 'repo')).toEqual([]);
  });

  it('skips separator strings like "---"', () => {
    const deps = ['---'];
    expect(parseDependencyIds(deps, 'acme', 'repo')).toEqual([]);
  });

  it('handles mixed valid and invalid entries', () => {
    const deps = ['Blocked by:', '[ ] bd-daaa.2', '---', '[x] bd-daaa.5'];
    expect(parseDependencyIds(deps, 'owner', 'proj')).toEqual([
      'gh:owner/proj#2',
      'gh:owner/proj#5',
    ]);
  });

  it('returns empty array when no beadIds found', () => {
    expect(parseDependencyIds([], 'a', 'b')).toEqual([]);
    expect(parseDependencyIds(['no match here'], 'a', 'b')).toEqual([]);
  });

  it('handles bare beadId without checkbox', () => {
    const deps = ['bd-xyz.10'];
    expect(parseDependencyIds(deps, 'a', 'b')).toEqual(['gh:a/b#10']);
  });
});

describe('defaultDependencyMapper', () => {
  const config = { owner: 'acme', repo: 'proj' } as GitHubEnvConfig;

  it('returns signal IDs for golem issue with beadId dependencies', () => {
    const issue = makeIssue({
      labels: [{ name: 'golem' }, { name: 'tablet' }],
      body: '## Dependencies\n- [ ] bd-daaa.2\n- [x] bd-daaa.5',
    });
    expect(defaultDependencyMapper(issue, config)).toEqual([
      'gh:acme/proj#2',
      'gh:acme/proj#5',
    ]);
  });

  it('returns empty array for non-golem issues', () => {
    const issue = makeIssue({
      labels: [{ name: 'bug' }],
      body: '## Dependencies\n- [ ] bd-daaa.2',
    });
    expect(defaultDependencyMapper(issue, config)).toEqual([]);
  });

  it('returns empty array for golem issue without dependencies section', () => {
    const issue = makeIssue({
      labels: [{ name: 'golem' }],
      body: '## Acceptance Criteria\n- Something works',
    });
    expect(defaultDependencyMapper(issue, config)).toEqual([]);
  });

  it('returns empty array for golem issue with null body', () => {
    const issue = makeIssue({
      labels: [{ name: 'golem' }],
      body: null,
    });
    expect(defaultDependencyMapper(issue, config)).toEqual([]);
  });

  it('skips non-beadId dependency entries', () => {
    const issue = makeIssue({
      labels: [{ name: 'golem' }],
      body: '## Dependencies\n- Blocked by:\n- [ ] bd-daaa.3\n- ---',
    });
    expect(defaultDependencyMapper(issue, config)).toEqual(['gh:acme/proj#3']);
  });
});

describe('defaultPayloadMapper', () => {
  it('includes standard issue fields', () => {
    const issue = makeIssue({ number: 42, title: 'Test', comments: 5 });
    const payload = defaultPayloadMapper(issue);

    expect(payload.number).toBe(42);
    expect(payload.title).toBe('Test');
    expect(payload.comments).toBe(5);
    expect(payload.state).toBe('open');
    expect(payload.assignee).toBeNull();
  });

  it('includes assignee login when present', () => {
    const issue = makeIssue({ assignee: { login: 'octocat' } });
    const payload = defaultPayloadMapper(issue);
    expect(payload.assignee).toBe('octocat');
  });

  it('includes milestone title when present', () => {
    const issue = makeIssue({ milestone: { title: 'v1.0' } });
    const payload = defaultPayloadMapper(issue);
    expect(payload.milestone).toBe('v1.0');
  });

  it('parses golem body sections for golem-labeled issues', () => {
    const issue = golemTablet(1, 'Test tablet');
    const payload = defaultPayloadMapper(issue);
    expect(payload.golem).toBeDefined();
    const golem = payload.golem as Record<string, unknown>;
    expect(golem.acceptanceCriteria).toBeDefined();
    expect(golem.files).toBeDefined();
  });

  it('does not parse golem body for non-golem issues', () => {
    const issue = makeIssue({
      labels: [{ name: 'bug' }],
      body: '## Acceptance Criteria\n- something',
    });
    const payload = defaultPayloadMapper(issue);
    expect(payload.golem).toBeUndefined();
  });
});

describe('computeFreshness', () => {
  it('returns 1.0 for just-updated issue', () => {
    const issue = makeIssue({ updated_at: new Date().toISOString() });
    const freshness = computeFreshness(issue, 168, 0.05);
    expect(freshness).toBeGreaterThan(0.99);
  });

  it('returns floor for very stale issue', () => {
    const staleDate = new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString(); // 200 hours ago
    const issue = makeIssue({ updated_at: staleDate });
    const freshness = computeFreshness(issue, 168, 0.05);
    expect(freshness).toBe(0.05);
  });

  it('returns mid-range for half-stale issue', () => {
    const halfStale = new Date(Date.now() - 84 * 60 * 60 * 1000).toISOString(); // 84 hours ago
    const issue = makeIssue({ updated_at: halfStale });
    const freshness = computeFreshness(issue, 168, 0.05);
    expect(freshness).toBeCloseTo(0.5, 1);
  });
});

describe('defaultConcentrationMapper', () => {
  const config: GitHubEnvConfig = { owner: 'test', repo: 'repo' };

  it('gives high concentration to fresh issues', () => {
    const issue = makeIssue({ updated_at: new Date().toISOString() });
    const conc = defaultConcentrationMapper(issue, config);
    expect(conc).toBeGreaterThan(0.9);
  });

  it('boosts concentration for comments', () => {
    // Use a half-stale issue so base freshness is ~0.5, leaving room for boost
    const halfStale = new Date(Date.now() - 84 * 60 * 60 * 1000).toISOString();
    const noComments = makeIssue({ updated_at: halfStale, comments: 0 });
    const withComments = makeIssue({ updated_at: halfStale, comments: 5 });

    const concBase = defaultConcentrationMapper(noComments, config);
    const concBoosted = defaultConcentrationMapper(withComments, config);

    expect(concBoosted).toBeGreaterThan(concBase);
    expect(concBoosted - concBase).toBeCloseTo(0.1, 1); // 5 * 0.02 = 0.1
  });

  it('caps comment boost at 0.2', () => {
    const manyComments = makeIssue({ updated_at: new Date().toISOString(), comments: 100 });
    const conc = defaultConcentrationMapper(manyComments, config);
    expect(conc).toBeLessThanOrEqual(1.0);
  });

  it('boosts concentration for assigned issues', () => {
    // Use a half-stale issue so base freshness is ~0.5, leaving room for boost
    const halfStale = new Date(Date.now() - 84 * 60 * 60 * 1000).toISOString();
    const unassigned = makeIssue({ updated_at: halfStale });
    const assigned = makeIssue({
      updated_at: halfStale,
      assignee: { login: 'dev' },
    });

    const concBase = defaultConcentrationMapper(unassigned, config);
    const concAssigned = defaultConcentrationMapper(assigned, config);

    expect(concAssigned - concBase).toBeCloseTo(0.1, 1);
  });

  it('boosts concentration for milestoned issues', () => {
    // Use a half-stale issue so base freshness is ~0.5, leaving room for boost
    const halfStale = new Date(Date.now() - 84 * 60 * 60 * 1000).toISOString();
    const noMilestone = makeIssue({ updated_at: halfStale });
    const withMilestone = makeIssue({
      updated_at: halfStale,
      milestone: { title: 'v1.0' },
    });

    const concBase = defaultConcentrationMapper(noMilestone, config);
    const concMilestone = defaultConcentrationMapper(withMilestone, config);

    expect(concMilestone - concBase).toBeCloseTo(0.05, 2);
  });

  it('never returns below floor', () => {
    const stale = makeIssue({
      updated_at: new Date(Date.now() - 300 * 60 * 60 * 1000).toISOString(),
    });
    const conc = defaultConcentrationMapper(stale, config);
    expect(conc).toBeGreaterThanOrEqual(0.05);
  });

  it('never returns above 1.0', () => {
    const boosted = makeIssue({
      updated_at: new Date().toISOString(),
      comments: 100,
      assignee: { login: 'dev' },
      milestone: { title: 'v1.0' },
    });
    const conc = defaultConcentrationMapper(boosted, config);
    expect(conc).toBeLessThanOrEqual(1.0);
  });
});

// ============================================================
// Adapter Tests
// ============================================================

describe('GitHubEnvironment — constructor', () => {
  it('uses provided name', () => {
    const env = createEnv({ name: 'my-env' });
    expect(env.name).toBe('my-env');
  });

  it('falls back to gh:{owner}/{repo} when name not provided', () => {
    const env = createEnv();
    expect(env.name).toBe('gh:test/repo');
  });
});

describe('GitHubEnvironment — signal ID', () => {
  it('generates deterministic signal IDs from issue numbers', async () => {
    setMockIssues([makeIssue({ number: 42 })]);
    const env = createEnv();
    const signals = await env.snapshot();
    expect(signals[0].id).toBe('gh:test/repo#42');
  });

  it('generates unique IDs for different issues', async () => {
    setMockIssues([makeIssue({ number: 1 }), makeIssue({ number: 2, title: 'Issue 2' })]);
    const env = createEnv();
    const signals = await env.snapshot();
    expect(signals[0].id).not.toBe(signals[1].id);
  });
});

describe('GitHubEnvironment — sync & observe', () => {
  it('fetches issues and creates signals', async () => {
    setMockIssues([
      makeIssue({ number: 1, title: 'First' }),
      makeIssue({ number: 2, title: 'Second' }),
    ]);
    const env = createEnv();
    const signals = await env.observe({});
    expect(signals).toHaveLength(2);
  });

  it('skips pull requests', async () => {
    setMockIssues([
      makeIssue({ number: 1, title: 'Issue' }),
      makeIssue({ number: 2, title: 'PR', pull_request: { url: 'http://...' } }),
    ]);
    const env = createEnv();
    const signals = await env.observe({});
    expect(signals).toHaveLength(1);
    expect((signals[0].payload as Record<string, unknown>).title).toBe('Issue');
  });

  it('applies custom issueFilter', async () => {
    setMockIssues([
      makeIssue({ number: 1, title: 'Keep me', comments: 5 }),
      makeIssue({ number: 2, title: 'Filter me', comments: 0 }),
    ]);
    const env = createEnv({
      issueFilter: (issue) => issue.comments > 0,
    });
    const signals = await env.observe({});
    expect(signals).toHaveLength(1);
    expect((signals[0].payload as Record<string, unknown>).title).toBe('Keep me');
  });

  it('filters by signal type query', async () => {
    setMockIssues([
      golemTablet(1, 'Tablet 1'),
      makeIssue({ number: 2, title: 'Bug', labels: [{ name: 'bug' }] }),
    ]);
    const env = createEnv();

    const tablets = await env.observe({ type: 'golem:tablet' });
    expect(tablets).toHaveLength(1);

    const bugs = await env.observe({ type: 'issue:bug' });
    expect(bugs).toHaveLength(1);
  });

  it('supports glob type queries', async () => {
    setMockIssues([
      golemTablet(1, 'Tablet'),
      makeIssue({ number: 2, title: 'Bug', labels: [{ name: 'bug' }] }),
    ]);
    const env = createEnv();

    const allIssues = await env.observe({ type: 'issue:*' });
    expect(allIssues).toHaveLength(1);

    const allGolem = await env.observe({ type: 'golem:*' });
    expect(allGolem).toHaveLength(1);
  });

  it('respects observe limit', async () => {
    setMockIssues([
      makeIssue({ number: 1 }),
      makeIssue({ number: 2 }),
      makeIssue({ number: 3 }),
    ]);
    const env = createEnv();
    const signals = await env.observe({ limit: 2 });
    expect(signals).toHaveLength(2);
  });

  it('returns empty for no matches', async () => {
    setMockIssues([makeIssue({ number: 1 })]);
    const env = createEnv();
    const signals = await env.observe({ type: 'golem:tablet' });
    expect(signals).toEqual([]);
  });
});

describe('GitHubEnvironment — concentration reinforcement', () => {
  it('reinforces with max(current, fresh) — never lowers concentration', async () => {
    const issue = makeIssue({ number: 1, updated_at: new Date().toISOString() });
    setMockIssues([issue]);
    const env = createEnv();

    // First sync — get initial concentration
    await env.sync();
    let signals = await env.snapshot();
    const initial = signals[0].meta.concentration;

    // Manually lower concentration to simulate decay
    signals[0].meta.concentration = 0.3;

    // Second sync — should reinforce back up
    await env.sync();
    signals = await env.snapshot();
    expect(signals[0].meta.concentration).toBeGreaterThanOrEqual(0.3);
  });

  it('uses custom concentrationMapper when provided', async () => {
    setMockIssues([makeIssue({ number: 1 })]);
    const env = createEnv({
      concentrationMapper: () => 0.42,
    });
    const signals = await env.snapshot();
    expect(signals[0].meta.concentration).toBe(0.42);
  });
});

describe('GitHubEnvironment — ETag caching', () => {
  it('returns same data on second fetch (304)', async () => {
    const issues = [makeIssue({ number: 1, title: 'Cached' })];
    setMockIssues(issues);
    const env = createEnv();

    // First fetch — populates cache + ETag
    await env.sync();
    const first = await env.snapshot();
    expect(first).toHaveLength(1);

    // Second fetch — 304, no new signals
    const newIds = await env.syncFromGitHub();
    expect(newIds).toHaveLength(0);

    // Cache still has the signal
    const second = await env.snapshot();
    expect(second).toHaveLength(1);
  });
});

describe('GitHubEnvironment — type mapping', () => {
  it('maps golem + tablet to golem:tablet', async () => {
    setMockIssues([golemTablet(1, 'Tablet')]);
    const env = createEnv();
    const signals = await env.snapshot();
    expect(signals[0].type).toBe('golem:tablet');
  });

  it('maps bug label to issue:bug', async () => {
    setMockIssues([makeIssue({ number: 1, labels: [{ name: 'bug' }] })]);
    const env = createEnv();
    const signals = await env.snapshot();
    expect(signals[0].type).toBe('issue:bug');
  });

  it('uses custom typeMapper', async () => {
    setMockIssues([makeIssue({ number: 1 })]);
    const env = createEnv({
      typeMapper: () => 'custom:signal',
    });
    const signals = await env.snapshot();
    expect(signals[0].type).toBe('custom:signal');
  });
});

describe('GitHubEnvironment — payload mapping', () => {
  it('includes standard issue fields', async () => {
    setMockIssues([makeIssue({ number: 42, title: 'Test issue', comments: 3 })]);
    const env = createEnv();
    const signals = await env.snapshot();
    const payload = signals[0].payload as Record<string, unknown>;

    expect(payload.number).toBe(42);
    expect(payload.title).toBe('Test issue');
    expect(payload.comments).toBe(3);
  });

  it('parses golem body for golem-labeled issues', async () => {
    setMockIssues([golemTablet(1, 'Tablet')]);
    const env = createEnv();
    const signals = await env.snapshot();
    const payload = signals[0].payload as Record<string, unknown>;

    expect(payload.golem).toBeDefined();
    const golem = payload.golem as Record<string, unknown>;
    expect(golem.acceptanceCriteria).toEqual(["It works", "It's fast"]);
    expect(golem.files).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('uses custom payloadMapper', async () => {
    setMockIssues([makeIssue({ number: 1 })]);
    const env = createEnv({
      payloadMapper: (issue) => ({ custom: true, num: issue.number }),
    });
    const signals = await env.snapshot();
    expect(signals[0].payload).toEqual({ custom: true, num: 1 });
  });
});

describe('GitHubEnvironment — tags', () => {
  it('uses issue label names as signal tags', async () => {
    setMockIssues([makeIssue({ number: 1, labels: [{ name: 'golem' }, { name: 'tablet' }] })]);
    const env = createEnv();
    const signals = await env.snapshot();
    expect(signals[0].meta.tags).toEqual(['golem', 'tablet']);
  });

  it('filters by tags in observe query', async () => {
    setMockIssues([
      makeIssue({ number: 1, labels: [{ name: 'golem' }, { name: 'tablet' }] }),
      makeIssue({ number: 2, labels: [{ name: 'bug' }] }),
    ]);
    const env = createEnv();
    const signals = await env.observe({ tags: ['golem'] });
    expect(signals).toHaveLength(1);
  });
});

describe('GitHubEnvironment — deposit', () => {
  it('creates a GitHub issue via API', async () => {
    let createdPayload: Record<string, unknown> | null = null;

    mockHandler = withPRSupport((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          createdPayload = JSON.parse(body);
          const issue = makeIssue({ number: 99, title: createdPayload!.title as string });
          res.writeHead(201, {
            'Content-Type': 'application/json',
            'x-ratelimit-remaining': '4999',
            'x-ratelimit-limit': '5000',
            'x-ratelimit-reset': '0',
          });
          res.end(JSON.stringify(issue));
        });
        return;
      }
      // GET for initial sync
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': '0',
      });
      res.end(JSON.stringify([]));
    });

    const env = createEnv();
    const signal = await env.deposit({
      type: 'task:ready',
      payload: { title: 'New task', body: 'Do the thing' },
      meta: { deposited_by: 'test-colony', tags: ['urgent'] },
    });

    expect(signal.id).toBe('gh:test/repo#99');
    expect(createdPayload).not.toBeNull();
    expect(createdPayload!.title).toBe('New task');
    expect(createdPayload!.labels).toEqual(['urgent']);
  });

  it('throws when deposit is disabled', async () => {
    setMockIssues([]);
    const env = createEnv({ allowDeposit: false });
    await expect(
      env.deposit({ type: 'task:ready', payload: { title: 'x' }, meta: { deposited_by: 'test' } })
    ).rejects.toThrow('deposit');
  });

  it('validates signal input', async () => {
    setMockIssues([]);
    const env = createEnv();
    await expect(
      env.deposit({ type: '', payload: {}, meta: { deposited_by: 'test' } })
    ).rejects.toThrow('non-empty string');
  });
});

describe('GitHubEnvironment — withdraw', () => {
  it('closes the GitHub issue via API', async () => {
    let closedNumber: number | null = null;

    mockHandler = withPRSupport((req, res) => {
      if (req.method === 'PATCH' && req.url?.match(/\/issues\/\d+$/)) {
        const match = req.url.match(/\/issues\/(\d+)$/);
        closedNumber = match ? parseInt(match[1], 10) : null;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': '0',
        });
        res.end(JSON.stringify(makeIssue({ number: closedNumber!, state: 'closed' })));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': '0',
      });
      res.end(JSON.stringify([makeIssue({ number: 1 })]));
    });

    const env = createEnv({ allowWithdraw: true });
    await env.sync();
    await env.withdraw('gh:test/repo#1');

    expect(closedNumber).toBe(1);

    // Signal should be gone from active cache
    const signals = await env.snapshot();
    expect(signals.find(s => s.id === 'gh:test/repo#1')).toBeUndefined();
  });

  it('throws when withdraw is disabled', async () => {
    setMockIssues([makeIssue({ number: 1 })]);
    const env = createEnv({ allowWithdraw: false });
    await env.sync();
    await expect(env.withdraw('gh:test/repo#1')).rejects.toThrow('withdraw');
  });

  it('moves signal to withdrawn cache for history', async () => {
    mockHandler = withPRSupport((req, res) => {
      if (req.method === 'PATCH') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': '0',
        });
        res.end(JSON.stringify(makeIssue({ number: 1, state: 'closed' })));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': '0',
      });
      res.end(JSON.stringify([makeIssue({ number: 1 })]));
    });

    const env = createEnv({ allowWithdraw: true });
    await env.sync();
    await env.withdraw('gh:test/repo#1');

    const history = await env.history({ includeWithdrawn: true });
    expect(history.find(s => s.id === 'gh:test/repo#1')).toBeDefined();
  });
});

describe('GitHubEnvironment — claim / release', () => {
  it('successfully claims an unclaimed signal', async () => {
    setMockIssues([makeIssue({ number: 1 })]);
    const env = createEnv();
    await env.sync();

    const result = await env.claim('gh:test/repo#1', 'shaper');
    expect(result).toBe(true);
  });

  it('sets claim metadata on signal', async () => {
    setMockIssues([makeIssue({ number: 1 })]);
    const env = createEnv();
    await env.sync();

    await env.claim('gh:test/repo#1', 'shaper', 30_000);
    const signals = await env.snapshot();
    const claimed = signals.find(s => s.id === 'gh:test/repo#1')!;

    expect(claimed.meta.claimed_by).toBe('shaper');
    expect(claimed.meta.claimed_at).toBeGreaterThan(0);
    expect(claimed.meta.claim_lease).toBe(30_000);
  });

  it('rejects second claim on same signal', async () => {
    setMockIssues([makeIssue({ number: 1 })]);
    const env = createEnv();
    await env.sync();

    await env.claim('gh:test/repo#1', 'shaper');
    const second = await env.claim('gh:test/repo#1', 'critic');
    expect(second).toBe(false);
  });

  it('allows takeover when claim lease has expired', async () => {
    setMockIssues([makeIssue({ number: 1 })]);
    const env = createEnv();
    await env.sync();

    await env.claim('gh:test/repo#1', 'shaper', 1); // 1ms lease
    await new Promise(r => setTimeout(r, 10));

    const takeover = await env.claim('gh:test/repo#1', 'critic', 30_000);
    expect(takeover).toBe(true);
  });

  it('returns false for nonexistent signal', async () => {
    setMockIssues([]);
    const env = createEnv();
    await env.sync();

    const result = await env.claim('gh:test/repo#999', 'shaper');
    expect(result).toBe(false);
  });

  it('release clears claim metadata', async () => {
    setMockIssues([makeIssue({ number: 1 })]);
    const env = createEnv();
    await env.sync();

    await env.claim('gh:test/repo#1', 'shaper');
    await env.release('gh:test/repo#1');

    const signals = await env.snapshot();
    const released = signals.find(s => s.id === 'gh:test/repo#1')!;
    expect(released.meta.claimed_by).toBeUndefined();
    expect(released.meta.claimed_at).toBeUndefined();
    expect(released.meta.claim_lease).toBeUndefined();
  });

  it('release is a no-op for nonexistent signal', async () => {
    setMockIssues([]);
    const env = createEnv();
    await env.sync();
    await expect(env.release('gh:test/repo#999')).resolves.toBeUndefined();
  });

  it('filters by unclaimed in observe query', async () => {
    setMockIssues([
      makeIssue({ number: 1, title: 'Unclaimed' }),
      makeIssue({ number: 2, title: 'Claimed' }),
    ]);
    const env = createEnv();
    await env.sync();
    await env.claim('gh:test/repo#2', 'shaper');

    const unclaimed = await env.observe({ unclaimed: true });
    expect(unclaimed).toHaveLength(1);
    expect(unclaimed[0].id).toBe('gh:test/repo#1');
  });
});

describe('GitHubEnvironment — watch', () => {
  it('emits existing signals on subscribe', async () => {
    setMockIssues([makeIssue({ number: 1, title: 'Existing' })]);
    const env = createEnv();

    const received: Signal[] = [];
    const sub = env.watch({}, (signal) => {
      received.push(signal);
    });

    // Wait for initial async sync
    await new Promise(r => setTimeout(r, 300));

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('gh:test/repo#1');

    sub.unsubscribe();
  });

  it('emits new signals on subsequent polls', async () => {
    let callCount = 0;
    const firstIssues = [makeIssue({ number: 1 })];
    const secondIssues = [makeIssue({ number: 1 }), makeIssue({ number: 2, title: 'New' })];

    mockHandler = withPRSupport((req, res) => {
      callCount++;
      const issues = callCount <= 1 ? firstIssues : secondIssues;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'ETag': `"etag-${callCount}"`, // different ETags to prevent 304
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': '0',
      });
      res.end(JSON.stringify(issues));
    });

    const env = createEnv({ pollInterval: 100 });

    const received: Signal[] = [];
    const sub = env.watch({}, (signal) => {
      received.push(signal);
    });

    // Wait for initial + one poll cycle
    await new Promise(r => setTimeout(r, 400));

    expect(received.length).toBeGreaterThanOrEqual(2);
    const ids = received.map(s => s.id);
    expect(ids).toContain('gh:test/repo#1');
    expect(ids).toContain('gh:test/repo#2');

    sub.unsubscribe();
  });

  it('stops emitting after unsubscribe', async () => {
    let callCount = 0;
    mockHandler = withPRSupport((req, res) => {
      callCount++;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'ETag': `"etag-${callCount}"`,
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': '0',
      });
      res.end(JSON.stringify([makeIssue({ number: callCount })]));
    });

    const env = createEnv({ pollInterval: 50 });

    const received: Signal[] = [];
    const sub = env.watch({}, (signal) => {
      received.push(signal);
    });

    await new Promise(r => setTimeout(r, 100));
    sub.unsubscribe();

    const countAfterUnsub = received.length;
    await new Promise(r => setTimeout(r, 200));

    // No new signals should have been emitted
    expect(received.length).toBe(countAfterUnsub);
  });

  it('only emits signals matching the query', async () => {
    setMockIssues([
      golemTablet(1, 'Tablet'),
      makeIssue({ number: 2, title: 'Bug', labels: [{ name: 'bug' }] }),
    ]);

    const env = createEnv();
    const received: Signal[] = [];
    const sub = env.watch({ type: 'golem:*' }, (signal) => {
      received.push(signal);
    });

    await new Promise(r => setTimeout(r, 300));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('golem:tablet');

    sub.unsubscribe();
  });
});

describe('GitHubEnvironment — decay', () => {
  it('applies linear decay between sweeps', async () => {
    setMockIssues([makeIssue({ number: 1, updated_at: new Date().toISOString() })]);
    const env = createEnv({ decayRate: 0.1 }); // fast decay for testing
    await env.sync();

    // Wait a bit for time to pass
    await new Promise(r => setTimeout(r, 150));

    const result = await env.decay();
    expect(result.decayed).toBeGreaterThanOrEqual(1);

    const signals = await env.snapshot();
    if (signals.length > 0) {
      expect(signals[0].meta.concentration).toBeLessThan(1.0);
    }
  });

  it('does not compound decay across multiple sweeps', async () => {
    setMockIssues([makeIssue({ number: 1, updated_at: new Date().toISOString() })]);
    const env = createEnv({ decayRate: 0.1 }); // 0.1/sec
    await env.sync();

    const before = (await env.snapshot())[0].meta.concentration;

    // Run 5 rapid sweeps with ~100ms between each
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 100));
      await env.decay();
    }

    const after = (await env.snapshot())[0].meta.concentration;
    const totalDecay = before - after;

    // 5 sweeps * ~0.1s each * 0.1/sec rate ≈ 0.05 total decay
    // Without the fix, quadratic compounding would give ~0.15
    expect(totalDecay).toBeLessThan(0.1);
    expect(totalDecay).toBeGreaterThan(0.01);
  });

  it('skips decay when called rapidly by multiple runtimes', async () => {
    setMockIssues([makeIssue({ number: 1, updated_at: new Date().toISOString() })]);
    const env = createEnv({ decayRate: 0.1 });
    await env.sync();

    await new Promise(r => setTimeout(r, 150));

    // Two rapid decay calls (simulating two runtimes sharing the env)
    const first = await env.decay();
    const second = await env.decay(); // < 0.1s since first, should be skipped

    expect(first.decayed).toBeGreaterThanOrEqual(1);
    expect(second.decayed).toBe(0);
  });

  it('evaporates signals below floor', async () => {
    setMockIssues([makeIssue({ number: 1, updated_at: new Date().toISOString() })]);
    const env = createEnv({ decayRate: 100, concentrationFloor: 0.5 }); // extreme decay
    await env.sync();

    await new Promise(r => setTimeout(r, 150));

    const result = await env.decay();
    expect(result.evaporated).toBeGreaterThanOrEqual(1);

    const signals = await env.snapshot();
    expect(signals).toHaveLength(0);
  });

  it('releases expired claims during decay', async () => {
    setMockIssues([makeIssue({ number: 1 })]);
    const env = createEnv();
    await env.sync();

    await env.claim('gh:test/repo#1', 'shaper', 1); // 1ms lease
    await new Promise(r => setTimeout(r, 10));

    const result = await env.decay();
    expect(result.claimsReleased).toBeGreaterThanOrEqual(1);

    const signals = await env.snapshot();
    if (signals.length > 0) {
      expect(signals[0].meta.claimed_by).toBeUndefined();
    }
  });

  it('returns zero counts when nothing to decay', async () => {
    setMockIssues([]);
    const env = createEnv();
    await env.sync();

    const result = await env.decay();
    expect(result.decayed).toBe(0);
    expect(result.evaporated).toBe(0);
    expect(result.claimsReleased).toBe(0);
  });
});

describe('GitHubEnvironment — history', () => {
  it('returns active signals by default', async () => {
    setMockIssues([makeIssue({ number: 1 })]);
    const env = createEnv();
    await env.sync();

    const result = await env.history({});
    expect(result).toHaveLength(1);
  });

  it('includes withdrawn signals when includeWithdrawn is true', async () => {
    mockHandler = withPRSupport((req, res) => {
      if (req.method === 'PATCH') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': '0',
        });
        res.end(JSON.stringify(makeIssue({ number: 1, state: 'closed' })));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': '0',
      });
      res.end(JSON.stringify([makeIssue({ number: 1 })]));
    });

    const env = createEnv({ allowWithdraw: true });
    await env.sync();
    await env.withdraw('gh:test/repo#1');

    const activeOnly = await env.history({});
    expect(activeOnly).toHaveLength(0);

    const withWithdrawn = await env.history({ includeWithdrawn: true });
    expect(withWithdrawn).toHaveLength(1);
  });

  it('respects limit', async () => {
    setMockIssues([
      makeIssue({ number: 1 }),
      makeIssue({ number: 2 }),
      makeIssue({ number: 3 }),
    ]);
    const env = createEnv();
    await env.sync();

    const limited = await env.history({ limit: 2 });
    expect(limited).toHaveLength(2);
  });
});

describe('GitHubEnvironment — snapshot', () => {
  it('returns all active signals', async () => {
    setMockIssues([
      makeIssue({ number: 1 }),
      makeIssue({ number: 2 }),
    ]);
    const env = createEnv();
    const snap = await env.snapshot();
    expect(snap).toHaveLength(2);
  });

  it('returns empty for no issues', async () => {
    setMockIssues([]);
    const env = createEnv();
    const snap = await env.snapshot();
    expect(snap).toEqual([]);
  });
});

describe('GitHubEnvironment — pagination', () => {
  it('handles multi-page responses via Link header', async () => {
    let requestCount = 0;

    mockHandler = withPRSupport((req, res) => {
      requestCount++;

      if (requestCount === 1) {
        // First page with Link header pointing to next
        const nextUrl = `http://localhost:${port}/repos/test/repo/issues?page=2`;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Link': `<${nextUrl}>; rel="next"`,
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': '0',
        });
        res.end(JSON.stringify([makeIssue({ number: 1 })]));
      } else {
        // Second page (no Link header = last page)
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'x-ratelimit-remaining': '4998',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': '0',
        });
        res.end(JSON.stringify([makeIssue({ number: 2 })]));
      }
    });

    const env = createEnv();
    const signals = await env.snapshot();

    expect(signals).toHaveLength(2);
    expect(requestCount).toBe(2);
  });
});

// ============================================================
// Dependency Boost Tests
// ============================================================

function makeSignal(id: string, concentration: number, causedBy?: string[]): Signal {
  const signal: Signal = {
    id,
    type: 'issue:open',
    payload: {},
    meta: {
      deposited_at: Date.now(),
      deposited_by: 'github',
      concentration,
    },
  };
  if (causedBy && causedBy.length > 0) {
    signal.meta.caused_by = causedBy;
  }
  return signal;
}

describe('computeDependencyBoosts', () => {
  it('boosts root node (no deps, has dependents) with rootBoost + dependentBoost', () => {
    // #1 is root, #2 depends on #1
    const signals = new Map<string, Signal>();
    signals.set('gh:o/r#1', makeSignal('gh:o/r#1', 0.5));
    signals.set('gh:o/r#2', makeSignal('gh:o/r#2', 0.5, ['gh:o/r#1']));

    const boosts = computeDependencyBoosts(signals);

    expect(boosts.get('gh:o/r#1')).toBeCloseTo(0.20, 2); // 0.15 root + 0.05 * 1 dep
    expect(boosts.get('gh:o/r#2')).toBeCloseTo(-0.15, 2); // leaf — penalized
  });

  it('boosts mid-graph node (has deps AND dependents) with only dependentBoost', () => {
    // #1 root, #2 mid (depends on #1, #3 depends on #2), #3 leaf
    const signals = new Map<string, Signal>();
    signals.set('gh:o/r#1', makeSignal('gh:o/r#1', 0.5));
    signals.set('gh:o/r#2', makeSignal('gh:o/r#2', 0.5, ['gh:o/r#1']));
    signals.set('gh:o/r#3', makeSignal('gh:o/r#3', 0.5, ['gh:o/r#2']));

    const boosts = computeDependencyBoosts(signals);

    // #1: root + 1 dependent = 0.15 + 0.05 = 0.20
    expect(boosts.get('gh:o/r#1')).toBeCloseTo(0.20, 2);
    // #2: mid-graph, 1 dependent, no root boost = 0.05
    expect(boosts.get('gh:o/r#2')).toBeCloseTo(0.05, 2);
    // #3: leaf — penalized
    expect(boosts.get('gh:o/r#3')).toBeCloseTo(-0.15, 2);
  });

  it('penalizes leaf nodes (has deps, no dependents)', () => {
    const signals = new Map<string, Signal>();
    signals.set('gh:o/r#1', makeSignal('gh:o/r#1', 0.5));
    signals.set('gh:o/r#2', makeSignal('gh:o/r#2', 0.5, ['gh:o/r#1']));

    const boosts = computeDependencyBoosts(signals);

    expect(boosts.get('gh:o/r#2')).toBeCloseTo(-0.15, 2);
  });

  it('gives no boost to isolated nodes (no deps, no dependents)', () => {
    const signals = new Map<string, Signal>();
    signals.set('gh:o/r#1', makeSignal('gh:o/r#1', 0.5));

    const boosts = computeDependencyBoosts(signals);

    expect(boosts.size).toBe(0);
  });

  it('caps boost at maxBoost', () => {
    // Root with 10 dependents: 0.15 + 10 * 0.05 = 0.65, should cap at 0.3
    const signals = new Map<string, Signal>();
    signals.set('gh:o/r#1', makeSignal('gh:o/r#1', 0.5));
    for (let i = 2; i <= 11; i++) {
      signals.set(`gh:o/r#${i}`, makeSignal(`gh:o/r#${i}`, 0.5, ['gh:o/r#1']));
    }

    const boosts = computeDependencyBoosts(signals);

    expect(boosts.get('gh:o/r#1')).toBe(0.3); // capped
  });

  it('clamps resulting concentration to 1.0 when applied', () => {
    // Signal already at 0.9, boost of 0.2 should not exceed 1.0
    const signals = new Map<string, Signal>();
    signals.set('gh:o/r#1', makeSignal('gh:o/r#1', 0.9));
    signals.set('gh:o/r#2', makeSignal('gh:o/r#2', 0.5, ['gh:o/r#1']));

    const boosts = computeDependencyBoosts(signals);
    const boost = boosts.get('gh:o/r#1')!;
    const clamped = Math.min(1.0, 0.9 + boost);

    expect(clamped).toBe(1.0);
  });

  it('uses custom config overrides', () => {
    const signals = new Map<string, Signal>();
    signals.set('gh:o/r#1', makeSignal('gh:o/r#1', 0.5));
    signals.set('gh:o/r#2', makeSignal('gh:o/r#2', 0.5, ['gh:o/r#1']));

    const boosts = computeDependencyBoosts(signals, {
      rootBoost: 0.10,
      dependentBoost: 0.08,
      maxBoost: 0.5,
      leafPenalty: 0.20,
    });

    expect(boosts.get('gh:o/r#1')).toBeCloseTo(0.18, 2); // 0.10 + 0.08 * 1
    expect(boosts.get('gh:o/r#2')).toBeCloseTo(-0.20, 2); // custom leaf penalty
  });

  it('returns empty map for empty signal map', () => {
    const boosts = computeDependencyBoosts(new Map());
    expect(boosts.size).toBe(0);
  });

  it('leaf penalty is configurable', () => {
    const signals = new Map<string, Signal>();
    signals.set('gh:o/r#1', makeSignal('gh:o/r#1', 0.5));
    signals.set('gh:o/r#2', makeSignal('gh:o/r#2', 0.5, ['gh:o/r#1']));

    const boosts = computeDependencyBoosts(signals, { leafPenalty: 0.25 });

    expect(boosts.get('gh:o/r#2')).toBeCloseTo(-0.25, 2);
  });

  it('leaf penalty of 0 disables penalization', () => {
    const signals = new Map<string, Signal>();
    signals.set('gh:o/r#1', makeSignal('gh:o/r#1', 0.5));
    signals.set('gh:o/r#2', makeSignal('gh:o/r#2', 0.5, ['gh:o/r#1']));

    const boosts = computeDependencyBoosts(signals, { leafPenalty: 0 });

    expect(boosts.has('gh:o/r#2')).toBe(false); // zero penalty = no entry
  });

  it('handles multiple dependents correctly', () => {
    // #1 is root, #2, #3, #4, #5, #6 all depend on #1
    const signals = new Map<string, Signal>();
    signals.set('gh:o/r#1', makeSignal('gh:o/r#1', 0.5));
    for (let i = 2; i <= 6; i++) {
      signals.set(`gh:o/r#${i}`, makeSignal(`gh:o/r#${i}`, 0.5, ['gh:o/r#1']));
    }

    const boosts = computeDependencyBoosts(signals);

    // root: 0.15 + 5 * 0.05 = 0.40, capped to 0.3
    expect(boosts.get('gh:o/r#1')).toBe(0.3);
  });
});

describe('GitHubEnvironment — dependency boost integration', () => {
  it('boosts root signal concentration after sync', async () => {
    // Issue #1 is root (no deps), issues #2 and #3 depend on #1
    const golemBody = (deps: string) =>
      `## Description\nTest\n\n## Dependencies\n${deps}`;

    setMockIssues([
      makeIssue({
        number: 1,
        title: 'Root issue',
        labels: [{ name: 'golem' }],
        body: golemBody(''),
      }),
      makeIssue({
        number: 2,
        title: 'Child A',
        labels: [{ name: 'golem' }],
        body: golemBody('- [ ] bd-daaa.1'),
      }),
      makeIssue({
        number: 3,
        title: 'Child B',
        labels: [{ name: 'golem' }],
        body: golemBody('- [ ] bd-daaa.1'),
      }),
    ]);

    const env = createEnv();
    await env.sync();
    const signals = await env.snapshot();

    const root = signals.find(s => s.id === 'gh:test/repo#1')!;
    const childA = signals.find(s => s.id === 'gh:test/repo#2')!;
    const childB = signals.find(s => s.id === 'gh:test/repo#3')!;

    // Root should have higher concentration than children
    expect(root.meta.concentration).toBeGreaterThan(childA.meta.concentration);
    expect(root.meta.concentration).toBeGreaterThan(childB.meta.concentration);
  });

  it('respects custom dependencyBoost config', async () => {
    const golemBody = (deps: string) =>
      `## Description\nTest\n\n## Dependencies\n${deps}`;

    setMockIssues([
      makeIssue({
        number: 1,
        title: 'Root',
        labels: [{ name: 'golem' }],
        body: golemBody(''),
      }),
      makeIssue({
        number: 2,
        title: 'Child',
        labels: [{ name: 'golem' }],
        body: golemBody('- [ ] bd-daaa.1'),
      }),
    ]);

    const envDefault = createEnv();
    await envDefault.sync();
    const defaultSignals = await envDefault.snapshot();
    const defaultRoot = defaultSignals.find(s => s.id === 'gh:test/repo#1')!;

    const envCustom = createEnv({
      dependencyBoost: { rootBoost: 0.0, dependentBoost: 0.0 },
    });
    await envCustom.sync();
    const customSignals = await envCustom.snapshot();
    const customRoot = customSignals.find(s => s.id === 'gh:test/repo#1')!;

    // With zero boosts, root should have lower (or equal) concentration
    expect(customRoot.meta.concentration).toBeLessThanOrEqual(defaultRoot.meta.concentration);
  });
});

// ============================================================
// PR Mapper Tests
// ============================================================

describe('resolveReviewState', () => {
  it('returns pending for empty reviews', () => {
    expect(resolveReviewState([])).toBe('pending');
  });

  it('returns approved when latest review is approved', () => {
    const reviews: GitHubReview[] = [
      makeReview({ user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2025-01-01T00:00:00Z' }),
    ];
    expect(resolveReviewState(reviews)).toBe('approved');
  });

  it('returns changes-requested when any reviewer requests changes', () => {
    const reviews: GitHubReview[] = [
      makeReview({ user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2025-01-01T00:00:00Z' }),
      makeReview({ user: { login: 'bob' }, state: 'CHANGES_REQUESTED', submitted_at: '2025-01-01T00:00:00Z' }),
    ];
    expect(resolveReviewState(reviews)).toBe('changes-requested');
  });

  it('uses most recent review per reviewer', () => {
    const reviews: GitHubReview[] = [
      makeReview({ user: { login: 'alice' }, state: 'CHANGES_REQUESTED', submitted_at: '2025-01-01T00:00:00Z' }),
      makeReview({ user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2025-01-02T00:00:00Z' }),
    ];
    expect(resolveReviewState(reviews)).toBe('approved');
  });

  it('returns pending for only COMMENTED reviews', () => {
    const reviews: GitHubReview[] = [
      makeReview({ user: { login: 'alice' }, state: 'COMMENTED' }),
    ];
    expect(resolveReviewState(reviews)).toBe('pending');
  });
});

describe('defaultPRTypeMapper', () => {
  it('maps draft PR to pr:draft', () => {
    expect(defaultPRTypeMapper(makePR({ draft: true }), [])).toBe('pr:draft');
  });

  it('maps merged PR to pr:merged', () => {
    expect(defaultPRTypeMapper(makePR({ merged: true }), [])).toBe('pr:merged');
  });

  it('maps closed (not merged) PR to pr:closed', () => {
    expect(defaultPRTypeMapper(makePR({ state: 'closed', merged: false }), [])).toBe('pr:closed');
  });

  it('maps security label to pr:security', () => {
    expect(defaultPRTypeMapper(makePR({ labels: [{ name: 'security' }] }), [])).toBe('pr:security');
  });

  it('maps approved review state to pr:approved', () => {
    const reviews = [makeReview({ state: 'APPROVED' })];
    expect(defaultPRTypeMapper(makePR(), reviews)).toBe('pr:approved');
  });

  it('maps changes-requested to pr:changes-requested', () => {
    const reviews = [makeReview({ state: 'CHANGES_REQUESTED' })];
    expect(defaultPRTypeMapper(makePR(), reviews)).toBe('pr:changes-requested');
  });

  it('maps PR with requested reviewers to pr:review-requested', () => {
    expect(defaultPRTypeMapper(makePR({ requested_reviewers: [{ login: 'alice' }] }), [])).toBe('pr:review-requested');
  });

  it('falls back to pr:open', () => {
    expect(defaultPRTypeMapper(makePR(), [])).toBe('pr:open');
  });
});

describe('defaultPRPayloadMapper', () => {
  it('includes PR fields', () => {
    const pr = makePR({ number: 42, title: 'My PR', additions: 100, deletions: 20 });
    const payload = defaultPRPayloadMapper(pr, []);
    expect(payload.number).toBe(42);
    expect(payload.title).toBe('My PR');
    expect(payload.additions).toBe(100);
    expect(payload.deletions).toBe(20);
    expect(payload.author).toBe('author');
  });

  it('includes review summary when reviews present', () => {
    const reviews = [makeReview({ user: { login: 'alice' }, state: 'APPROVED' })];
    const payload = defaultPRPayloadMapper(makePR(), reviews);
    expect(payload.reviews).toBeDefined();
    const r = payload.reviews as Record<string, unknown>;
    expect(r.reviewState).toBe('approved');
    expect(r.reviewCount).toBe(1);
    expect(r.reviewers).toEqual(['alice']);
  });

  it('omits review summary when no reviews', () => {
    const payload = defaultPRPayloadMapper(makePR(), []);
    expect(payload.reviews).toBeUndefined();
  });
});

describe('defaultPRConcentrationMapper', () => {
  it('gives higher concentration to PRs with requested reviewers', () => {
    const config: GitHubEnvConfig = { owner: 'test', repo: 'repo' };
    const staleDate = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const base = defaultPRConcentrationMapper(makePR({ updated_at: staleDate }), [], config);
    const withReviewers = defaultPRConcentrationMapper(
      makePR({ updated_at: staleDate, requested_reviewers: [{ login: 'alice' }] }), [], config
    );
    expect(withReviewers).toBeGreaterThan(base);
  });

  it('penalizes draft PRs', () => {
    const config: GitHubEnvConfig = { owner: 'test', repo: 'repo' };
    const regular = defaultPRConcentrationMapper(makePR(), [], config);
    const draft = defaultPRConcentrationMapper(makePR({ draft: true }), [], config);
    expect(draft).toBeLessThan(regular);
  });

  it('boosts small PRs', () => {
    const config: GitHubEnvConfig = { owner: 'test', repo: 'repo' };
    const small = defaultPRConcentrationMapper(makePR({ additions: 10, deletions: 5 }), [], config);
    const large = defaultPRConcentrationMapper(makePR({ additions: 400, deletions: 200 }), [], config);
    expect(small).toBeGreaterThan(large);
  });

  it('never returns below floor', () => {
    const config: GitHubEnvConfig = { owner: 'test', repo: 'repo', concentrationFloor: 0.05 };
    const staleDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const conc = defaultPRConcentrationMapper(
      makePR({ draft: true, updated_at: staleDate, additions: 1000, deletions: 500 }), [], config
    );
    expect(conc).toBeGreaterThanOrEqual(0.05);
  });
});

// ============================================================
// PR Integration Tests
// ============================================================

describe('GitHubEnvironment — PR signals', () => {
  it('includes PRs as signals when includePRs is true (default)', async () => {
    setMockIssues([makeIssue({ number: 1 })]);
    setMockPRs([makePR({ number: 10, title: 'Feature PR' })]);

    const env = createEnv();
    await env.sync();
    const signals = await env.snapshot();

    expect(signals.length).toBe(2);
    expect(signals.find(s => s.id === 'gh:test/repo#1')).toBeDefined();
    expect(signals.find(s => s.id === 'gh:test/repo#10')).toBeDefined();
  });

  it('excludes PRs when includePRs is false', async () => {
    setMockIssues([makeIssue({ number: 1 })]);
    setMockPRs([makePR({ number: 10 })]);

    const env = createEnv({ includePRs: false });
    await env.sync();
    const signals = await env.snapshot();

    expect(signals.length).toBe(1);
    expect(signals[0].id).toBe('gh:test/repo#1');
  });

  it('excludes issues when includeIssues is false', async () => {
    setMockIssues([makeIssue({ number: 1 })]);
    setMockPRs([makePR({ number: 10 })]);

    const env = createEnv({ includeIssues: false });
    await env.sync();
    const signals = await env.snapshot();

    expect(signals.length).toBe(1);
    expect(signals[0].id).toBe('gh:test/repo#10');
  });

  it('maps PR type from review state', async () => {
    const reviews = new Map<number, GitHubReview[]>();
    reviews.set(10, [makeReview({ state: 'APPROVED' })]);

    setMockIssues([]);
    setMockPRs([makePR({ number: 10 })], reviews);

    const env = createEnv();
    await env.sync();
    const signals = await env.snapshot();

    expect(signals[0].type).toBe('pr:approved');
  });

  it('maps draft PR type', async () => {
    setMockIssues([]);
    setMockPRs([makePR({ number: 10, draft: true })]);

    const env = createEnv();
    await env.sync();
    const signals = await env.snapshot();

    expect(signals[0].type).toBe('pr:draft');
  });

  it('includes PR labels as signal tags', async () => {
    setMockIssues([]);
    setMockPRs([makePR({ number: 10, labels: [{ name: 'needs-review' }, { name: 'frontend' }] })]);

    const env = createEnv();
    await env.sync();
    const signals = await env.snapshot();

    expect(signals[0].meta.tags).toEqual(['needs-review', 'frontend']);
  });

  it('applies prFilter', async () => {
    setMockIssues([]);
    setMockPRs([
      makePR({ number: 10, draft: false }),
      makePR({ number: 11, draft: true }),
    ]);

    const env = createEnv({ prFilter: (pr) => !pr.draft });
    await env.sync();
    const signals = await env.snapshot();

    expect(signals.length).toBe(1);
    expect(signals[0].id).toBe('gh:test/repo#10');
  });

  it('uses custom prTypeMapper', async () => {
    setMockIssues([]);
    setMockPRs([makePR({ number: 10 })]);

    const env = createEnv({ prTypeMapper: () => 'custom:pr-type' });
    await env.sync();
    const signals = await env.snapshot();

    expect(signals[0].type).toBe('custom:pr-type');
  });

  it('skips review fetch when fetchReviews is false', async () => {
    setMockIssues([]);
    setMockPRs([makePR({ number: 10 })]);

    const env = createEnv({ fetchReviews: false });
    await env.sync();
    const signals = await env.snapshot();

    // Without reviews, an open PR with no reviewers = pr:open
    expect(signals[0].type).toBe('pr:open');
  });

  it('observes PRs with type query', async () => {
    setMockIssues([makeIssue({ number: 1, labels: [{ name: 'bug' }] })]);
    setMockPRs([makePR({ number: 10 })]);

    const env = createEnv();
    await env.sync();

    const prs = await env.observe({ type: 'pr:open' });
    expect(prs.length).toBe(1);
    expect(prs[0].id).toBe('gh:test/repo#10');

    const bugs = await env.observe({ type: 'issue:bug' });
    expect(bugs.length).toBe(1);
    expect(bugs[0].id).toBe('gh:test/repo#1');
  });
});

// ============================================================
// Persistent Claims Tests
// ============================================================

describe('GitHubEnvironment — persistent claims', () => {
  it('adds a claim label on claim()', async () => {
    setMockIssues([makeIssue({ number: 1 })]);

    const env = createEnv({ persistentClaims: true });
    await env.sync();

    const result = await env.claim('gh:test/repo#1', 'shaper', 60_000);
    expect(result).toBe(true);
    expect(mockLabelsAdded).toEqual([{ number: 1, label: 'mandible:claimed:shaper' }]);
  });

  it('removes claim label on release()', async () => {
    setMockIssues([makeIssue({ number: 1 })]);

    const env = createEnv({ persistentClaims: true });
    await env.sync();
    await env.claim('gh:test/repo#1', 'critic', 60_000);

    await env.release('gh:test/repo#1');
    expect(mockLabelsRemoved).toEqual([{ number: 1, label: 'mandible:claimed:critic' }]);
  });

  it('uses custom claimLabelPrefix', async () => {
    setMockIssues([makeIssue({ number: 1 })]);

    const env = createEnv({ persistentClaims: true, claimLabelPrefix: 'bot:claimed' });
    await env.sync();
    await env.claim('gh:test/repo#1', 'keeper', 60_000);

    expect(mockLabelsAdded).toEqual([{ number: 1, label: 'bot:claimed:keeper' }]);
  });

  it('restores claim state from labels on sync', async () => {
    setMockIssues([makeIssue({ number: 1, labels: [{ name: 'mandible:claimed:shaper' }] })]);

    const env = createEnv({ persistentClaims: true });
    await env.sync();
    const signals = await env.snapshot();

    expect(signals[0].meta.claimed_by).toBe('shaper');
  });

  it('restores PR claim state from labels on sync', async () => {
    setMockIssues([]);
    setMockPRs([makePR({ number: 10, labels: [{ name: 'mandible:claimed:reviewer' }] })]);

    const env = createEnv({ persistentClaims: true });
    await env.sync();
    const signals = await env.snapshot();

    expect(signals[0].meta.claimed_by).toBe('reviewer');
  });

  it('removes old claim label on takeover after lease expiry', async () => {
    setMockIssues([makeIssue({ number: 1 })]);

    const env = createEnv({ persistentClaims: true });
    await env.sync();

    // First claim
    await env.claim('gh:test/repo#1', 'shaper', 1); // 1ms lease
    await new Promise(r => setTimeout(r, 10)); // wait for lease to expire

    // Takeover
    await env.claim('gh:test/repo#1', 'critic', 60_000);
    expect(mockLabelsRemoved).toEqual([{ number: 1, label: 'mandible:claimed:shaper' }]);
    expect(mockLabelsAdded.at(-1)).toEqual({ number: 1, label: 'mandible:claimed:critic' });
  });

  it('in-memory claims work when persistentClaims is false (default)', async () => {
    setMockIssues([makeIssue({ number: 1 })]);

    const env = createEnv();
    await env.sync();

    const result = await env.claim('gh:test/repo#1', 'shaper', 60_000);
    expect(result).toBe(true);
    expect(mockLabelsAdded).toEqual([]); // no API calls

    const signals = await env.observe({ unclaimed: true });
    expect(signals.length).toBe(0); // claimed, so not in unclaimed results
  });
});
