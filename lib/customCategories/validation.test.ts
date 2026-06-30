import { describe, it, expect } from 'vitest';
import { validateName, normalizePaths, MAX_CUSTOM_CATEGORIES } from './validation';

describe('validateName', () => {
  it('trims and accepts a normal name', () => {
    expect(validateName('  Supplements ')).toEqual({ ok: true, name: 'Supplements' });
  });
  it('rejects empty', () => { expect(validateName('   ').ok).toBe(false); });
  it('rejects > 80 chars', () => { expect(validateName('x'.repeat(81)).ok).toBe(false); });
  it('rejects non-strings', () => { expect(validateName(42).ok).toBe(false); });
});

describe('normalizePaths', () => {
  it('dedupes, drops blanks, keeps order of first occurrence', () => {
    expect(normalizePaths(['Collagen', 'Iron', 'Collagen', '', '  '])).toEqual(['Collagen', 'Iron']);
  });
  it('returns [] for non-arrays', () => { expect(normalizePaths('nope')).toEqual([]); });
  it('drops non-string members', () => { expect(normalizePaths(['Collagen', 5, null])).toEqual(['Collagen']); });
  it('keeps full paths intact (no splitting)', () =>
    expect(normalizePaths(['A › B › C', 'A › B › C', 'X › Y'])).toEqual(['A › B › C', 'X › Y']));
});

describe('limits', () => {
  it('cap is 25', () => expect(MAX_CUSTOM_CATEGORIES).toBe(25));
});
