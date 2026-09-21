import { env } from '@/lib/env';

/** Amendment §3.6. Engineering defaults, not product allowances. */
export interface ResearchLimits {
  /** §3.6 "Search page" default rows. */
  pageSizeDefault: number;
  /** §3.6 "Search page" maximum rows. */
  pageSizeMax: number;
  /** §3.6 "Rows reachable per search (cursor cap)". */
  maxRowsPerSearch: number;
  /** §3.6 "Cursor lifetime": 15 minutes from the first page, in seconds. */
  cursorTtlSeconds: number;
  /** §3.6 "Category candidates" default. */
  categoryCandidatesDefault: number;
  /** §3.6 "Category candidates" maximum. */
  categoryCandidatesMax: number;
  /** §3.6 "Expanded category scope" leaves. */
  maxExpandedLeaves: number;
  /** §3.6 "History" default weeks. */
  historyWeeksDefault: number;
  /** §3.6 "History" maximum weeks. */
  historyWeeksMax: number;
  /** §3.6 "Search / details / history SQL deadline", in ms. */
  sqlTimeoutMs: number;
  /** §3.6 "Category SQL deadline", in ms. */
  categorySqlTimeoutMs: number;
  /** Plan-only (Task 5), not a §3.6 table row: the capped count query's own transaction budget, in ms. */
  countTimeoutMs: number;
  /** §3.6 "Requests per account per rolling minute (all clients)". */
  requestsPerMinute: number;
  /** §3.6 "Rows returned per account per minute". */
  rowsPerMinute: number;
  /** §3.6 "Tool response payload", in bytes. */
  maxPayloadBytes: number;
  /** §3.6 prose (not the table): the dedicated research pool's max connections. */
  poolMax: number;
}

export const DEFAULT_LIMITS: Readonly<ResearchLimits> = Object.freeze({
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

/**
 * Keys RESEARCH_LIMITS_JSON may override. The other six (pageSizeDefault, pageSizeMax,
 * categoryCandidatesDefault, categoryCandidatesMax, historyWeeksDefault, historyWeeksMax)
 * are bound by literal maximums baked into the tool input schemas in contracts.ts
 * (pageSize ≤ 100, category resolve limit ≤ 50, history weeks ≤ 52) — changing the default
 * here without changing the schema would just be overridden per call, and changing the max
 * here would do nothing since the schema still rejects anything past its own literal. An
 * override for one of those six is reported, not silently accepted, and the default is kept.
 */
const OVERRIDABLE = new Set<keyof ResearchLimits>([
  'maxRowsPerSearch',
  'cursorTtlSeconds',
  'maxExpandedLeaves',
  'sqlTimeoutMs',
  'categorySqlTimeoutMs',
  'countTimeoutMs',
  'requestsPerMinute',
  'rowsPerMinute',
  'maxPayloadBytes',
  'poolMax',
]);

/** True for a value this module accepts as a limit override: a safe integer in 1..2147483647. */
function isOverrideValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
}

/**
 * Pure parse of RESEARCH_LIMITS_JSON's raw string into a full ResearchLimits: every key
 * starts at its DEFAULT_LIMITS value and is overridden only when the input supplies a
 * known, overridable key with a valid value. Every rejection — malformed JSON, non-object
 * (including array and null) top-level JSON, an unknown key, a schema-fixed key, or a value
 * that isn't a safe integer in 1..2147483647 — is reported with console.warn and that key's
 * default is kept; this function never throws.
 */
export function parseResearchLimits(raw: string | undefined): ResearchLimits {
  const out: ResearchLimits = { ...DEFAULT_LIMITS };
  if (!raw) return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[research limits] RESEARCH_LIMITS_JSON is not valid JSON — using defaults');
    return out;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[research limits] RESEARCH_LIMITS_JSON must be an object — using defaults');
    return out;
  }

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // Object.hasOwn, never `in`: `in` walks the prototype chain, so keys like `toString`,
    // `constructor` or `__proto__` would read as "known" via Object.prototype even though
    // they are not ResearchLimits fields.
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      console.warn(`[research limits] unknown key ${JSON.stringify(key)} ignored`);
      continue;
    }
    if (!OVERRIDABLE.has(key as keyof ResearchLimits)) {
      console.warn(`[research limits] ${key} is fixed by the tool input schema — ignored`);
      continue;
    }
    if (!isOverrideValue(value)) {
      console.warn(`[research limits] ${key}=${JSON.stringify(value)} must be an integer in 1..2147483647 — default kept`);
      continue;
    }
    out[key as keyof ResearchLimits] = value;
  }
  return out;
}

let cached: ResearchLimits | null = null;

/**
 * The effective limits for this process. Read once per process; env changes need a
 * redeploy, so the lazy pool singleton always sees this process's value — every caller
 * within the same process agrees on the same numbers for the process's whole lifetime.
 * Returns a fresh copy on every call so a caller that mutates its result cannot corrupt
 * the memo or any other caller's copy.
 */
export function researchLimits(): ResearchLimits {
  if (cached === null) cached = parseResearchLimits(env.RESEARCH_LIMITS_JSON);
  return { ...cached };
}

/** Test-only: clears the process memo so the next researchLimits() call reparses env. */
export function resetResearchLimitsForTests(): void {
  cached = null;
}
