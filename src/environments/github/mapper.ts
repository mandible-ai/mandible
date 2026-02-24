// PURPOSE: Default mappers for converting GitHub issues and PRs into mandible signals
// PURPOSE: Type mapping, payload extraction, concentration scoring, Golem body parsing

import type { GitHubIssue, GitHubPullRequest, GitHubReview, GitHubEnvConfig } from './types.js';
import type { Signal } from '../../core/types.js';

// ----------------------------------------------------------
// Type Mapper — labels → signal type
// ----------------------------------------------------------

/**
 * Derives a signal type from issue labels.
 * Priority order:
 *   1. golem + tablet labels → 'golem:tablet'
 *   2. First recognized category label → 'issue:{category}'
 *   3. Fallback → 'issue:open'
 */
export function defaultTypeMapper(issue: GitHubIssue): string {
  const labelNames = new Set(issue.labels.map(l => l.name.toLowerCase()));

  // Golem tablet detection
  if (labelNames.has('golem') && labelNames.has('tablet')) {
    return 'golem:tablet';
  }

  // Common issue category labels
  const categories = ['bug', 'feature', 'enhancement', 'documentation', 'question', 'security', 'performance'];
  for (const cat of categories) {
    if (labelNames.has(cat)) {
      return `issue:${cat}`;
    }
  }

  return 'issue:open';
}

// ----------------------------------------------------------
// Golem Body Parser
// ----------------------------------------------------------

export interface GolemBodySections {
  acceptanceCriteria?: string[];
  files?: string[];
  dependencies?: string[];
  risk?: string;
  effort?: string;
  description?: string;
}

/**
 * Parse structured Golem tablet body markdown.
 * Extracts sections like acceptance criteria, files, dependencies, risk/effort.
 */
export function parseGolemBody(body: string | null): GolemBodySections {
  if (!body) return {};

  const sections: GolemBodySections = {};
  const lines = body.split('\n');
  let currentSection: string | null = null;
  let currentItems: string[] = [];

  const flushSection = () => {
    if (!currentSection) return;
    const key = currentSection.toLowerCase();

    if (key.includes('acceptance') || key.includes('criteria')) {
      sections.acceptanceCriteria = currentItems.filter(Boolean);
    } else if (key.includes('file')) {
      sections.files = currentItems.filter(Boolean);
    } else if (key.includes('dependenc')) {
      sections.dependencies = currentItems.filter(Boolean);
    } else if (key.includes('risk')) {
      sections.risk = currentItems.join(' ').trim() || undefined;
    } else if (key.includes('effort')) {
      sections.effort = currentItems.join(' ').trim() || undefined;
    } else if (key.includes('description')) {
      sections.description = currentItems.join('\n').trim() || undefined;
    }
    currentItems = [];
  };

  for (const line of lines) {
    // Detect markdown headers (## Section Name)
    const headerMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headerMatch) {
      flushSection();
      currentSection = headerMatch[1];
      continue;
    }

    // Detect bold section headers (**Section Name**)
    const boldMatch = line.match(/^\*\*(.+?)\*\*/);
    if (boldMatch && !line.includes('- ')) {
      flushSection();
      currentSection = boldMatch[1];
      continue;
    }

    // Skip inline marker lines — handled separately at the end
    if (/^(risk|effort):\s/i.test(line.trim())) continue;

    // Collect list items and plain text
    const listItem = line.match(/^[-*]\s+(.+)/);
    if (listItem) {
      currentItems.push(listItem[1].trim());
    } else if (line.trim() && currentSection) {
      currentItems.push(line.trim());
    }
  }
  flushSection();

  // Try to extract inline risk/effort from labels-style markers
  const riskMatch = body.match(/risk:\s*(low|medium|high)/i);
  if (riskMatch && !sections.risk) {
    sections.risk = riskMatch[1].toLowerCase();
  }
  const effortMatch = body.match(/effort:\s*(XS|S|M|L|XL)/i);
  if (effortMatch && !sections.effort) {
    sections.effort = effortMatch[1].toUpperCase();
  }

  return sections;
}

// ----------------------------------------------------------
// Dependency Mapper — issue → signal IDs this issue depends on
// ----------------------------------------------------------

/**
 * Extract signal IDs from golem dependency strings.
 * Recognizes beadId format: bd-{prefix}.{number} → gh:{owner}/{repo}#{number}
 * Skips headers ("Blocked by:"), separators ("---"), and unrecognized text.
 */
export function parseDependencyIds(
  dependencies: string[],
  owner: string,
  repo: string
): string[] {
  const ids: string[] = [];
  for (const dep of dependencies) {
    const match = dep.match(/bd-\w+\.(\d+)/);
    if (match) {
      ids.push(`gh:${owner}/${repo}#${match[1]}`);
    }
  }
  return ids;
}

/**
 * Default dependency mapper — Golem-aware.
 * Parses the Golem body's dependencies section for beadId references.
 * Returns empty array for non-Golem issues or issues without dependencies.
 */
export function defaultDependencyMapper(
  issue: GitHubIssue,
  config: GitHubEnvConfig
): string[] {
  const labelNames = new Set(issue.labels.map(l => l.name.toLowerCase()));
  if (!labelNames.has('golem')) return [];

  const golem = parseGolemBody(issue.body);
  if (!golem.dependencies?.length) return [];

  return parseDependencyIds(golem.dependencies, config.owner, config.repo);
}

// ----------------------------------------------------------
// Payload Mapper — issue → signal payload
// ----------------------------------------------------------

/**
 * Extracts issue fields and parsed Golem body into a signal payload.
 */
export function defaultPayloadMapper(issue: GitHubIssue): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(l => l.name),
    assignee: issue.assignee?.login ?? null,
    milestone: issue.milestone?.title ?? null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: issue.html_url,
    comments: issue.comments,
  };

  // If it looks like a Golem tablet, parse the structured body
  const labelNames = new Set(issue.labels.map(l => l.name.toLowerCase()));
  if (labelNames.has('golem')) {
    const golem = parseGolemBody(issue.body);
    if (Object.keys(golem).length > 0) {
      payload.golem = golem;
    }
  }

  return payload;
}

// ----------------------------------------------------------
// Concentration Mapper — composite freshness score
// ----------------------------------------------------------

/**
 * Compute base freshness from issue updated_at.
 * Returns 1.0 for just-updated issues, decays linearly to 0 at maxStaleHours.
 */
export function computeFreshness(
  issue: GitHubIssue,
  maxStaleHours: number,
  floor: number
): number {
  const updatedAt = new Date(issue.updated_at).getTime();
  const hoursSinceUpdate = (Date.now() - updatedAt) / (1000 * 60 * 60);
  const freshness = 1.0 - (hoursSinceUpdate / maxStaleHours);
  return Math.max(floor, Math.min(1.0, freshness));
}

/**
 * Default concentration mapper using composite score:
 *   base_freshness + comment_boost + assigned_boost + milestone_boost
 *
 * All data comes from the issue object — zero extra API calls.
 */
export function defaultConcentrationMapper(
  issue: GitHubIssue,
  config: GitHubEnvConfig
): number {
  const maxStaleHours = config.maxStaleHours ?? 168;
  const floor = config.concentrationFloor ?? 0.05;

  const baseFreshness = computeFreshness(issue, maxStaleHours, floor);
  const commentBoost = Math.min(0.2, issue.comments * 0.02);
  const assignedBoost = issue.assignee ? 0.1 : 0;
  const milestoneBoost = issue.milestone ? 0.05 : 0;

  const raw = baseFreshness + commentBoost + assignedBoost + milestoneBoost;
  return Math.max(floor, Math.min(1.0, raw));
}

// ----------------------------------------------------------
// PR Type Mapper — state + review status → signal type
// ----------------------------------------------------------

/**
 * Determines the latest review verdict for a PR.
 * Only considers the most recent review per reviewer.
 */
export function resolveReviewState(reviews: GitHubReview[]): 'approved' | 'changes-requested' | 'review-requested' | 'pending' {
  if (reviews.length === 0) return 'pending';

  // Most recent review per reviewer wins
  const latestByUser = new Map<string, GitHubReview>();
  for (const review of reviews) {
    const existing = latestByUser.get(review.user.login);
    if (!existing || new Date(review.submitted_at) > new Date(existing.submitted_at)) {
      latestByUser.set(review.user.login, review);
    }
  }

  const verdicts = Array.from(latestByUser.values());
  if (verdicts.some(r => r.state === 'CHANGES_REQUESTED')) return 'changes-requested';
  if (verdicts.some(r => r.state === 'APPROVED')) return 'approved';
  return 'pending';
}

/**
 * Derives a signal type from PR state and review status.
 *
 * Priority order:
 *   1. Draft PR → 'pr:draft'
 *   2. Merged → 'pr:merged'
 *   3. Closed (not merged) → 'pr:closed'
 *   4. Has label matching a known category → 'pr:{category}'
 *   5. Review state → 'pr:approved', 'pr:changes-requested'
 *   6. Has requested reviewers → 'pr:review-requested'
 *   7. Fallback → 'pr:open'
 */
export function defaultPRTypeMapper(pr: GitHubPullRequest, reviews: GitHubReview[]): string {
  if (pr.draft) return 'pr:draft';
  if (pr.merged) return 'pr:merged';
  if (pr.state === 'closed') return 'pr:closed';

  // Check labels for category signals (security, bug, etc.)
  const labelNames = new Set(pr.labels.map(l => l.name.toLowerCase()));
  const categories = ['security', 'bug', 'breaking', 'hotfix', 'dependencies'];
  for (const cat of categories) {
    if (labelNames.has(cat)) return `pr:${cat}`;
  }

  // Review state
  const reviewState = resolveReviewState(reviews);
  if (reviewState === 'approved') return 'pr:approved';
  if (reviewState === 'changes-requested') return 'pr:changes-requested';

  if (pr.requested_reviewers.length > 0) return 'pr:review-requested';

  return 'pr:open';
}

// ----------------------------------------------------------
// PR Payload Mapper
// ----------------------------------------------------------

export function defaultPRPayloadMapper(pr: GitHubPullRequest, reviews: GitHubReview[]): Record<string, unknown> {
  const reviewSummary = reviews.length > 0 ? {
    reviewState: resolveReviewState(reviews),
    reviewCount: reviews.length,
    reviewers: [...new Set(reviews.map(r => r.user.login))],
    latestReview: reviews[reviews.length - 1] ? {
      user: reviews[reviews.length - 1].user.login,
      state: reviews[reviews.length - 1].state,
      submitted_at: reviews[reviews.length - 1].submitted_at,
    } : undefined,
  } : undefined;

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    draft: pr.draft,
    merged: pr.merged,
    merged_at: pr.merged_at,
    labels: pr.labels.map(l => l.name),
    assignee: pr.assignee?.login ?? null,
    author: pr.user.login,
    milestone: pr.milestone?.title ?? null,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    html_url: pr.html_url,
    head: pr.head,
    base: pr.base,
    commits: pr.commits,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    requested_reviewers: pr.requested_reviewers.map(r => r.login),
    reviews: reviewSummary,
  };
}

// ----------------------------------------------------------
// PR Concentration Mapper
// ----------------------------------------------------------

/**
 * PR concentration based on freshness, review urgency, and size.
 *
 * Boosts:
 *   - Requested reviewers waiting → +0.15
 *   - Changes requested (needs author action) → +0.1
 *   - Small PRs (< 100 lines) → +0.05
 *
 * Penalties:
 *   - Draft PRs → -0.2
 *   - Very large PRs (> 500 lines) → -0.05
 */
export function defaultPRConcentrationMapper(
  pr: GitHubPullRequest,
  reviews: GitHubReview[],
  config: GitHubEnvConfig
): number {
  const maxStaleHours = config.maxStaleHours ?? 168;
  const floor = config.concentrationFloor ?? 0.05;

  const updatedAt = new Date(pr.updated_at).getTime();
  const hoursSinceUpdate = (Date.now() - updatedAt) / (1000 * 60 * 60);
  const baseFreshness = Math.max(floor, Math.min(1.0, 1.0 - (hoursSinceUpdate / maxStaleHours)));

  let concentration = baseFreshness;

  // Review urgency
  if (pr.requested_reviewers.length > 0) concentration += 0.15;
  const reviewState = resolveReviewState(reviews);
  if (reviewState === 'changes-requested') concentration += 0.1;

  // Size factors
  const totalLines = pr.additions + pr.deletions;
  if (totalLines < 100) concentration += 0.05;
  if (totalLines > 500) concentration -= 0.05;

  // Draft penalty
  if (pr.draft) concentration -= 0.2;

  return Math.max(floor, Math.min(1.0, concentration));
}

// ----------------------------------------------------------
// Dependency Boost — graph-aware concentration post-processing
// ----------------------------------------------------------

/**
 * Compute concentration adjustments based on the dependency graph.
 * Signals that unblock more downstream work get higher concentration.
 * Leaf nodes (depend on others, nothing depends on them) get penalized.
 *
 * Returns positive values (boosts) and negative values (penalties).
 * Does NOT mutate the input signals.
 */
export function computeDependencyBoosts(
  signals: Map<string, Signal>,
  options?: { rootBoost?: number; dependentBoost?: number; maxBoost?: number; leafPenalty?: number }
): Map<string, number> {
  const rootBoost = options?.rootBoost ?? 0.15;
  const dependentBoost = options?.dependentBoost ?? 0.05;
  const maxBoost = options?.maxBoost ?? 0.3;
  const leafPenalty = options?.leafPenalty ?? 0.15;

  // Build reverse-dep map: signalId → count of signals that depend on it
  const dependentCount = new Map<string, number>();
  for (const signal of signals.values()) {
    const causedBy = signal.meta.caused_by;
    if (!causedBy) continue;
    for (const depId of causedBy) {
      dependentCount.set(depId, (dependentCount.get(depId) ?? 0) + 1);
    }
  }

  const boosts = new Map<string, number>();

  for (const [id, signal] of signals) {
    const hasDependencies = (signal.meta.caused_by?.length ?? 0) > 0;
    const numDependents = dependentCount.get(id) ?? 0;

    if (hasDependencies && numDependents === 0) {
      // Leaf node — has deps, nothing depends on it → penalize
      if (leafPenalty > 0) boosts.set(id, -leafPenalty);
      continue;
    }

    if (numDependents === 0) continue; // isolated — no adjustment

    let boost = Math.min(maxBoost, numDependents * dependentBoost);

    // Root nodes (nothing they depend on, but others depend on them) get extra boost
    if (!hasDependencies) {
      boost = Math.min(maxBoost, boost + rootBoost);
    }

    boosts.set(id, boost);
  }

  return boosts;
}
