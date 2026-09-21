import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const envMock = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);
import { DEFAULT_LIMITS, parseResearchLimits, researchLimits, resetResearchLimitsForTests, type ResearchLimits } from './limits';
import { searchRequestSchema, resolveCategoriesInputSchema, keywordHistoryInputSchema } from './contracts';

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

  it('treats whitespace-only input as unset: defaults, no warning', () => {
    expect(parseResearchLimits(' ')).toEqual(DEFAULT_LIMITS);
    expect(warn).not.toHaveBeenCalled();
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

// Drift guards: DEFAULT_LIMITS has 16 keys, split into ten runtime knobs
// RESEARCH_LIMITS_JSON may override and six bound by literal maximums baked into the tool
// input schemas (see the OVERRIDABLE doc comment in limits.ts). Both guards below fail loudly
// if that split or its schema literals ever drift apart, instead of quietly going stale.
describe('OVERRIDABLE classification (drift guard)', () => {
  // Mirrors the six schema-bound keys named in limits.ts's OVERRIDABLE doc comment. Not
  // imported from limits.ts (that set is private) — this list is the independent half of the
  // guard, so a change to the module's own classification without a matching test update fails.
  const SCHEMA_BOUND = new Set<keyof ResearchLimits>([
    'pageSizeDefault',
    'pageSizeMax',
    'categoryCandidatesDefault',
    'categoryCandidatesMax',
    'historyWeeksDefault',
    'historyWeeksMax',
  ]);
  const keys = Object.keys(DEFAULT_LIMITS) as Array<keyof ResearchLimits>;

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('splits the 16 keys into exactly 10 overridable and 6 schema-bound', () => {
    expect(keys).toHaveLength(16);
    expect(keys.filter((k) => SCHEMA_BOUND.has(k))).toHaveLength(6);
    expect(keys.filter((k) => !SCHEMA_BOUND.has(k))).toHaveLength(10);
  });

  for (const key of keys) {
    if (SCHEMA_BOUND.has(key)) {
      it(`${key}: schema-bound — an override warns and keeps the default`, () => {
        const out = parseResearchLimits(JSON.stringify({ [key]: 7 }));
        expect(out[key]).toBe(DEFAULT_LIMITS[key]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('fixed by the tool input schema');
      });
    } else {
      it(`${key}: overridable — an override of 7 is applied`, () => {
        const out = parseResearchLimits(JSON.stringify({ [key]: 7 }));
        expect(out[key]).toBe(7);
        expect(warn).not.toHaveBeenCalled();
      });
    }
  }
});

describe('schema-bound keys match the tool input schemas (drift guard)', () => {
  const searchTermId = '11111111-1111-4111-8111-111111111111';

  it('searchRequestSchema.pageSize mirrors pageSizeDefault/pageSizeMax', () => {
    expect(searchRequestSchema.parse({ schemaVersion: 1 }).pageSize).toBe(DEFAULT_LIMITS.pageSizeDefault);
    expect(searchRequestSchema.safeParse({ schemaVersion: 1, pageSize: DEFAULT_LIMITS.pageSizeMax }).success).toBe(true);
    expect(searchRequestSchema.safeParse({ schemaVersion: 1, pageSize: DEFAULT_LIMITS.pageSizeMax + 1 }).success).toBe(false);
  });

  it('resolveCategoriesInputSchema.limit mirrors categoryCandidatesDefault/Max', () => {
    expect(resolveCategoriesInputSchema.parse({ source: 'custom' }).limit).toBe(DEFAULT_LIMITS.categoryCandidatesDefault);
    expect(resolveCategoriesInputSchema.safeParse({ source: 'custom', limit: DEFAULT_LIMITS.categoryCandidatesMax }).success).toBe(true);
    expect(resolveCategoriesInputSchema.safeParse({ source: 'custom', limit: DEFAULT_LIMITS.categoryCandidatesMax + 1 }).success).toBe(false);
  });

  it('keywordHistoryInputSchema.weeks mirrors historyWeeksDefault/Max', () => {
    expect(keywordHistoryInputSchema.parse({ searchTermId }).weeks).toBe(DEFAULT_LIMITS.historyWeeksDefault);
    expect(keywordHistoryInputSchema.safeParse({ searchTermId, weeks: DEFAULT_LIMITS.historyWeeksMax }).success).toBe(true);
    expect(keywordHistoryInputSchema.safeParse({ searchTermId, weeks: DEFAULT_LIMITS.historyWeeksMax + 1 }).success).toBe(false);
  });
});
