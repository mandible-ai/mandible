// PURPOSE: Tests for the reviewing capability — reading a pull request's diff,
// reading the reviews already on it, and leaving one.
// PURPOSE: Runs against a mock GitHub API so the request shape is asserted,
// not just the return value.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { GitHubEnvironment } from '../../src/environments/github/adapter.js';
import { isCodeReviewable } from '../../src/environments/github/review.js';
import type { GitHubIssue, GitHubPullRequest, GitHubReview } from '../../src/environments/github/types.js';

let server: Server;
let port: number;
let handler: (req: IncomingMessage, res: ServerResponse) => void;

/** Every request the mock server saw, so the test can assert the call shape. */
let seen: Array<{ method: string; url: string; accept: string; body: string }>;

beforeAll(async () => {
  await new Promise<void>(resolve => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c as Buffer));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          accept: String(req.headers.accept ?? ''),
          body: Buffer.concat(chunks).toString(),
        });
        handler(req, res);
      });
    });
    server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function pullRequest(number: number): GitHubPullRequest {
  return {
    number,
    title: `PR ${number}`,
    body: '',
    state: 'open',
    draft: false,
    merged: false,
    user: { login: 'someone' },
    labels: [],
    html_url: `https://github.com/o/r/pull/${number}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    head: { ref: 'topic', sha: 'headsha' },
    base: { ref: 'main', sha: 'basesha' },
    commits: 1,
    additions: 1,
    deletions: 0,
    changed_files: 1,
    requested_reviewers: [],
  } as unknown as GitHubPullRequest;
}

function issue(number: number): GitHubIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: '',
    state: 'open',
    user: { login: 'someone' },
    labels: [],
    html_url: `https://github.com/o/r/issues/${number}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    comments: 0,
  } as unknown as GitHubIssue;
}

const DIFF = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n';

function env(overrides: Record<string, unknown> = {}) {
  return new GitHubEnvironment({
    owner: 'o',
    repo: 'r',
    token: 'test-token',
    apiBase: `http://localhost:${port}`,
    includeIssues: true,
    includePRs: true,
    fetchReviews: false,
    ...overrides,
  });
}

/** Answers the polling endpoints so sync() populates the signal map. */
function serveFixtures(opts: { prs?: GitHubPullRequest[]; issues?: GitHubIssue[]; reviews?: GitHubReview[] } = {}) {
  handler = (req, res) => {
    const url = req.url ?? '';
    if (url.includes('/pulls/') && url.includes('/reviews') && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1 }));
      return;
    }
    if (url.includes('/pulls/') && url.includes('/reviews')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(opts.reviews ?? []));
      return;
    }
    if (String(req.headers.accept).includes('diff')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(DIFF);
      return;
    }
    if (url.startsWith('/repos/o/r/pulls')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(opts.prs ?? []));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(opts.issues ?? []));
  };
}

beforeEach(() => {
  seen = [];
  serveFixtures();
});

describe('reviewing capability', () => {
  it('is what a GitHub environment offers and a bare object does not', () => {
    expect(isCodeReviewable(env())).toBe(true);
    expect(isCodeReviewable({ fetchDiff: () => {} })).toBe(false);
    expect(isCodeReviewable(null)).toBe(false);
  });

  it('asks GitHub for the diff, by asking for the pull request differently', async () => {
    serveFixtures({ prs: [pullRequest(12)] });
    const github = env();
    await github.sync();

    const diff = await github.fetchDiff('gh:o/r#12');

    expect(diff).toBe(DIFF);
    const request = seen.find(r => r.accept.includes('diff'));
    expect(request?.url).toBe('/repos/o/r/pulls/12');
    expect(request?.method).toBe('GET');
  });

  it('reports each review with the revision it was written against', async () => {
    serveFixtures({
      prs: [pullRequest(12)],
      reviews: [
        { id: 1, user: { login: 'ana' }, state: 'APPROVED', body: 'ok', submitted_at: 't1', commit_id: 'sha1' },
        { id: 2, user: { login: 'bo' }, state: 'CHANGES_REQUESTED', body: 'no', submitted_at: 't2', commit_id: 'sha2' },
        { id: 3, user: { login: 'cy' }, state: 'COMMENTED', body: 'hm', submitted_at: 't3', commit_id: 'sha2' },
        // Dismissed has no neutral equivalent; calling it a comment would
        // misreport what a human decided.
        { id: 4, user: { login: 'di' }, state: 'DISMISSED', body: '', submitted_at: 't4' },
      ] as GitHubReview[],
    });
    const github = env();
    await github.sync();

    const reviews = await github.listReviews('gh:o/r#12');

    expect(reviews.map(r => r.verdict)).toEqual(['approve', 'request-changes', 'comment', 'other']);
    expect(reviews[0]).toMatchObject({ author: 'ana', body: 'ok', revision: 'sha1' });
    // This is what lets a reviewer skip a commit it has already reviewed.
    expect(reviews[2].revision).toBe('sha2');
  });

  it('submits a review in GitHub vocabulary', async () => {
    serveFixtures({ prs: [pullRequest(12)] });
    const github = env();
    await github.sync();

    await github.submitReview('gh:o/r#12', { verdict: 'comment', body: 'looks fine' });

    const posted = seen.find(r => r.method === 'POST' && r.url.startsWith('/repos/o/r/pulls/12/reviews'));
    expect(posted).toBeDefined();
    expect(JSON.parse(posted!.body)).toEqual({ event: 'COMMENT', body: 'looks fine' });
  });

  it('maps every verdict onto the event GitHub understands', async () => {
    serveFixtures({ prs: [pullRequest(12)] });
    const github = env();
    await github.sync();

    for (const [verdict, event] of [
      ['approve', 'APPROVE'],
      ['request-changes', 'REQUEST_CHANGES'],
    ] as const) {
      seen = [];
      await github.submitReview('gh:o/r#12', { verdict, body: 'x' });
      const posted = seen.find(r => r.method === 'POST');
      expect(JSON.parse(posted!.body).event).toBe(event);
    }
  });

  it('can be run read-only', async () => {
    serveFixtures({ prs: [pullRequest(12)] });
    const github = env({ allowReview: false });
    await github.sync();

    await expect(github.submitReview('gh:o/r#12', { verdict: 'comment', body: 'x' })).rejects.toThrow(/disabled/);
    expect(seen.some(r => r.method === 'POST')).toBe(false);
  });

  it('refuses an empty review rather than posting one', async () => {
    serveFixtures({ prs: [pullRequest(12)] });
    const github = env();
    await github.sync();

    await expect(github.submitReview('gh:o/r#12', { verdict: 'comment', body: '   ' })).rejects.toThrow(/needs a body/);
    expect(seen.some(r => r.method === 'POST')).toBe(false);
  });

  it('refuses to review an issue', async () => {
    serveFixtures({ issues: [issue(5)], prs: [] });
    const github = env();
    await github.sync();

    await expect(github.fetchDiff('gh:o/r#5')).rejects.toThrow(/not a pull request/);
  });

  it('refuses a signal from somewhere else', async () => {
    const github = env();
    await expect(github.fetchDiff('fs:/tmp/thing')).rejects.toThrow(/not a signal from o\/r/);
  });
});

describe('withdraw is not a way to close pull requests', () => {
  it('is opt-in, as its own documentation says', async () => {
    serveFixtures({ issues: [issue(5)] });
    const github = env();
    await github.sync();

    // The guard used to be `=== false`, so an unset config closed issues. The
    // canonical colony loop ends in ctx.withdraw().
    await expect(github.withdraw('gh:o/r#5')).rejects.toThrow(/opt-in/);
    expect(seen.some(r => r.method === 'PATCH')).toBe(false);
  });

  it('closes an issue once opted in', async () => {
    serveFixtures({ issues: [issue(5)] });
    const github = env({ allowWithdraw: true });
    await github.sync();

    await github.withdraw('gh:o/r#5');

    expect(seen.some(r => r.method === 'PATCH' && r.url === '/repos/o/r/issues/5')).toBe(true);
  });

  it('still refuses a pull request, because GitHub would close it', async () => {
    serveFixtures({ prs: [pullRequest(12)] });
    const github = env({ allowWithdraw: true });
    await github.sync();

    await expect(github.withdraw('gh:o/r#12')).rejects.toThrow(/refusing to close pull request/);
    expect(seen.some(r => r.method === 'PATCH')).toBe(false);
  });
});
