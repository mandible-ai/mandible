// ============================================================
// Signal Factory & Utilities
// ============================================================

import type { Signal, SignalMeta, SignalQuery } from './types.js';

let idCounter = 0;
const generateId = (): string => {
  const ts = Date.now().toString(36);
  const seq = (idCounter++).toString(36).padStart(4, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `sig_${ts}_${seq}_${rand}`;
};

/**
 * Create a new signal with sensible defaults.
 */
export function createSignal<T = Record<string, unknown>>(
  type: string,
  payload: T,
  options?: {
    deposited_by?: string;
    ttl?: number;
    tags?: string[];
    caused_by?: string[];
    concentration?: number;
  }
): Signal<T> {
  const now = Date.now();
  return {
    id: generateId(),
    type,
    payload,
    meta: {
      deposited_at: now,
      deposited_by: options?.deposited_by ?? 'unknown',
      concentration: options?.concentration ?? 1.0,
      ttl: options?.ttl,
      tags: options?.tags,
      caused_by: options?.caused_by,
    },
  };
}

/**
 * Check if a signal matches a query.
 */
export function matchesQuery(signal: Signal, query: SignalQuery): boolean {
  // Type matching (supports glob with *)
  if (query.type) {
    const types = Array.isArray(query.type) ? query.type : [query.type];
    const typeMatches = types.some(pattern => matchType(signal.type, pattern));
    if (!typeMatches) return false;
  }

  // Concentration threshold
  if (query.minConcentration !== undefined) {
    if (signal.meta.concentration < query.minConcentration) return false;
  }

  // Unclaimed filter
  if (query.unclaimed === true) {
    if (signal.meta.claimed_by) return false;
  }

  // Tags filter (all specified tags must be present)
  if (query.tags && query.tags.length > 0) {
    const signalTags = new Set(signal.meta.tags ?? []);
    if (!query.tags.every(t => signalTags.has(t))) return false;
  }

  // Time filter
  if (query.after !== undefined) {
    if (signal.meta.deposited_at <= query.after) return false;
  }

  // Custom filter
  if (query.filter) {
    if (!query.filter(signal)) return false;
  }

  return true;
}

/**
 * Glob-style type matching. Supports:
 *   'task:ready'   — exact match
 *   'task:*'       — matches any task signal
 *   '*:ready'      — matches any domain with state 'ready'
 *   '*'            — matches everything
 */
export function matchType(signalType: string, pattern: string): boolean {
  if (pattern === '*') return true;

  // Convert glob to regex
  // Order matters: `**` must be handled before `*`, or it degrades to `*`.
  const regexStr = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex special chars
    .replace(/\*\*/g, '\0')              // placeholder for ** (across segments)
    .replace(/\*/g, '[^:]*')                 // * matches within a segment
    .replace(/\0/g, '.*')                // ** matches across segments
    + '$';

  return new RegExp(regexStr).test(signalType);
}

/**
 * Apply concentration decay to a signal based on elapsed time.
 * Returns the new concentration value (does not mutate the signal).
 */
export function decayConcentration(
  signal: Signal,
  ratePerSecond: number,
  now: number = Date.now()
): number {
  const elapsedMs = now - signal.meta.deposited_at;
  const elapsedSeconds = elapsedMs / 1000;
  const newConcentration = signal.meta.concentration - (ratePerSecond * elapsedSeconds);
  return Math.max(0, newConcentration);
}

/**
 * Check if a signal has expired based on its TTL.
 */
export function isExpired(signal: Signal, now: number = Date.now()): boolean {
  if (!signal.meta.ttl) return false;
  return now - signal.meta.deposited_at > signal.meta.ttl;
}

/**
 * Check if a signal's claim lease has expired.
 */
export function isClaimExpired(signal: Signal, now: number = Date.now()): boolean {
  if (!signal.meta.claimed_by || !signal.meta.claimed_at || !signal.meta.claim_lease) {
    return false;
  }
  return now - signal.meta.claimed_at > signal.meta.claim_lease;
}

/**
 * Sort signals by concentration (highest first), then by age (newest first).
 */
export function prioritize(signals: Signal[]): Signal[] {
  return [...signals].sort((a, b) => {
    // Higher concentration first
    const concDiff = b.meta.concentration - a.meta.concentration;
    if (Math.abs(concDiff) > 0.001) return concDiff;
    // Then newer first
    return b.meta.deposited_at - a.meta.deposited_at;
  });
}
