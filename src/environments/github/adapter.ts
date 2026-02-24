// PURPOSE: GitHub environment adapter — GitHub Issues + PRs as a stigmergy substrate
// PURPOSE: Polling with ETag caching, concentration reinforcement, label-based claims

import type {
  Environment, Signal, SignalQuery, SignalMeta,
  Subscription, DecayResult,
} from '../../core/types.js';
import { matchesQuery, isClaimExpired } from '../../core/signal.js';
import { validateSignalInput } from '../../core/validation.js';
import { GitHubClient } from './client.js';
import type { GitHubEnvConfig, GitHubIssue, GitHubPullRequest, GitHubReview } from './types.js';
import {
  defaultTypeMapper,
  defaultPayloadMapper,
  defaultConcentrationMapper,
  defaultDependencyMapper,
  defaultPRTypeMapper,
  defaultPRPayloadMapper,
  defaultPRConcentrationMapper,
  computeDependencyBoosts,
} from './mapper.js';

export class GitHubEnvironment implements Environment {
  readonly name: string;
  private readonly config: GitHubEnvConfig;
  private readonly client: GitHubClient;
  private readonly typeMapper: (issue: GitHubIssue) => string;
  private readonly payloadMapper: (issue: GitHubIssue) => Record<string, unknown>;
  private readonly concentrationMapper: (issue: GitHubIssue, config: GitHubEnvConfig) => number;
  private readonly dependencyMapper: (issue: GitHubIssue, config: GitHubEnvConfig) => string[];
  private readonly issueFilter: ((issue: GitHubIssue) => boolean) | undefined;
  private readonly prTypeMapper: (pr: GitHubPullRequest, reviews: GitHubReview[]) => string;
  private readonly prPayloadMapper: (pr: GitHubPullRequest, reviews: GitHubReview[]) => Record<string, unknown>;
  private readonly prConcentrationMapper: (pr: GitHubPullRequest, reviews: GitHubReview[], config: GitHubEnvConfig) => number;
  private readonly prFilter: ((pr: GitHubPullRequest) => boolean) | undefined;
  private readonly includePRs: boolean;
  private readonly includeIssues: boolean;
  private readonly fetchReviews: boolean;
  private readonly persistentClaims: boolean;
  private readonly claimLabelPrefix: string;
  private readonly decayRate: number;
  private readonly concentrationFloor: number;

  // In-memory signal cache — GitHub API is source of truth
  private signals = new Map<string, Signal>();
  private withdrawn = new Map<string, Signal>();
  // Cache of reviews per PR number
  private prReviews = new Map<number, GitHubReview[]>();

  // Tracking for decay
  private lastSyncAt: number = Date.now();
  private lastDecayAt: number = Date.now();
  private initialized = false;

  constructor(config: GitHubEnvConfig) {
    this.config = config;
    this.name = config.name ?? `gh:${config.owner}/${config.repo}`;
    this.client = new GitHubClient(config);
    this.typeMapper = config.typeMapper ?? defaultTypeMapper;
    this.payloadMapper = config.payloadMapper ?? defaultPayloadMapper;
    this.concentrationMapper = config.concentrationMapper ?? defaultConcentrationMapper;
    this.dependencyMapper = config.dependencyMapper ?? defaultDependencyMapper;
    this.issueFilter = config.issueFilter;
    this.prTypeMapper = config.prTypeMapper ?? defaultPRTypeMapper;
    this.prPayloadMapper = config.prPayloadMapper ?? defaultPRPayloadMapper;
    this.prConcentrationMapper = config.prConcentrationMapper ?? defaultPRConcentrationMapper;
    this.prFilter = config.prFilter;
    this.includePRs = config.includePRs !== false;
    this.includeIssues = config.includeIssues !== false;
    this.fetchReviews = config.fetchReviews !== false;
    this.persistentClaims = config.persistentClaims ?? false;
    this.claimLabelPrefix = config.claimLabelPrefix ?? 'mandible:claimed';
    this.decayRate = config.decayRate ?? 0.001;
    this.concentrationFloor = config.concentrationFloor ?? 0.05;
  }

  // ----------------------------------------------------------
  // Signal ID — deterministic mapping from issue number
  // ----------------------------------------------------------

  private signalId(issueNumber: number): string {
    return `gh:${this.config.owner}/${this.config.repo}#${issueNumber}`;
  }

  private issueNumberFromSignalId(signalId: string): number | null {
    const match = signalId.match(/#(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  }

  // ----------------------------------------------------------
  // Issue → Signal conversion
  // ----------------------------------------------------------

  private issueToSignal(issue: GitHubIssue): Signal {
    const id = this.signalId(issue.number);
    const type = this.typeMapper(issue);
    const payload = this.payloadMapper(issue);
    const concentration = this.concentrationMapper(issue, this.config);
    const tags = issue.labels.map(l => l.name);

    // Restore persistent claim from labels
    let claimed_by: string | undefined;
    if (this.persistentClaims) {
      const claimLabel = issue.labels.find(l => l.name.startsWith(this.claimLabelPrefix + ':'));
      if (claimLabel) {
        claimed_by = claimLabel.name.slice(this.claimLabelPrefix.length + 1);
      }
    }

    const signal: Signal = {
      id,
      type,
      payload,
      meta: {
        deposited_at: new Date(issue.created_at).getTime(),
        deposited_by: 'github',
        concentration,
        tags,
        ...(claimed_by ? { claimed_by, claimed_at: Date.now() } : {}),
      },
    };

    // Wire dependency edges via pluggable mapper
    const depIds = this.dependencyMapper(issue, this.config);
    if (depIds.length > 0) {
      signal.meta.caused_by = depIds;
    }

    return signal;
  }

  // ----------------------------------------------------------
  // PR → Signal conversion
  // ----------------------------------------------------------

  private prToSignal(pr: GitHubPullRequest, reviews: GitHubReview[]): Signal {
    const id = this.signalId(pr.number);
    const type = this.prTypeMapper(pr, reviews);
    const payload = this.prPayloadMapper(pr, reviews);
    const concentration = this.prConcentrationMapper(pr, reviews, this.config);
    const tags = pr.labels.map(l => l.name);

    // Restore persistent claim from labels
    let claimed_by: string | undefined;
    if (this.persistentClaims) {
      const claimLabel = pr.labels.find(l => l.name.startsWith(this.claimLabelPrefix + ':'));
      if (claimLabel) {
        claimed_by = claimLabel.name.slice(this.claimLabelPrefix.length + 1);
      }
    }

    return {
      id,
      type,
      payload,
      meta: {
        deposited_at: new Date(pr.created_at).getTime(),
        deposited_by: 'github',
        concentration,
        tags,
        ...(claimed_by ? { claimed_by, claimed_at: Date.now() } : {}),
      },
    };
  }

  // ----------------------------------------------------------
  // Sync from GitHub API
  // ----------------------------------------------------------

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await this.syncFromGitHub();
    this.initialized = true;
  }

  /**
   * Core sync method. Fetches issues and PRs from GitHub and updates local cache.
   * Returns the list of new signal IDs that appeared since last sync.
   */
  async syncFromGitHub(): Promise<string[]> {
    const newSignalIds: string[] = [];

    // Sync issues
    if (this.includeIssues) {
      const result = await this.client.fetchIssues();
      if (result.issues !== null) {
        for (const issue of result.issues) {
          // Skip pull requests (GitHub returns PRs in the issues endpoint)
          if (issue.pull_request) continue;
          if (this.issueFilter && !this.issueFilter(issue)) continue;

          const freshSignal = this.issueToSignal(issue);
          this.mergeSignal(freshSignal, newSignalIds);
        }
      }
    }

    // Sync pull requests
    if (this.includePRs) {
      const prResult = await this.client.fetchPullRequests();
      if (prResult.prs !== null) {
        for (const pr of prResult.prs) {
          if (this.prFilter && !this.prFilter(pr)) continue;

          let reviews: GitHubReview[] = [];
          if (this.fetchReviews) {
            try {
              reviews = await this.client.fetchReviews(pr.number);
            } catch {
              // Use empty reviews on failure — signal still gets created
            }
            this.prReviews.set(pr.number, reviews);
          }

          const freshSignal = this.prToSignal(pr, reviews);
          this.mergeSignal(freshSignal, newSignalIds);
        }
      }
    }

    // Apply dependency-aware concentration adjustments
    const boosts = computeDependencyBoosts(this.signals, {
      rootBoost: this.config.dependencyBoost?.rootBoost,
      dependentBoost: this.config.dependencyBoost?.dependentBoost,
      maxBoost: this.config.dependencyBoost?.maxBoost,
      leafPenalty: this.config.dependencyBoost?.leafPenalty,
    });
    for (const [id, adjustment] of boosts) {
      const signal = this.signals.get(id);
      if (signal) {
        signal.meta.concentration = Math.max(
          this.concentrationFloor,
          Math.min(1.0, signal.meta.concentration + adjustment)
        );
      }
    }

    this.lastSyncAt = Date.now();
    return newSignalIds;
  }

  private mergeSignal(freshSignal: Signal, newSignalIds: string[]): void {
    const existing = this.signals.get(freshSignal.id);
    if (existing) {
      freshSignal.meta.concentration = Math.max(
        existing.meta.concentration,
        freshSignal.meta.concentration
      );
      // Preserve in-memory claim state unless using persistent claims
      if (!this.persistentClaims) {
        freshSignal.meta.claimed_by = existing.meta.claimed_by;
        freshSignal.meta.claimed_at = existing.meta.claimed_at;
        freshSignal.meta.claim_lease = existing.meta.claim_lease;
      }
    } else {
      newSignalIds.push(freshSignal.id);
    }
    this.signals.set(freshSignal.id, freshSignal);
  }

  /**
   * Public method to force a manual refresh. Useful for testing.
   */
  async sync(): Promise<void> {
    await this.syncFromGitHub();
    this.initialized = true;
  }

  // ----------------------------------------------------------
  // Environment interface implementation
  // ----------------------------------------------------------

  async observe(query: SignalQuery): Promise<Signal[]> {
    await this.ensureInit();
    let matched = Array.from(this.signals.values()).filter(s => matchesQuery(s, query));
    if (query.limit) {
      matched = matched.slice(0, query.limit);
    }
    return matched;
  }

  async deposit(
    input: Omit<Signal, 'id' | 'meta'> & { meta?: Partial<SignalMeta> }
  ): Promise<Signal> {
    await this.ensureInit();
    validateSignalInput(input);

    if (this.config.allowDeposit === false) {
      throw new Error('GitHubEnvironment: deposit (issue creation) is disabled via config');
    }

    // Create a real GitHub issue
    const labels = input.meta?.tags ?? [];
    const issue = await this.client.createIssue(
      (input.payload as Record<string, unknown>).title as string ?? input.type,
      (input.payload as Record<string, unknown>).body as string | undefined,
      labels
    );

    const signal = this.issueToSignal(issue);

    // Override with caller's meta if provided
    if (input.meta?.deposited_by) signal.meta.deposited_by = input.meta.deposited_by;
    if (input.meta?.ttl) signal.meta.ttl = input.meta.ttl;
    if (input.meta?.caused_by) signal.meta.caused_by = input.meta.caused_by;
    if (input.meta?.concentration !== undefined) signal.meta.concentration = input.meta.concentration;

    this.signals.set(signal.id, signal);
    return signal;
  }

  async withdraw(signalId: string): Promise<void> {
    await this.ensureInit();

    if (this.config.allowWithdraw === false) {
      throw new Error('GitHubEnvironment: withdraw (issue closing) is disabled via config');
    }

    const issueNumber = this.issueNumberFromSignalId(signalId);
    if (issueNumber !== null) {
      await this.client.closeIssue(issueNumber);
    }

    const signal = this.signals.get(signalId);
    if (signal) {
      this.withdrawn.set(signalId, signal);
      this.signals.delete(signalId);
    }
  }

  async claim(
    signalId: string,
    claimant: string,
    leaseDuration: number = 60_000
  ): Promise<boolean> {
    await this.ensureInit();

    const signal = this.signals.get(signalId);
    if (!signal) return false;

    // Check existing claim
    if (signal.meta.claimed_by) {
      if (!isClaimExpired(signal)) {
        return false; // Already claimed and not expired
      }
      // Expired claim — allow takeover. Remove old persistent label if needed.
      if (this.persistentClaims) {
        const issueNumber = this.issueNumberFromSignalId(signalId);
        const oldLabel = `${this.claimLabelPrefix}:${signal.meta.claimed_by}`;
        if (issueNumber !== null) {
          await this.client.removeLabel(issueNumber, oldLabel);
        }
      }
    }

    signal.meta.claimed_by = claimant;
    signal.meta.claimed_at = Date.now();
    signal.meta.claim_lease = leaseDuration;

    // Persist claim as a GitHub label
    if (this.persistentClaims) {
      const issueNumber = this.issueNumberFromSignalId(signalId);
      if (issueNumber !== null) {
        await this.client.addLabel(issueNumber, `${this.claimLabelPrefix}:${claimant}`);
      }
    }

    return true;
  }

  async release(signalId: string): Promise<void> {
    await this.ensureInit();

    const signal = this.signals.get(signalId);
    if (!signal) return;

    // Remove persistent claim label
    if (this.persistentClaims && signal.meta.claimed_by) {
      const issueNumber = this.issueNumberFromSignalId(signalId);
      if (issueNumber !== null) {
        await this.client.removeLabel(
          issueNumber,
          `${this.claimLabelPrefix}:${signal.meta.claimed_by}`
        );
      }
    }

    signal.meta.claimed_by = undefined;
    signal.meta.claimed_at = undefined;
    signal.meta.claim_lease = undefined;
  }

  watch(
    query: SignalQuery,
    callback: (signal: Signal) => void
  ): Subscription {
    const seen = new Set<string>();
    let active = true;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const pollInterval = this.config.pollInterval ?? 30_000;

    const emitMatches = async () => {
      if (!active) return;
      try {
        const newIds = await this.syncFromGitHub();
        if (!this.initialized) this.initialized = true;

        for (const [id, signal] of this.signals) {
          if (!active) return;
          if (seen.has(id)) continue;
          if (matchesQuery(signal, query)) {
            seen.add(id);
            callback(signal);
          }
        }
      } catch {
        // Swallow errors during poll — will retry next cycle
      }
    };

    // Initial sync + emit
    const setup = async () => {
      await emitMatches();
      if (!active) return;
      pollTimer = setInterval(emitMatches, pollInterval);
    };

    setup();

    return {
      unsubscribe() {
        active = false;
        if (pollTimer) clearInterval(pollTimer);
      },
    };
  }

  async history(
    query: SignalQuery & { includeWithdrawn?: boolean }
  ): Promise<Signal[]> {
    await this.ensureInit();

    const active = Array.from(this.signals.values());
    let all = active;

    if (query.includeWithdrawn) {
      const withdrawnSignals = Array.from(this.withdrawn.values());
      all = [...active, ...withdrawnSignals];
    }

    let matched = all.filter(s => matchesQuery(s, query));
    if (query.limit) matched = matched.slice(0, query.limit);
    return matched;
  }

  async decay(): Promise<DecayResult> {
    await this.ensureInit();
    const now = Date.now();
    const result: DecayResult = { decayed: 0, evaporated: 0, claimsReleased: 0 };

    // Elapsed since LAST DECAY (not last sync) — prevents quadratic compounding
    const elapsedSeconds = (now - this.lastDecayAt) / 1000;

    // Only apply concentration decay if meaningful time has passed
    // (guards against multiple runtimes sharing this environment)
    const shouldDecayConcentration = elapsedSeconds >= 0.1;
    if (shouldDecayConcentration) {
      this.lastDecayAt = now;
    }

    const decayAmount = shouldDecayConcentration ? this.decayRate * elapsedSeconds : 0;

    for (const [id, signal] of this.signals) {
      let changed = false;

      // Always check claim lease expiration regardless of elapsed time
      if (isClaimExpired(signal, now)) {
        signal.meta.claimed_by = undefined;
        signal.meta.claimed_at = undefined;
        signal.meta.claim_lease = undefined;
        result.claimsReleased++;
        changed = true;
      }

      // Linear decay — same amount for all signals this sweep
      const newConcentration = signal.meta.concentration - decayAmount;

      if (newConcentration < this.concentrationFloor) {
        // Below floor — evaporate
        this.withdrawn.set(id, signal);
        this.signals.delete(id);
        result.evaporated++;
        continue;
      }

      if (Math.abs(newConcentration - signal.meta.concentration) > 0.0001) {
        signal.meta.concentration = newConcentration;
        changed = true;
        result.decayed++;
      }

      // We don't write to disk — in-memory cache only
      if (changed) {
        this.signals.set(id, signal);
      }
    }

    return result;
  }

  async snapshot(): Promise<Signal[]> {
    await this.ensureInit();
    return Array.from(this.signals.values());
  }
}
