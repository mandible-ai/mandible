// PURPOSE: Tests for signal validation at deposit and update time.
// PURPOSE: The validator must accept whatever the hosted signal server accepts.

import { describe, it, expect } from 'vitest';
import { validateSignalInput, validateUpdateInput, SignalValidationError } from '../../src/core/validation.js';

const base = { type: 'task:ready', payload: {} };

describe('validateSignalInput — concentration', () => {
  it('accepts any finite concentration of 0 or more, including above 1', () => {
    for (const concentration of [0, 0.5, 1, 1.5, 1_000_000]) {
      expect(() => validateSignalInput({ ...base, meta: { concentration } })).not.toThrow();
    }
  });

  it('rejects a negative, non-finite, or non-numeric concentration', () => {
    for (const concentration of [-0.1, Number.NaN, Number.POSITIVE_INFINITY, '1' as unknown as number]) {
      expect(() => validateSignalInput({ ...base, meta: { concentration } })).toThrow(SignalValidationError);
    }
  });
});

describe('validateSignalInput — persistent', () => {
  it('accepts a boolean persistent flag', () => {
    expect(() => validateSignalInput({ ...base, meta: { persistent: true } })).not.toThrow();
    expect(() => validateSignalInput({ ...base, meta: { persistent: false } })).not.toThrow();
    expect(() => validateSignalInput({ ...base, meta: {} })).not.toThrow();
  });

  it('rejects a non-boolean persistent flag', () => {
    for (const persistent of ['true', 1, null]) {
      expect(() => validateSignalInput({ ...base, meta: { persistent: persistent as unknown as boolean } }))
        .toThrow(/meta\.persistent must be a boolean/);
    }
  });
});

describe('validateUpdateInput — concentration', () => {
  it('accepts a concentration above 1', () => {
    expect(() => validateUpdateInput({ meta: { concentration: 5 } })).not.toThrow();
  });

  it('rejects a negative concentration', () => {
    expect(() => validateUpdateInput({ meta: { concentration: -1 } })).toThrow(SignalValidationError);
  });
});
