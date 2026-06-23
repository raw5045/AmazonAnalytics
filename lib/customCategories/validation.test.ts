import { describe, it, expect } from 'vitest';
import { validateName, normalizeLeafNames, MAX_CUSTOM_CATEGORIES } from './validation';

describe('validateName', () => {
  it('trims and accepts a normal name', () => {
    expect(validateName('  Supplements ')).toEqual({ ok: true, name: 'Supplements' });
  });
  it('rejects empty', () => { expect(validateName('   ').ok).toBe(false); });
  it('rejects > 80 chars', () => { expect(validateName('x'.repeat(81)).ok).toBe(false); });
  it('rejects non-strings', () => { expect(validateName(42).ok).toBe(false); });
});

describe('normalizeLeafNames', () => {
  it('dedupes, drops blanks, keeps order of first occurrence', () => {
    expect(normalizeLeafNames(['Collagen', 'Iron', 'Collagen', '', '  '])).toEqual(['Collagen', 'Iron']);
  });
  it('returns [] for non-arrays', () => { expect(normalizeLeafNames('nope')).toEqual([]); });
  it('drops non-string members', () => { expect(normalizeLeafNames(['Collagen', 5, null])).toEqual(['Collagen']); });
});

describe('limits', () => {
  it('cap is 25', () => expect(MAX_CUSTOM_CATEGORIES).toBe(25));
});
