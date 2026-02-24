// PURPOSE: Thin HTTP client for the GitHub Issues API
// PURPOSE: ETag caching, pagination via Link header, rate limit tracking

import type { GitHubIssue, GitHubPullRequest, GitHubReview, GitHubEnvConfig } from './types.js';

export interface RateLimitInfo {
  remaining: number;
  limit: number;
  reset: number; // epoch seconds
}

export interface FetchResult {
  issues: GitHubIssue[] | null; // null = 304 Not Modified
  etag: string | null;
  rateLimit: RateLimitInfo;
}

export class GitHubClient {
  private readonly baseUrl: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string | undefined;
  private readonly labels: string[];
  private _etag: string | null = null;
  private _rateLimit: RateLimitInfo = { remaining: 5000, limit: 5000, reset: 0 };

  constructor(config: GitHubEnvConfig) {
    this.baseUrl = (config.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    this.owner = config.owner;
    this.repo = config.repo;
    this.token = config.token ?? process.env.GITHUB_TOKEN;
    this.labels = config.labels ?? [];
  }

  get rateLimitInfo(): RateLimitInfo {
    return { ...this._rateLimit };
  }

  private headers(extraHeaders?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'mandible-stigmergy',
      ...extraHeaders,
    };
    if (this.token) {
      h['Authorization'] = `Bearer ${this.token}`;
    }
    return h;
  }

  private updateRateLimit(headers: Headers): void {
    const remaining = headers.get('x-ratelimit-remaining');
    const limit = headers.get('x-ratelimit-limit');
    const reset = headers.get('x-ratelimit-reset');

    if (remaining !== null) this._rateLimit.remaining = parseInt(remaining, 10);
    if (limit !== null) this._rateLimit.limit = parseInt(limit, 10);
    if (reset !== null) this._rateLimit.reset = parseInt(reset, 10);
  }

  /**
   * Parse the Link header to get the next page URL.
   * Format: <url>; rel="next", <url>; rel="last"
   */
  private parseNextLink(linkHeader: string | null): string | null {
    if (!linkHeader) return null;
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    return match ? match[1] : null;
  }

  /**
   * Fetch open issues from the repository.
   * Returns null if the server responds with 304 (no changes since last ETag).
   * Handles pagination automatically for repos with >100 issues.
   */
  async fetchIssues(): Promise<FetchResult> {
    const params = new URLSearchParams({
      state: 'open',
      per_page: '100',
      sort: 'updated',
      direction: 'desc',
    });

    if (this.labels.length > 0) {
      params.set('labels', this.labels.join(','));
    }

    const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/issues?${params}`;

    const extraHeaders: Record<string, string> = {};
    if (this._etag) {
      extraHeaders['If-None-Match'] = this._etag;
    }

    const response = await fetch(url, { headers: this.headers(extraHeaders) });
    this.updateRateLimit(response.headers);

    // 304 Not Modified — no changes
    if (response.status === 304) {
      return {
        issues: null,
        etag: this._etag,
        rateLimit: this.rateLimitInfo,
      };
    }

    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText} for ${url}`
      );
    }

    // Store ETag for next request
    const etag = response.headers.get('etag');
    if (etag) this._etag = etag;

    let issues: GitHubIssue[] = await response.json() as GitHubIssue[];

    // Handle pagination
    let nextUrl = this.parseNextLink(response.headers.get('link'));
    while (nextUrl) {
      const pageResponse = await fetch(nextUrl, { headers: this.headers() });
      this.updateRateLimit(pageResponse.headers);

      if (!pageResponse.ok) break;

      const pageIssues = await pageResponse.json() as GitHubIssue[];
      issues = issues.concat(pageIssues);
      nextUrl = this.parseNextLink(pageResponse.headers.get('link'));
    }

    return {
      issues,
      etag: this._etag,
      rateLimit: this.rateLimitInfo,
    };
  }

  /**
   * Create a new issue in the repository.
   */
  async createIssue(
    title: string,
    body?: string,
    labels?: string[]
  ): Promise<GitHubIssue> {
    const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/issues`;

    const payload: Record<string, unknown> = { title };
    if (body) payload.body = body;
    if (labels && labels.length > 0) payload.labels = labels;

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    this.updateRateLimit(response.headers);

    if (!response.ok) {
      throw new Error(
        `GitHub API error creating issue: ${response.status} ${response.statusText}`
      );
    }

    return await response.json() as GitHubIssue;
  }

  /**
   * Close an issue by number.
   */
  async closeIssue(issueNumber: number): Promise<void> {
    const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/issues/${issueNumber}`;

    const response = await fetch(url, {
      method: 'PATCH',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ state: 'closed' }),
    });
    this.updateRateLimit(response.headers);

    if (!response.ok) {
      throw new Error(
        `GitHub API error closing issue #${issueNumber}: ${response.status} ${response.statusText}`
      );
    }
  }

  // ----------------------------------------------------------
  // Pull Requests API
  // ----------------------------------------------------------

  private _prEtag: string | null = null;

  async fetchPullRequests(): Promise<{ prs: GitHubPullRequest[] | null; rateLimit: RateLimitInfo }> {
    const params = new URLSearchParams({
      state: 'open',
      per_page: '100',
      sort: 'updated',
      direction: 'desc',
    });

    const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls?${params}`;

    const extraHeaders: Record<string, string> = {};
    if (this._prEtag) {
      extraHeaders['If-None-Match'] = this._prEtag;
    }

    const response = await fetch(url, { headers: this.headers(extraHeaders) });
    this.updateRateLimit(response.headers);

    if (response.status === 304) {
      return { prs: null, rateLimit: this.rateLimitInfo };
    }

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText} for ${url}`);
    }

    const etag = response.headers.get('etag');
    if (etag) this._prEtag = etag;

    let prs: GitHubPullRequest[] = await response.json() as GitHubPullRequest[];

    let nextUrl = this.parseNextLink(response.headers.get('link'));
    while (nextUrl) {
      const pageResponse = await fetch(nextUrl, { headers: this.headers() });
      this.updateRateLimit(pageResponse.headers);
      if (!pageResponse.ok) break;
      const pagePRs = await pageResponse.json() as GitHubPullRequest[];
      prs = prs.concat(pagePRs);
      nextUrl = this.parseNextLink(pageResponse.headers.get('link'));
    }

    return { prs, rateLimit: this.rateLimitInfo };
  }

  async fetchReviews(prNumber: number): Promise<GitHubReview[]> {
    const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/pulls/${prNumber}/reviews?per_page=100`;
    const response = await fetch(url, { headers: this.headers() });
    this.updateRateLimit(response.headers);

    if (!response.ok) {
      throw new Error(`GitHub API error fetching reviews for PR #${prNumber}: ${response.status}`);
    }

    return await response.json() as GitHubReview[];
  }

  // ----------------------------------------------------------
  // Label-based persistent claims
  // ----------------------------------------------------------

  async addLabel(issueNumber: number, label: string): Promise<void> {
    const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/issues/${issueNumber}/labels`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ labels: [label] }),
    });
    this.updateRateLimit(response.headers);

    if (!response.ok) {
      throw new Error(`GitHub API error adding label to #${issueNumber}: ${response.status}`);
    }
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: this.headers(),
    });
    this.updateRateLimit(response.headers);

    // 404 = label wasn't there, that's fine
    if (!response.ok && response.status !== 404) {
      throw new Error(`GitHub API error removing label from #${issueNumber}: ${response.status}`);
    }
  }

  async getLabels(issueNumber: number): Promise<Array<{ name: string }>> {
    const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/issues/${issueNumber}/labels`;
    const response = await fetch(url, { headers: this.headers() });
    this.updateRateLimit(response.headers);

    if (!response.ok) {
      throw new Error(`GitHub API error fetching labels for #${issueNumber}: ${response.status}`);
    }

    return await response.json() as Array<{ name: string }>;
  }

  /**
   * Reset the stored ETag (forces a fresh fetch on next call).
   */
  resetETag(): void {
    this._etag = null;
    this._prEtag = null;
  }
}
