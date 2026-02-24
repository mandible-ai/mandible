// PURPOSE: Type definitions for the GitHub environment adapter
// PURPOSE: Interfaces for config, GitHub API responses, and concentration mapping

// ----------------------------------------------------------
// GitHub Issue — subset of GitHub API response we care about
// ----------------------------------------------------------

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<{ name: string }>;
  assignee: { login: string } | null;
  milestone: { title: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  comments: number;
  pull_request?: unknown; // present = this is a PR via issues endpoint
}

// ----------------------------------------------------------
// GitHub Pull Request — subset of Pulls API response
// ----------------------------------------------------------

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  merged_at: string | null;
  labels: Array<{ name: string }>;
  assignee: { login: string } | null;
  user: { login: string };
  milestone: { title: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  comments: number;
  review_comments: number;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  requested_reviewers: Array<{ login: string }>;
  mergeable_state?: string;
}

// ----------------------------------------------------------
// GitHub Review — subset of Reviews API response
// ----------------------------------------------------------

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';

export interface GitHubReview {
  id: number;
  user: { login: string };
  state: ReviewState;
  body: string | null;
  submitted_at: string;
}

// ----------------------------------------------------------
// Concentration mappers
// ----------------------------------------------------------

export type ConcentrationMapper = (issue: GitHubIssue, config: GitHubEnvConfig) => number;
export type PRConcentrationMapper = (pr: GitHubPullRequest, reviews: GitHubReview[], config: GitHubEnvConfig) => number;

// ----------------------------------------------------------
// GitHub Environment Config
// ----------------------------------------------------------

export interface GitHubEnvConfig {
  /** Repository owner (user or org) */
  owner: string;

  /** Repository name */
  repo: string;

  /** GitHub personal access token. Defaults to GITHUB_TOKEN env var */
  token?: string;

  /** Human-readable environment name. Defaults to "gh:{owner}/{repo}" */
  name?: string;

  /** Polling interval in ms. Default: 30_000 (30s) */
  pollInterval?: number;

  /** Hours after which an untouched issue has zero freshness. Default: 168 (7 days) */
  maxStaleHours?: number;

  /** Minimum concentration floor. Default: 0.05 */
  concentrationFloor?: number;

  /** Decay rate in concentration units per second. Default: 0.001 */
  decayRate?: number;

  /** Filter issues by these labels (sent to GitHub API). Default: all issues */
  labels?: string[];

  /** Custom signal type mapper. Default: derives from labels */
  typeMapper?: (issue: GitHubIssue) => string;

  /** Custom payload mapper. Default: includes issue fields + parsed Golem body */
  payloadMapper?: (issue: GitHubIssue) => Record<string, unknown>;

  /** Custom concentration mapper. Default: composite freshness score */
  concentrationMapper?: ConcentrationMapper;

  /** Custom dependency mapper. Returns signal IDs that this issue depends on.
   *  Default: parses beadId references from Golem body dependencies section */
  dependencyMapper?: (issue: GitHubIssue, config: GitHubEnvConfig) => string[];

  /** Additional filter applied after fetching issues. Default: none */
  issueFilter?: (issue: GitHubIssue) => boolean;

  /** Include pull requests as signals. Default: true */
  includePRs?: boolean;

  /** Include issues as signals. Default: true */
  includeIssues?: boolean;

  /** Custom signal type mapper for PRs. Default: derives from state + review status */
  prTypeMapper?: (pr: GitHubPullRequest, reviews: GitHubReview[]) => string;

  /** Custom payload mapper for PRs. Default: includes PR fields + review summary */
  prPayloadMapper?: (pr: GitHubPullRequest, reviews: GitHubReview[]) => Record<string, unknown>;

  /** Custom concentration mapper for PRs. Default: composite freshness + review urgency */
  prConcentrationMapper?: PRConcentrationMapper;

  /** Filter PRs after fetching. Default: none */
  prFilter?: (pr: GitHubPullRequest) => boolean;

  /** Fetch reviews for each PR (extra API call per PR). Default: true */
  fetchReviews?: boolean;

  /** Use GitHub labels for persistent claims. Default: false (in-memory) */
  persistentClaims?: boolean;

  /** Prefix for claim labels. Default: 'mandible:claimed' */
  claimLabelPrefix?: string;

  /** Whether deposit() creates GitHub issues. Default: true */
  allowDeposit?: boolean;

  /** Whether withdraw() closes GitHub issues. Default: false (destructive) */
  allowWithdraw?: boolean;

  /** GitHub API base URL. Default: "https://api.github.com" */
  apiBase?: string;

  /** Dependency-aware concentration boosting.
   *  Signals that unblock more downstream work get higher concentration. */
  dependencyBoost?: {
    /** Boost for root nodes (no dependencies, has dependents). Default: 0.15 */
    rootBoost?: number;
    /** Boost per dependent signal. Default: 0.05 */
    dependentBoost?: number;
    /** Maximum total dependency boost. Default: 0.3 */
    maxBoost?: number;
    /** Penalty for leaf nodes (has dependencies, nothing depends on them). Default: 0.15 */
    leafPenalty?: number;
  };
}
