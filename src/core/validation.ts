// ============================================================
// Signal Validation — reject malformed signals at deposit time
// ============================================================

import type { Signal, SignalMeta } from './types.js';

export class SignalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalValidationError';
  }
}

export function validateSignalInput(
  input: { type: string; payload: unknown; meta?: Partial<SignalMeta> }
): void {
  if (typeof input.type !== 'string' || input.type.trim() === '') {
    throw new SignalValidationError('Signal type must be a non-empty string');
  }

  if (input.payload === null || input.payload === undefined || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new SignalValidationError('Signal payload must be a plain object (not null, not array)');
  }

  if (input.meta) {
    if (input.meta.deposited_by !== undefined) {
      if (typeof input.meta.deposited_by !== 'string' || input.meta.deposited_by.trim() === '') {
        throw new SignalValidationError('Signal meta.deposited_by must be a non-empty string');
      }
    }

    if (input.meta.concentration !== undefined) {
      if (typeof input.meta.concentration !== 'number' || input.meta.concentration < 0 || input.meta.concentration > 1) {
        throw new SignalValidationError('Signal meta.concentration must be a number between 0 and 1');
      }
    }

    if (input.meta.ttl !== undefined) {
      if (typeof input.meta.ttl !== 'number' || input.meta.ttl <= 0) {
        throw new SignalValidationError('Signal meta.ttl must be a positive number');
      }
    }

    if (input.meta.tags !== undefined) {
      if (!Array.isArray(input.meta.tags) || !input.meta.tags.every(t => typeof t === 'string')) {
        throw new SignalValidationError('Signal meta.tags must be an array of strings');
      }
    }
  }
}

export function validateUpdateInput(
  changes: { payload?: Record<string, unknown>; meta?: { tags?: string[]; concentration?: number } }
): void {
  if (changes.payload !== undefined) {
    if (changes.payload === null || typeof changes.payload !== 'object' || Array.isArray(changes.payload)) {
      throw new SignalValidationError('Update payload must be a plain object (not null, not array)');
    }
  }

  if (changes.meta) {
    if (changes.meta.concentration !== undefined) {
      if (typeof changes.meta.concentration !== 'number' || changes.meta.concentration < 0 || changes.meta.concentration > 1) {
        throw new SignalValidationError('Update meta.concentration must be a number between 0 and 1');
      }
    }

    if (changes.meta.tags !== undefined) {
      if (!Array.isArray(changes.meta.tags) || !changes.meta.tags.every(t => typeof t === 'string')) {
        throw new SignalValidationError('Update meta.tags must be an array of strings');
      }
    }
  }
}
