import { describe, it, expect } from 'vitest';
import { validateFeedback, normalizePage } from './validate';

describe('validateFeedback', () => {
  const good = { message: 'The word-count filter feels slow on big categories.', page: '/explorer?words_min=3' };

  it('accepts a normal submission (message trimmed, page kept)', () => {
    expect(validateFeedback({ ...good, message: `  ${good.message}  ` })).toEqual({ ok: true, input: good });
  });
  it('rejects non-object payloads', () => {
    expect(validateFeedback(null).ok).toBe(false);
    expect(validateFeedback('hi').ok).toBe(false);
  });
  it('rejects a missing or short message', () => {
    expect(validateFeedback({ page: '/x' }).ok).toBe(false);
    expect(validateFeedback({ message: 'too short' }).ok).toBe(false);
  });
  it('rejects a message over 5,000 characters', () => {
    expect(validateFeedback({ message: 'x'.repeat(5001) }).ok).toBe(false);
  });
  it('accepts exactly 10 and exactly 5,000 characters', () => {
    expect(validateFeedback({ message: 'x'.repeat(10) }).ok).toBe(true);
    expect(validateFeedback({ message: 'x'.repeat(5000) }).ok).toBe(true);
  });
  it('nulls (does not reject) a missing or unusable page', () => {
    expect(validateFeedback({ message: good.message })).toEqual({ ok: true, input: { message: good.message, page: null } });
    expect(validateFeedback({ message: good.message, page: 'https://evil.example' })).toEqual({
      ok: true,
      input: { message: good.message, page: null },
    });
  });
});

describe('normalizePage', () => {
  it('keeps an in-app relative path with a query string', () => {
    expect(normalizePage('/explorer?rank_max=100&severity=none')).toBe('/explorer?rank_max=100&severity=none');
  });
  it('trims surrounding whitespace', () => {
    expect(normalizePage('  /watchlist ')).toBe('/watchlist');
  });
  it('rejects absolute and protocol-relative URLs', () => {
    expect(normalizePage('https://evil.example/x')).toBeNull();
    expect(normalizePage('//evil.example/x')).toBeNull();
  });
  it('rejects paths with embedded whitespace or control characters', () => {
    expect(normalizePage('/explorer?q=a b')).toBeNull();
    // Control characters that \s does NOT match (NUL, ESC) — exercises \p{Cc}.
    expect(normalizePage(`/explorer?q=a${String.fromCodePoint(0)}b`)).toBeNull();
    expect(normalizePage(`/explorer?q=a${String.fromCodePoint(0x1b)}b`)).toBeNull();
    expect(normalizePage('/explorer\n?x=1')).toBeNull();
  });
  it('rejects paths with format characters (zero-width space, bidi override)', () => {
    expect(normalizePage(`/explorer?q=a${String.fromCodePoint(0x200b)}b`)).toBeNull();
    expect(normalizePage(`/explorer?q=a${String.fromCodePoint(0x202e)}b`)).toBeNull();
  });
  it('rejects non-strings, empty strings, and paths over 2,000 characters', () => {
    expect(normalizePage(undefined)).toBeNull();
    expect(normalizePage(42)).toBeNull();
    expect(normalizePage('')).toBeNull();
    expect(normalizePage('/' + 'x'.repeat(2000))).toBeNull();
  });
});
