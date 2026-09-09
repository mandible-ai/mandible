// PURPOSE: The contract an environment implements when its signals are proposed
// changes that can be read as a diff and answered with a review.
// PURPOSE: Lives beside its only implementer. The shape is substrate-neutral on
// purpose — a colony asks to review a signal rather than knowing which API to
// POST to — so a second forge can satisfy it without importing this module, and
// it moves somewhere shared on the day one does.

/** What a review says about a change. */
export type ReviewVerdict = 'comment' | 'approve' | 'request-changes';

/**
 * A review already on the change. `other` covers verdicts a substrate has that
 * this vocabulary does not — a dismissed or pending GitHub review, say — so
 * reading them never loses a review or invents a meaning for it.
 */
export interface ReviewRecord {
  /** Whoever left it, named the way the substrate names people. */
  author: string;
  verdict: ReviewVerdict | 'other';
  body: string;
  /**
   * The revision it was written against, when the substrate tracks one. This
   * is what lets a reviewer skip work it has already done: a review of the
   * current revision is done, a review of an older one is stale.
   */
  revision?: string;
  submittedAt?: string;
}

/** A review to leave on a change. */
export interface ReviewSubmission {
  verdict: ReviewVerdict;
  body: string;
}

/**
 * CodeReviewable is the slice of an environment a reviewer needs. Signals carry
 * the fact that a change exists; this carries the change itself and the way
 * back to it.
 *
 * It is a capability rather than part of Environment because almost nothing can
 * do it: a filesystem has no notion of a review, and putting one on Environment
 * would mean a method that always throws. It is not in core for the same
 * reason — a review is a forge's concept, not the framework's.
 */
export interface CodeReviewable {
  /** The change this signal proposes, as a unified diff. */
  fetchDiff(signalId: string): Promise<string>;
  /** Reviews already on the change, oldest first. */
  listReviews(signalId: string): Promise<ReviewRecord[]>;
  /** Leave a review on the change. */
  submitReview(signalId: string, review: ReviewSubmission): Promise<void>;
}

/** Narrows an environment to the reviewing capability. */
export function isCodeReviewable(candidate: unknown): candidate is CodeReviewable {
  const environment = candidate as Partial<CodeReviewable> | null | undefined;
  return (
    !!environment &&
    typeof environment.fetchDiff === 'function' &&
    typeof environment.listReviews === 'function' &&
    typeof environment.submitReview === 'function'
  );
}
