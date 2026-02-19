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
  pull_request?: unknown; // present = this is a PR, skip it
}

// ----------------------------------------------------------
// Concentration mapper — pluggable scoring function
// ----------------------------------------------------------

export type ConcentrationMapper = (issue: GitHubIssue, config: GitHubEnvConfig) => number;

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
  };
}
