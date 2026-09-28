import { describe, it, expect } from 'vitest';
import { importErrorMessage } from './importError';

describe('importErrorMessage', () => {
  it('returns the worker catch-path message', () => {
    expect(importErrorMessage({ error: 'value too long for type character varying(255)' })).toBe(
      'value too long for type character varying(255)',
    );
  });

  it('returns the orchestrator timeout message and ignores the extra context', () => {
    expect(
      importErrorMessage({ error: 'orchestrator poll budget exhausted (>72 × 5m)', outcome: 'timeout' }),
    ).toBe('orchestrator poll budget exhausted (>72 × 5m)');
  });

  it('returns null for the validation shape, whose rows the page already lists', () => {
    expect(importErrorMessage({ errors: [{ code: 'INVALID_RANK' }], total: 1 })).toBeNull();
  });

  it('returns null for missing, empty, or non-object values', () => {
    expect(importErrorMessage(null)).toBeNull();
    expect(importErrorMessage(undefined)).toBeNull();
    expect(importErrorMessage('boom')).toBeNull();
    expect(importErrorMessage([{ error: 'x' }])).toBeNull();
    expect(importErrorMessage({ error: '' })).toBeNull();
    expect(importErrorMessage({ error: 42 })).toBeNull();
  });
});
