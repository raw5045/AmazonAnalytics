import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const envMock = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);
import { DEFAULT_LIMITS, parseResearchLimits, researchLimits, resetResearchLimitsForTests } from './limits';

describe('parseResearchLimits', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('returns the amendment §3.6 defaults for undefined or empty input', () => {
    const defaults = {
      pageSizeDefault: 50,
      pageSizeMax: 100,
      maxRowsPerSearch: 1000,
      cursorTtlSeconds: 900,
      categoryCandidatesDefault: 20,
      categoryCandidatesMax: 50,
      maxExpandedLeaves: 2000,
      historyWeeksDefault: 13,
      historyWeeksMax: 52,
      sqlTimeoutMs: 10000,
      categorySqlTimeoutMs: 3000,
      countTimeoutMs: 3000,
      requestsPerMinute: 60,
      rowsPerMinute: 6000,
      maxPayloadBytes: 262144,
      poolMax: 4,
    };
    expect(DEFAULT_LIMITS).toEqual(defaults);
    expect(parseResearchLimits(undefined)).toEqual(defaults);
    expect(parseResearchLimits('')).toEqual(defaults);
  });

  it('overrides overridable keys and warns exactly once each for an unknown key and a non-integer value', () => {
    const out = parseResearchLimits(JSON.stringify({ requestsPerMinute: 120, bogus: 1, sqlTimeoutMs: 'fast' }));
    expect(out).toEqual({ ...DEFAULT_LIMITS, requestsPerMinute: 120 });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('bogus'))).toBe(true);
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('sqlTimeoutMs'))).toBe(true);
  });

  it('ignores malformed JSON with a single warning and returns the defaults', () => {
    expect(parseResearchLimits('{not json')).toEqual(DEFAULT_LIMITS);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects non-object top-level JSON — arrays, null, and a bare scalar — with one warning each', () => {
    for (const bad of ['[]', 'null', '42']) {
      warn.mockClear();
      expect(parseResearchLimits(bad)).toEqual(DEFAULT_LIMITS);
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects prototype-chain keys via Object.hasOwn instead of `in`, without touching the prototype', () => {
    // A literal JSON string, not JSON.stringify({ __proto__: 9, ... }): in a JS object
    // *literal*, `__proto__: 9` is grammar-special-cased and (since 9 isn't an object)
    // silently creates no property at all, so JSON.stringify would never round-trip the
    // key. JSON.parse has no such special case — it defines "__proto__" as an ordinary
    // own data property — so a literal JSON string is the only way to construct the case
    // Object.hasOwn (vs. `in`) actually needs to guard against.
    const out = parseResearchLimits('{"toString":7,"constructor":5,"__proto__":9}');
    expect(out).toEqual(DEFAULT_LIMITS);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(Object.hasOwn(out, 'toString')).toBe(false);
  });

  it('accepts only safe integers in 1..2147483647, warning and keeping the default for anything else', () => {
    for (const bad of [0, -1, 1.5, '120', 9007199254740993, 2147483648]) {
      warn.mockClear();
      const out = parseResearchLimits(JSON.stringify({ requestsPerMinute: bad }));
      expect(out.requestsPerMinute).toBe(DEFAULT_LIMITS.requestsPerMinute);
      expect(warn).toHaveBeenCalledTimes(1);
    }
    expect(parseResearchLimits(JSON.stringify({ requestsPerMinute: 2147483647 })).requestsPerMinute).toBe(2147483647);
  });

  it('warns that a schema-bound key is fixed by the tool input schema and keeps its default', () => {
    const out = parseResearchLimits(JSON.stringify({ pageSizeMax: 500 }));
    expect(out.pageSizeMax).toBe(100);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('fixed by the tool input schema');
  });
});

describe('researchLimits', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    envMock.env = {};
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetResearchLimitsForTests();
  });
  afterEach(() => warn.mockRestore());

  it('returns equal but non-identical objects on two calls, and mutating one does not affect the next', () => {
    const a = researchLimits();
    const b = researchLimits();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    (a as { requestsPerMinute: number }).requestsPerMinute = 999;
    expect(researchLimits().requestsPerMinute).toBe(DEFAULT_LIMITS.requestsPerMinute);
  });

  it('parses RESEARCH_LIMITS_JSON once per process: three calls warn once, not three times', () => {
    envMock.env.RESEARCH_LIMITS_JSON = '{not json';
    researchLimits();
    researchLimits();
    researchLimits();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
