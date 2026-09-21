import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const envMock = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('@/lib/env', () => envMock);
import { DEFAULT_LIMITS, researchLimits } from './limits';

describe('researchLimits', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { envMock.env = {}; warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  it('returns the amendment §3.6 defaults', () => {
    expect(researchLimits()).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS).toMatchObject({ pageSizeDefault: 50, pageSizeMax: 100, maxRowsPerSearch: 1000, cursorTtlSeconds: 900, requestsPerMinute: 60, rowsPerMinute: 6000, sqlTimeoutMs: 10000, categorySqlTimeoutMs: 3000, countTimeoutMs: 3000, maxPayloadBytes: 262144, maxExpandedLeaves: 2000, historyWeeksMax: 52 });
  });
  it('overrides known keys from RESEARCH_LIMITS_JSON and ignores unknown or non-integer ones with a warning', () => {
    envMock.env.RESEARCH_LIMITS_JSON = JSON.stringify({ requestsPerMinute: 120, bogus: 1, sqlTimeoutMs: 'fast' });
    const l = researchLimits();
    expect(l.requestsPerMinute).toBe(120);
    expect(l.sqlTimeoutMs).toBe(10000);
    expect(warn).toHaveBeenCalled();
  });
  it('ignores malformed JSON with a warning', () => {
    envMock.env.RESEARCH_LIMITS_JSON = '{not json';
    expect(researchLimits()).toEqual(DEFAULT_LIMITS);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
