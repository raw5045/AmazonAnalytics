import { env } from '@/lib/env';

/** Amendment §3.6. Engineering defaults, not product allowances. */
export interface ResearchLimits {
  pageSizeDefault: number;
  pageSizeMax: number;
  maxRowsPerSearch: number;
  cursorTtlSeconds: number;
  categoryCandidatesDefault: number;
  categoryCandidatesMax: number;
  maxExpandedLeaves: number;
  historyWeeksDefault: number;
  historyWeeksMax: number;
  sqlTimeoutMs: number;
  categorySqlTimeoutMs: number;
  countTimeoutMs: number;
  requestsPerMinute: number;
  rowsPerMinute: number;
  maxPayloadBytes: number;
  poolMax: number;
}

export const DEFAULT_LIMITS: ResearchLimits = Object.freeze({
  pageSizeDefault: 50,
  pageSizeMax: 100,
  maxRowsPerSearch: 1000,
  cursorTtlSeconds: 900,
  categoryCandidatesDefault: 20,
  categoryCandidatesMax: 50,
  maxExpandedLeaves: 2000,
  historyWeeksDefault: 13,
  historyWeeksMax: 52,
  sqlTimeoutMs: 10_000,
  categorySqlTimeoutMs: 3_000,
  countTimeoutMs: 3_000,
  requestsPerMinute: 60,
  rowsPerMinute: 6_000,
  maxPayloadBytes: 256 * 1024,
  poolMax: 4,
});

/** Defaults overlaid with any positive-integer keys from RESEARCH_LIMITS_JSON; anything else is ignored with a warning. */
export function researchLimits(): ResearchLimits {
  const raw = env.RESEARCH_LIMITS_JSON;
  if (!raw) return { ...DEFAULT_LIMITS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[research limits] RESEARCH_LIMITS_JSON is not valid JSON — using defaults');
    return { ...DEFAULT_LIMITS };
  }
  const out: ResearchLimits = { ...DEFAULT_LIMITS };
  if (!parsed || typeof parsed !== 'object') {
    console.warn('[research limits] RESEARCH_LIMITS_JSON must be an object — using defaults');
    return out;
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(key in DEFAULT_LIMITS)) { console.warn(`[research limits] unknown key ${key} ignored`); continue; }
    if (!Number.isInteger(value) || (value as number) <= 0) { console.warn(`[research limits] ${key} must be a positive integer — default kept`); continue; }
    (out as unknown as Record<string, number>)[key] = value as number;
  }
  return out;
}
