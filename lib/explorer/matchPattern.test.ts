import { describe, it, expect } from 'vitest';
import { escapeRegex, escapeLike, wordPattern, broadPattern } from './matchPattern';

describe('escapeRegex', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegex('c++')).toBe('c\\+\\+');
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
    expect(escapeRegex('(x)|[y]')).toBe('\\(x\\)\\|\\[y\\]');
  });
  it('leaves plain words + spaces untouched', () => {
    expect(escapeRegex('hair growth')).toBe('hair growth');
  });
});

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape char', () => {
    expect(escapeLike('50%')).toBe('50\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('a\\b')).toBe('a\\\\b');
  });
  it('leaves plain text untouched', () => {
    expect(escapeLike('hair growth')).toBe('hair growth');
  });
});

describe('wordPattern', () => {
  it('wraps a lowercased, escaped term in word boundaries', () => {
    expect(wordPattern('Hair')).toBe('\\mhair\\M');
    expect(wordPattern('C++')).toBe('\\mc\\+\\+\\M');
  });
  it('keeps internal spaces for phrase matching', () => {
    expect(wordPattern('Hair Growth')).toBe('\\mhair growth\\M');
  });
});

describe('broadPattern', () => {
  it('wraps a lowercased, escaped term in % wildcards', () => {
    expect(broadPattern('Hair')).toBe('%hair%');
    expect(broadPattern('50%')).toBe('%50\\%%');
  });
});
