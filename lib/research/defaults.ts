/** The workspace daily write cap (spec 2026-09-30 §8.2): RESEARCH_LIMITS_JSON can override the live cap on Vercel, the digest on Railway only ever sees this default. Import-free, so the digest can read it without loading lib/env. */
export const DEFAULT_WRITES_PER_DAY = 200;
