# Loose title-match rework — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two correctness bugs in our loose title-match SQL (apostrophe drift, no plural handling) and dramatically speed up the historical backfill from ~13 hours to ≤3 hours via title-token caching + strict-true shortcut + count-based resume marker.

**Architecture:** Move loose-match logic from inline regex SQL into a small set of `IMMUTABLE` Postgres functions. Use `search_terms.search_term_normalized` as the search-side canonical input. Generate per-token plural candidate forms (e.g. `supplements → {supplements, supplement}`) symmetrically on both sides. New backfill script caches the per-distinct-title normalization in a per-week temp table, skips rows where Amazon's strict flag is already TRUE, and uses `keyword_title_match_count_loose IS NULL` as a stable resume marker.

**Tech Stack:** Postgres 17 (Neon), node-postgres (pg) TCP driver for backfill, drizzle-kit for migration scaffolding, vitest for unit tests.

---

## Context — what we're fixing

The codebase has loose title-match logic in two places:
1. **Import path** (`inngest/functions/importFile.ts`) — `looseFlagSqlFragment` inlined into the INSERT that fills `keyword_weekly_metrics` from staging.
2. **Backfill script** (`scripts/backfillKwmLooseFlags.ts`) — same fragment, used to populate the four loose columns we just added in migration 0014.

Two bugs in the current fragment:
- **Apostrophe drift:** `"beekeeper's"` tokenizes to `["beekeeper", "s"]` in SQL but to `["beekeepers"]` in JS `normalizeForMatch`. The loose check then requires the title to contain `"s"` as a whole word — works by accident on most titles but for the wrong reason.
- **No plural handling:** `"creatine supplements"` does not match `"creatine gummies supplement"`.

Plus a real bug in the resume marker: `WHERE keyword_in_title_1_loose IS NULL` re-selects rows where title #1 is genuinely NULL (since NULL is the correct stable result) — those rows can never advance.

Plus a missing perf opportunity: same product titles repeat across many keywords in a week, so we're tokenizing the same titles millions of times.

---

## File Structure

**Created:**
- `lib/analytics/looseMatch.ts` — JS port of the rules. Two functions:
  - `looseTokenForms(token: string): string[]` — single token → plural candidate array
  - `looseMatch(searchTermNormalized: string, title: string | null): boolean | null` — full pipeline
- `lib/analytics/looseMatch.test.ts` — vitest unit tests covering fixtures
- `db/migrations/0015_loose_match_functions.sql` — five `IMMUTABLE` Postgres functions
- `scripts/verifyLooseMatchSql.ts` — runs the same fixtures against deployed SQL and asserts JS-SQL agreement
- `scripts/resetSixBuggyLooseWeeks.ts` — clears loose columns on the 6 weeks backfilled with old (buggy) SQL

**Modified:**
- `inngest/functions/importFile.ts` — `looseFlagSqlFragment` rewritten to call new Postgres functions; threading `search_term_normalized` through the CTEs
- `scripts/backfillKwmLooseFlags.ts` — completely rewritten: per-week temp title cache, materialized CTE, strict-true shortcut, count-based resume marker

**Test infrastructure** (already exists, just consuming):
- `lib/analytics/derivedFields.test.ts` — pattern reference for vitest tests in this codebase

---

## Plural rule reference (locked-in spec)

Each token T is expanded to a candidate set:

```
if length(T) > 4 AND T ends with 'ies':
  candidates = [T, replace 'ies' with 'y', replace 'ies' with 'ie']
  // gummies   → {gummies, gummy, gummie}
  // calories  → {calories, calory, calorie}
  // batteries → {batteries, battery, batterie}

elif T ends with one of (sses, xes, zes, shes, ches):
  candidates = [T, strip trailing 'es']
  // boxes   → {boxes, box}
  // brushes → {brushes, brush}
  // glasses → {glasses, glass}

elif length(T) > 3 AND T ends with 's'
     AND T does NOT end with ('ss', 'us', 'is')
     AND T is NOT in {gas, news, hers, ours, yours, lens, series, species, keys}:
  candidates = [T, strip trailing 's']
  // supplements → {supplements, supplement}
  // powders     → {powders, powder}
  // teas        → {teas, tea}
  // boys        → {boys, boy}

else:
  candidates = [T]
  // creatine → {creatine}
  // stress   → {stress}     (ends in 'ss')
  // virus    → {virus}      (ends in 'us')
  // analysis → {analysis}   (ends in 'is')
  // gas      → {gas}        (exact exception)
```

**Match rule:** A search token matches a title if any of the search token's candidate forms is present in the title's union-of-all-candidates set. Every non-stopword search token must match for the row to be loose-true.

**Stopwords (unchanged):** `a, an, and, are, as, at, be, by, for, from, has, have, in, is, it, its, of, on, or, that, the, this, to, with`

---

## Task 1: JS implementation of plural rules

**Files:**
- Create: `lib/analytics/looseMatch.ts`
- Test: `lib/analytics/looseMatch.test.ts`

This serves as the executable spec for the SQL. We unit-test the rules in JS for fast iteration; later tasks verify the SQL matches.

- [ ] **Step 1.1: Write the failing test**

Create `lib/analytics/looseMatch.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { looseTokenForms, looseMatch } from './looseMatch';

describe('looseTokenForms', () => {
  // -ies cascade
  it('expands -ies plurals', () => {
    expect(looseTokenForms('gummies')).toEqual(['gummies', 'gummy', 'gummie']);
    expect(looseTokenForms('batteries')).toEqual(['batteries', 'battery', 'batterie']);
    expect(looseTokenForms('calories')).toEqual(['calories', 'calory', 'calorie']);
  });
  it('does not expand short -ies words', () => {
    expect(looseTokenForms('dies')).toEqual(['dies']); // length 4, not > 4
    expect(looseTokenForms('ties')).toEqual(['ties']);
  });

  // -es family
  it('strips -es after sibilant clusters', () => {
    expect(looseTokenForms('boxes')).toEqual(['boxes', 'box']);
    expect(looseTokenForms('brushes')).toEqual(['brushes', 'brush']);
    expect(looseTokenForms('glasses')).toEqual(['glasses', 'glass']);
    expect(looseTokenForms('quizzes')).toEqual(['quizzes', 'quiz']);
    expect(looseTokenForms('benches')).toEqual(['benches', 'bench']);
  });

  // -s strip (the big domain win)
  it('strips trailing -s for regular plurals', () => {
    expect(looseTokenForms('supplements')).toEqual(['supplements', 'supplement']);
    expect(looseTokenForms('powders')).toEqual(['powders', 'powder']);
    expect(looseTokenForms('bars')).toEqual(['bars', 'bar']);
    expect(looseTokenForms('teas')).toEqual(['teas', 'tea']);
    expect(looseTokenForms('fibers')).toEqual(['fibers', 'fiber']);
    expect(looseTokenForms('boys')).toEqual(['boys', 'boy']);
  });

  // Suffix guards
  it('does not strip -ss', () => {
    expect(looseTokenForms('stress')).toEqual(['stress']);
    expect(looseTokenForms('class')).toEqual(['class']);
    expect(looseTokenForms('miss')).toEqual(['miss']);
  });
  it('does not strip -us', () => {
    expect(looseTokenForms('virus')).toEqual(['virus']);
    expect(looseTokenForms('focus')).toEqual(['focus']);
    expect(looseTokenForms('bonus')).toEqual(['bonus']);
  });
  it('does not strip -is', () => {
    expect(looseTokenForms('analysis')).toEqual(['analysis']);
    expect(looseTokenForms('crisis')).toEqual(['crisis']);
    expect(looseTokenForms('arthritis')).toEqual(['arthritis']);
  });

  // Exact exceptions
  it('keeps explicit non-plural words intact', () => {
    expect(looseTokenForms('gas')).toEqual(['gas']);
    expect(looseTokenForms('news')).toEqual(['news']);
    expect(looseTokenForms('hers')).toEqual(['hers']);
    expect(looseTokenForms('series')).toEqual(['series']);
    expect(looseTokenForms('species')).toEqual(['species']);
    expect(looseTokenForms('lens')).toEqual(['lens']);
  });

  // Length guards
  it('does not strip very short tokens', () => {
    expect(looseTokenForms('is')).toEqual(['is']);
    expect(looseTokenForms('as')).toEqual(['as']);
    expect(looseTokenForms('us')).toEqual(['us']);
  });

  // Non-plural words
  it('leaves non-plural words alone', () => {
    expect(looseTokenForms('creatine')).toEqual(['creatine']);
    expect(looseTokenForms('magnesium')).toEqual(['magnesium']);
  });
});

describe('looseMatch (end-to-end)', () => {
  it('matches the motivating example: plural search vs singular title', () => {
    expect(looseMatch('creatine supplements', 'Creatine Gummies Supplement')).toBe(true);
  });
  it('matches singular search vs plural title', () => {
    expect(looseMatch('creatine supplement', 'Creatine Supplements')).toBe(true);
  });
  it('matches "Creatine Gummies" vs "Creatine Sugar Free Gummies"', () => {
    expect(looseMatch('creatine gummies', 'Creatine Sugar Free Gummies')).toBe(true);
  });
  it('matches with apostrophes in search term', () => {
    // Note: input is search_term_normalized form, so apostrophes already stripped.
    expect(looseMatch('beekeepers honey', "Beekeeper's Naturals Honey Spray")).toBe(true);
  });
  it('matches with hyphenated title', () => {
    expect(looseMatch('creatine gummies', 'Pure Creatine-Gummies 60ct')).toBe(true);
  });
  it('returns null when title is null', () => {
    expect(looseMatch('anything', null)).toBe(null);
  });
  it('returns false when title omits a required token', () => {
    expect(looseMatch('magnesium glycinate', 'Vitamin C Gummies')).toBe(false);
  });
  it('ignores stopwords on the search side', () => {
    expect(looseMatch('the best protein', 'Premium Protein Powder')).toBe(true);
  });
  it('handles powder/powders correctly', () => {
    expect(looseMatch('protein powders', 'Premium Protein Powder')).toBe(true);
    expect(looseMatch('protein powder', 'Premium Protein Powders')).toBe(true);
  });
  it('handles tea/teas', () => {
    expect(looseMatch('green teas', 'Premium Green Tea Bags')).toBe(true);
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `pnpm vitest run lib/analytics/looseMatch.test.ts`
Expected: FAIL with "Cannot find module './looseMatch'"

- [ ] **Step 1.3: Implement `looseMatch.ts`**

Create `lib/analytics/looseMatch.ts`:

```typescript
/**
 * Loose title-match: every non-stopword token in the search term must
 * appear (as a whole word, possibly via a plural-candidate form) in the
 * product title. Order-independent; words in between are fine.
 *
 * Search side input: `search_term_normalized` (already lowercased,
 * apostrophe-stripped, alphanumeric-and-space). See `normalizeForMatch`
 * in `derivedFields.ts`.
 *
 * Title side input: raw title text. We normalize here.
 *
 * Mirrors the Postgres `loose_match` function (migration 0015). See
 * `scripts/verifyLooseMatchSql.ts` for the JS-SQL agreement check.
 */

const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','by','for','from','has','have',
  'in','is','it','its','of','on','or','that','the','this','to','with',
]);

const NO_STRIP_EXCEPTIONS = new Set([
  'gas','news','hers','ours','yours','lens','series','species','keys',
]);

/**
 * Generate the plural candidate set for a single normalized token.
 * Always includes the original. Returned in deterministic order:
 * original first, then derived forms.
 */
export function looseTokenForms(token: string): string[] {
  if (!token) return [];
  if (token.length > 4 && token.endsWith('ies')) {
    const stem = token.slice(0, -3);
    return [token, `${stem}y`, `${stem}ie`];
  }
  if (/(sses|xes|zes|shes|ches)$/.test(token)) {
    return [token, token.slice(0, -2)];
  }
  if (
    token.length > 3
    && token.endsWith('s')
    && !/(ss|us|is)$/.test(token)
    && !NO_STRIP_EXCEPTIONS.has(token)
  ) {
    return [token, token.slice(0, -1)];
  }
  return [token];
}

/**
 * Normalize a raw title to the same shape as `search_term_normalized`:
 *   - lowercase
 *   - drop apostrophes (curly + straight)
 *   - non-alphanumeric → space
 *   - collapse whitespace
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Tokenize + apply plural-candidate expansion + flatten to a Set.
 * Used for the title side. Returns the union of all candidate forms
 * across all tokens.
 */
function titleForms(title: string): Set<string> {
  const normalized = normalizeTitle(title);
  const forms = new Set<string>();
  for (const tok of normalized.split(' ')) {
    if (!tok) continue;
    for (const f of looseTokenForms(tok)) forms.add(f);
  }
  return forms;
}

/**
 * Get the set of search-side tokens after stopword filtering.
 * Input must already be in `search_term_normalized` form.
 */
function searchTokens(normalizedTerm: string): string[] {
  return normalizedTerm
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t));
}

/**
 * Full pipeline: return true iff every required search token (or one
 * of its candidate forms) appears in the title's form set.
 * Returns null when title is null.
 */
export function looseMatch(searchTermNormalized: string, title: string | null): boolean | null {
  if (title === null || title === undefined) return null;
  const tokens = searchTokens(searchTermNormalized);
  if (tokens.length === 0) return false;
  const forms = titleForms(title);
  for (const tok of tokens) {
    const candidates = looseTokenForms(tok);
    if (!candidates.some((c) => forms.has(c))) return false;
  }
  return true;
}
```

- [ ] **Step 1.4: Run the test to verify it passes**

Run: `pnpm vitest run lib/analytics/looseMatch.test.ts`
Expected: PASS, all ~24 tests green.

- [ ] **Step 1.5: Commit**

```bash
git add lib/analytics/looseMatch.ts lib/analytics/looseMatch.test.ts
git commit -m "feat(analytics): loose title-match with plural candidates (JS spec)

JS implementation of the new loose-match algorithm: apostrophe-stripped
search-term tokens checked against a union of plural-candidate forms
generated from the title. Serves as the executable spec for the SQL
implementation (migration 0015) and for the verification script that
cross-checks JS vs SQL behavior."
```

---

## Task 2: Postgres immutable functions (migration 0015)

**Files:**
- Create: `db/migrations/0015_loose_match_functions.sql`

We add five `IMMUTABLE PARALLEL SAFE` functions. They mirror `looseMatch.ts` exactly. The match function takes pre-tokenized inputs so the backfill can cache them per distinct title.

- [ ] **Step 2.1: Write the migration**

Create `db/migrations/0015_loose_match_functions.sql`:

```sql
-- Postgres-side implementation of the loose title-match algorithm
-- defined in lib/analytics/looseMatch.ts. Five IMMUTABLE functions:
--
--   loose_token_forms(token text) → text[]
--     Single normalized token → array of plural-candidate forms
--     (always includes the original).
--
--   loose_title_forms(title text) → text[]
--     Raw title → set (array of distinct values) of all candidate forms
--     across all tokenized words. NULL → NULL.
--
--   loose_search_tokens(normalized_term text) → text[]
--     search_term_normalized → array of non-stopword tokens.
--
--   loose_match(search_tokens text[], title_forms text[]) → boolean
--     Returns true iff every search token (via any of its candidate
--     forms) appears in title_forms. Returns NULL when title_forms is
--     NULL. Built for the backfill / import path where the inputs are
--     precomputed once per distinct title.
--
--   loose_match_raw(search_term_normalized text, title text) → boolean
--     Convenience wrapper. Slower (no caching); used in tests and
--     ad-hoc queries.
--
-- The function bodies mirror the rules in lib/analytics/looseMatch.ts;
-- scripts/verifyLooseMatchSql.ts cross-checks them on the JS fixtures.

CREATE OR REPLACE FUNCTION loose_token_forms(token text)
RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN token IS NULL OR token = '' THEN
      ARRAY[]::text[]
    WHEN length(token) > 4 AND token ~ 'ies$' THEN
      ARRAY[
        token,
        substring(token from 1 for length(token) - 3) || 'y',
        substring(token from 1 for length(token) - 3) || 'ie'
      ]
    WHEN token ~ '(sses|xes|zes|shes|ches)$' THEN
      ARRAY[token, substring(token from 1 for length(token) - 2)]
    WHEN length(token) > 3
         AND token ~ 's$'
         AND token !~ '(ss|us|is)$'
         AND token <> ALL(ARRAY[
           'gas','news','hers','ours','yours','lens',
           'series','species','keys'
         ]) THEN
      ARRAY[token, substring(token from 1 for length(token) - 1)]
    ELSE
      ARRAY[token]
  END;
$$;

CREATE OR REPLACE FUNCTION loose_title_forms(title text)
RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN title IS NULL THEN NULL
    ELSE (
      SELECT COALESCE(array_agg(DISTINCT form), ARRAY[]::text[])
      FROM (
        SELECT unnest(loose_token_forms(trim(t))) AS form
        FROM unnest(string_to_array(
          regexp_replace(
            regexp_replace(LOWER(title), '[''’]', '', 'g'),
            '[^a-z0-9]+', ' ', 'g'
          ),
          ' '
        )) AS t
        WHERE trim(t) <> ''
      ) sub
    )
  END;
$$;

CREATE OR REPLACE FUNCTION loose_search_tokens(normalized_term text)
RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  WITH tokens AS (
    SELECT DISTINCT trim(t) AS tok
    FROM unnest(string_to_array(COALESCE(normalized_term, ''), ' ')) AS t
    WHERE trim(t) <> ''
      AND trim(t) NOT IN (
        'a','an','and','are','as','at','be','by','for','from','has',
        'have','in','is','it','its','of','on','or','that','the',
        'this','to','with'
      )
  )
  SELECT COALESCE(array_agg(tok), ARRAY[]::text[]) FROM tokens;
$$;

CREATE OR REPLACE FUNCTION loose_match(search_tokens text[], title_forms text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN title_forms IS NULL THEN NULL
    WHEN search_tokens IS NULL OR cardinality(search_tokens) = 0 THEN FALSE
    ELSE NOT EXISTS (
      SELECT 1 FROM unnest(search_tokens) AS st
      WHERE NOT (loose_token_forms(st) && title_forms)
    )
  END;
$$;

CREATE OR REPLACE FUNCTION loose_match_raw(search_term_normalized text, title text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT loose_match(
    loose_search_tokens(search_term_normalized),
    loose_title_forms(title)
  );
$$;
```

- [ ] **Step 2.2: Update the drizzle migration journal**

Append the new migration to `db/migrations/meta/_journal.json` (drizzle-kit doesn't auto-detect hand-rolled SQL files). Look at the existing entries to copy the format; bump `idx` to the next integer after the 0014 entry and use a tag matching the filename.

If unsure of the format, run: `Read C:\Users\raw50\Amazon Keyword Analytics\db\migrations\meta\_journal.json` and add an entry mirroring the 0014 row.

- [ ] **Step 2.3: Apply the migration locally**

Run: `pnpm db:migrate`
Expected output: "0015_loose_match_functions applied" (or equivalent confirmation from drizzle-kit).

- [ ] **Step 2.4: Smoke test the functions in `psql` or a quick script**

Create a one-off test query (don't commit) to spot-check:

```sql
SELECT loose_token_forms('supplements');   -- {supplements,supplement}
SELECT loose_token_forms('gummies');       -- {gummies,gummy,gummie}
SELECT loose_token_forms('stress');        -- {stress}
SELECT loose_token_forms('keys');          -- {keys}
SELECT loose_title_forms('Creatine Sugar Free Gummies');
  -- expect: {creatine,sugar,free,gummies,gummy,gummie}
SELECT loose_search_tokens('the best creatine gummies');
  -- expect: {best,creatine,gummies}
SELECT loose_match_raw('creatine supplements', 'Creatine Gummies Supplement');
  -- expect: t
SELECT loose_match_raw('creatine gummies', 'Creatine Sugar Free Gummies');
  -- expect: t
SELECT loose_match_raw('magnesium glycinate', 'Vitamin C Gummies');
  -- expect: f
SELECT loose_match_raw('anything', NULL);
  -- expect: NULL
```

If any of these don't match, fix the migration before committing.

- [ ] **Step 2.5: Commit**

```bash
git add db/migrations/0015_loose_match_functions.sql db/migrations/meta/_journal.json
git commit -m "feat(db): migration 0015 — loose match Postgres functions

Five IMMUTABLE PARALLEL SAFE functions implementing the loose match
algorithm in pure SQL: loose_token_forms, loose_title_forms,
loose_search_tokens, loose_match, loose_match_raw. Mirrors the JS
implementation in lib/analytics/looseMatch.ts."
```

---

## Task 3: SQL-vs-JS verification script

**Files:**
- Create: `scripts/verifyLooseMatchSql.ts`

A pure-data fixture set; we run each row through both `looseMatch` (JS) and `loose_match_raw` (SQL), assert they agree.

- [ ] **Step 3.1: Write the script**

Create `scripts/verifyLooseMatchSql.ts`:

```typescript
/**
 * Cross-check: for each fixture, run both the JS looseMatch and the
 * deployed Postgres loose_match_raw, assert identical output.
 *
 * Run after migration 0015 is applied. If any fixture mismatches, the
 * script prints the divergence and exits non-zero. The JS implementation
 * in lib/analytics/looseMatch.ts is the spec; SQL must agree.
 *
 * Usage: pnpm tsx scripts/verifyLooseMatchSql.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
import { looseMatch } from '@/lib/analytics/looseMatch';

interface Fixture {
  desc: string;
  search: string;   // search_term_normalized form
  title: string | null;
  expected: boolean | null;
}

const FIXTURES: Fixture[] = [
  // Motivating examples
  { desc: 'plural search vs singular title',
    search: 'creatine supplements', title: 'Creatine Gummies Supplement', expected: true },
  { desc: 'singular search vs plural title',
    search: 'creatine supplement', title: 'Creatine Supplements', expected: true },
  { desc: 'creatine gummies vs sugar free gummies',
    search: 'creatine gummies', title: 'Creatine Sugar Free Gummies', expected: true },
  { desc: 'gummy/gummies cross-direction',
    search: 'gummy vitamins', title: 'Gummies Multi Vitamin', expected: true },
  // Apostrophe / hyphen
  { desc: 'beekeepers (normalized form, no apostrophe)',
    search: 'beekeepers honey', title: "Beekeeper's Naturals Honey Spray", expected: true },
  { desc: 'hyphenated title',
    search: 'creatine gummies', title: 'Pure Creatine-Gummies 60ct', expected: true },
  // Plural domain words
  { desc: 'powders → powder',
    search: 'protein powders', title: 'Premium Protein Powder', expected: true },
  { desc: 'bars → bar',
    search: 'protein bars', title: 'Big Bar Plus Protein 12 ct', expected: true },
  { desc: 'teas → tea',
    search: 'green teas', title: 'Premium Green Tea Bags', expected: true },
  { desc: 'fibers → fiber',
    search: 'fibers daily', title: 'Daily Fiber Supplement', expected: true },
  // -ies expansion
  { desc: 'batteries → battery',
    search: 'aa batteries', title: 'AA Battery 24 Pack', expected: true },
  // Strict false cases
  { desc: 'missing required token',
    search: 'magnesium glycinate', title: 'Vitamin C Gummies', expected: false },
  { desc: 'stopwords on search side ignored',
    search: 'the best protein', title: 'Premium Protein Powder', expected: true },
  // Null
  { desc: 'null title',
    search: 'anything', title: null, expected: null },
  // Suffix guards
  { desc: 'stress not stripped',
    search: 'stress relief', title: 'Stres Relief Tablets', expected: false },
  { desc: 'virus kept whole',
    search: 'virus protection', title: 'Viru Protection', expected: false },
  { desc: 'analysis kept whole',
    search: 'analysis kit', title: 'Analy Kit', expected: false },
  // Exact-word exceptions
  { desc: 'gas not stripped',
    search: 'gas relief', title: 'Ga Relief Pills', expected: false },
  { desc: 'lens not stripped',
    search: 'lens cleaner', title: 'Len Cleaner', expected: false },
];

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  let failures = 0;
  for (const f of FIXTURES) {
    const jsResult = looseMatch(f.search, f.title);
    const sqlRows = (await sql`SELECT loose_match_raw(${f.search}, ${f.title}) AS r`) as Array<{ r: boolean | null }>;
    const sqlResult = sqlRows[0]?.r ?? null;

    const jsMatchesExpected = jsResult === f.expected;
    const sqlMatchesExpected = sqlResult === f.expected;
    const jsSqlAgree = jsResult === sqlResult;

    if (jsMatchesExpected && sqlMatchesExpected && jsSqlAgree) {
      console.log(`✓ ${f.desc}`);
    } else {
      failures += 1;
      console.error(
        `✗ ${f.desc}\n` +
        `    search="${f.search}" title=${JSON.stringify(f.title)}\n` +
        `    expected=${f.expected} js=${jsResult} sql=${sqlResult}`,
      );
    }
  }
  console.log(`\n${FIXTURES.length - failures}/${FIXTURES.length} fixtures agree.`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3.2: Run the script**

Run: `pnpm tsx scripts/verifyLooseMatchSql.ts`
Expected: all fixtures show `✓`, exit 0.

If any fixture fails, the bug is in either `lib/analytics/looseMatch.ts` or `db/migrations/0015_loose_match_functions.sql`. Fix the source and re-apply (drop the function and re-CREATE, or just re-run the migration since `CREATE OR REPLACE` makes it idempotent).

- [ ] **Step 3.3: Commit**

```bash
git add scripts/verifyLooseMatchSql.ts
git commit -m "test(analytics): cross-check JS vs SQL loose-match on fixtures

Runs every fixture through both lib/analytics/looseMatch.ts and the
Postgres loose_match_raw function, asserts they agree and both match
expected output. Run after applying migration 0015."
```

---

## Task 4: Rewrite `looseFlagSqlFragment` in the import path

**Files:**
- Modify: `inngest/functions/importFile.ts`

The current fragment is a 15-line CASE-WHEN regex blob plugged in 6 times. We replace it with a call to `loose_match(...)` using pre-computed inputs threaded through the CTE.

The two call sites: `runStagingToKwmInsert` (around line 245) and `runStagingToKwmTargetedRepair` (around line 431).

- [ ] **Step 4.1: Replace the `looseFlagSqlFragment` helper**

In `inngest/functions/importFile.ts`, find the `LOOSE_STOPWORDS_SQL_LIST` constant and the `looseFlagSqlFragment` function (around lines 76–104 — locate by searching for `looseFlagSqlFragment`). Delete both and replace with:

```typescript
/**
 * Produces a SQL boolean expression that evaluates whether the loose
 * title-match holds, given pre-computed search-side tokens and
 * title-side forms columns. Both sides must already be computed via
 * `loose_search_tokens(...)` and `loose_title_forms(...)` respectively,
 * typically in an upstream CTE for caching.
 *
 * Result is NULL when titleFormsSql evaluates to NULL (title was NULL).
 *
 * See db/migrations/0015_loose_match_functions.sql for the underlying
 * function definitions; see lib/analytics/looseMatch.ts for the spec.
 */
function looseFlagSqlFragment(searchTokensSql: string, titleFormsSql: string): string {
  return `loose_match(${searchTokensSql}, ${titleFormsSql})`;
}
```

- [ ] **Step 4.2: Thread search tokens + title forms through the INSERT CTE**

Around line 207 (the `WITH candidates AS (...)` CTE in `runStagingToKwmInsert`), the current SELECT pulls staging columns. We need to add:
- `st.search_term_normalized` (the search-side input)
- The three product titles (already there)

Then the outer SELECT (line ~236) builds the kwm row. Change the loose-flag and count expressions to use `loose_match(loose_search_tokens(st_search_term_normalized), loose_title_forms(<title>))`. To avoid recomputing `loose_search_tokens` six times, add a second-level CTE that pre-computes it.

Concretely, the structure becomes:

```sql
WITH candidates AS (
  SELECT
    s.uploaded_file_id,
    s.batch_id,
    s.week_end_date,
    st.id AS term_id,
    st.search_term_normalized,  -- NEW: thread through for loose match
    s.actual_rank,
    s.top_clicked_brand_1, s.top_clicked_brand_2, s.top_clicked_brand_3,
    s.top_clicked_category_1, s.top_clicked_category_2, s.top_clicked_category_3,
    s.top_clicked_product_1_asin, s.top_clicked_product_2_asin, s.top_clicked_product_3_asin,
    s.top_clicked_product_1_title, s.top_clicked_product_2_title, s.top_clicked_product_3_title,
    s.top_clicked_product_1_click_share, s.top_clicked_product_2_click_share, s.top_clicked_product_3_click_share,
    s.top_clicked_product_1_conversion_share, s.top_clicked_product_2_conversion_share, s.top_clicked_product_3_conversion_share,
    s.keyword_in_title_1, s.keyword_in_title_2, s.keyword_in_title_3, s.keyword_title_match_count,
    ROW_NUMBER() OVER (
      PARTITION BY s.week_end_date, st.id
      ORDER BY s.actual_rank ASC, /* ...existing tie-break order... */
    ) AS rn
  FROM staging_weekly_metrics s
  JOIN search_terms st ON st.search_term_normalized = s.search_term_normalized
  WHERE s.uploaded_file_id = ${fileId}
),
prepared AS (
  -- Compute search tokens once per (term, week)
  SELECT
    c.*,
    loose_search_tokens(c.search_term_normalized) AS search_tokens
  FROM candidates c
  WHERE rn = 1
)
INSERT INTO keyword_weekly_metrics AS kwm (...columns as today...)
SELECT
  week_end_date, term_id, actual_rank,
  /* ...all the existing columns, unchanged... */
  keyword_in_title_1, keyword_in_title_2, keyword_in_title_3, keyword_title_match_count,
  ${sql.raw(looseFlagSqlFragment('p.search_tokens', 'loose_title_forms(p.top_clicked_product_1_title)'))} AS keyword_in_title_1_loose,
  ${sql.raw(looseFlagSqlFragment('p.search_tokens', 'loose_title_forms(p.top_clicked_product_2_title)'))} AS keyword_in_title_2_loose,
  ${sql.raw(looseFlagSqlFragment('p.search_tokens', 'loose_title_forms(p.top_clicked_product_3_title)'))} AS keyword_in_title_3_loose,
  (
    (CASE WHEN ${sql.raw(looseFlagSqlFragment('p.search_tokens', 'loose_title_forms(p.top_clicked_product_1_title)'))} IS TRUE THEN 1 ELSE 0 END) +
    (CASE WHEN ${sql.raw(looseFlagSqlFragment('p.search_tokens', 'loose_title_forms(p.top_clicked_product_2_title)'))} IS TRUE THEN 1 ELSE 0 END) +
    (CASE WHEN ${sql.raw(looseFlagSqlFragment('p.search_tokens', 'loose_title_forms(p.top_clicked_product_3_title)'))} IS TRUE THEN 1 ELSE 0 END)
  )::smallint AS keyword_title_match_count_loose,
  /* ...fake_volume_severity and the rest, unchanged... */
FROM prepared p
ON CONFLICT (week_end_date, search_term_id) DO UPDATE SET
  /* existing DO UPDATE clause, unchanged */
```

Note: the FROM clause becomes `FROM prepared p` (instead of `FROM candidates WHERE rn = 1`), and the column references switch from bare names to `p.<col>`.

**Important:** the existing CTE uses `ROW_NUMBER()` tie-breaking logic that is non-trivial; do NOT rewrite or simplify it. Add the `search_term_normalized` field as another passed-through column, that's it. The `prepared` CTE wraps the `WHERE rn = 1` filter.

- [ ] **Step 4.3: Apply the same change to `runStagingToKwmTargetedRepair`**

Around line 380, the targeted-repair CTE has the same pattern (different name but same idea). Apply the identical structural change: pass `st.search_term_normalized` through the CTE, wrap in `prepared` that adds `loose_search_tokens(...)`, replace the inline loose expressions with the new fragment.

- [ ] **Step 4.4: Run the existing import tests**

Run: `pnpm vitest run inngest/functions/importFile.test.ts`
Expected: all existing tests still pass. (We haven't changed any externally visible behavior — same loose-match result, just via the new function pipeline.)

If a test fails for a reason related to loose flags, it's because the OLD test fixture was tuned to the buggy apostrophe behavior. Update the fixture to reflect correct behavior (one token `beekeepers`, not two tokens `beekeeper`+`s`).

- [ ] **Step 4.5: Commit**

```bash
git add inngest/functions/importFile.ts
git commit -m "refactor(import): loose match via new Postgres functions

Replace the inline regex+POSITION fragment with calls to
loose_match() / loose_search_tokens() / loose_title_forms() from
migration 0015. Threads search_term_normalized through the staging
CTE so search-side tokenization is computed once per (term, week)
instead of six times per row."
```

---

## Task 5: Reset the 6 already-backfilled weeks

**Files:**
- Create: `scripts/resetSixBuggyLooseWeeks.ts`

These six weeks (2025-04-19 through 2025-05-24) were filled with the old buggy SQL. We clear all four loose columns on these rows so the new backfill (Task 7) will pick them up.

- [ ] **Step 5.1: Write the script**

Create `scripts/resetSixBuggyLooseWeeks.ts`:

```typescript
/**
 * One-shot: clear the four loose columns on the six weeks backfilled
 * with the old (apostrophe-buggy, no-plurals) SQL fragment. These
 * weeks need to be redone with the new logic from migration 0015.
 *
 * Idempotent — re-running is a no-op once the weeks are reset.
 *
 * Usage: pnpm tsx scripts/resetSixBuggyLooseWeeks.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

const WEEKS_TO_RESET = [
  '2025-04-19',
  '2025-04-26',
  '2025-05-03',
  '2025-05-10',
  '2025-05-17',
  '2025-05-24',
];

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    statement_timeout: 600_000, // 10 min per week is plenty
  });
  const client = await pool.connect();
  try {
    for (const w of WEEKS_TO_RESET) {
      const startedAt = Date.now();
      const result = await client.query(
        `
        UPDATE keyword_weekly_metrics
        SET keyword_in_title_1_loose = NULL,
            keyword_in_title_2_loose = NULL,
            keyword_in_title_3_loose = NULL,
            keyword_title_match_count_loose = NULL
        WHERE week_end_date = $1::date
          AND keyword_title_match_count_loose IS NOT NULL
        `,
        [w],
      );
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`  ${w}: ${(result.rowCount ?? 0).toLocaleString().padStart(10)} rows reset in ${elapsed}s`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 5.2: Run the reset**

Run: `pnpm tsx scripts/resetSixBuggyLooseWeeks.ts`
Expected: ~2.4M rows reset per week × 6 weeks. Each week should take 1–3 min on Neon.

- [ ] **Step 5.3: Verify all 55 weeks now have `keyword_title_match_count_loose IS NULL` consistently**

Spot-check query (don't commit a script for this; just run inline):

```sql
SELECT week_end_date,
       COUNT(*) FILTER (WHERE keyword_title_match_count_loose IS NULL) AS unbackfilled,
       COUNT(*) AS total
FROM keyword_weekly_metrics
GROUP BY week_end_date
ORDER BY week_end_date;
```

Expected: every week shows `unbackfilled == total` (the entire dataset is unbackfilled, ready for Task 7).

- [ ] **Step 5.4: Commit**

```bash
git add scripts/resetSixBuggyLooseWeeks.ts
git commit -m "chore(backfill): reset 6 weeks filled with buggy loose SQL

Clears the four loose columns on the six weeks (2025-04-19 through
2025-05-24) backfilled with the old apostrophe-buggy, no-plurals
fragment. The new backfill (next commit) will redo these weeks with
the migration 0015 logic."
```

---

## Task 6: New backfill script with title cache + materialized CTE + strict shortcut

**Files:**
- Modify: `scripts/backfillKwmLooseFlags.ts` (full rewrite)

Per-week loop. For each week:
1. Build a temp `tmp_title_forms(title, forms)` table from the distinct non-NULL titles in that week.
2. Run a single materialized CTE UPDATE using the temp table for lookups + strict shortcut + count-based resume marker.

- [ ] **Step 6.1: Rewrite the script**

Replace the contents of `scripts/backfillKwmLooseFlags.ts` with:

```typescript
/**
 * Backfill keyword_in_title_*_loose + keyword_title_match_count_loose
 * across all weeks in keyword_weekly_metrics. Uses migration 0015's
 * Postgres functions.
 *
 * Strategy per week:
 *   1. Build temp table of distinct non-NULL titles → loose_title_forms()
 *      so the (expensive) normalization runs once per distinct title,
 *      not once per kwm row.
 *   2. Single UPDATE using a MATERIALIZED CTE that:
 *      - Computes f1/f2/f3 once each (no re-evaluation in the count).
 *      - Skips loose computation when Amazon's strict flag is TRUE
 *        (loose is a superset of strict, so this is a free correct shortcut).
 *      - Joins to the temp title-forms table for cached lookups.
 *   3. Resume marker: keyword_title_match_count_loose IS NULL.
 *      (Was previously keyword_in_title_1_loose IS NULL — a bug, since
 *      that column legitimately stays NULL when title #1 is NULL.)
 *
 * Idempotent. Connection: pg.Pool (TCP); neon-http times out on
 * multi-min UPDATEs.
 *
 * Usage: pnpm tsx scripts/backfillKwmLooseFlags.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL!,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    statement_timeout: 1_800_000, // 30 min ceiling per statement
  });
  const client = await pool.connect();

  try {
    console.log('\n=== Weeks to backfill ===');
    const { rows: weeks } = await client.query<{
      week_end_date: string;
      total: number;
      need_backfill: number;
    }>(
      `SELECT
         week_end_date::text,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE keyword_title_match_count_loose IS NULL)::int AS need_backfill
       FROM keyword_weekly_metrics
       GROUP BY week_end_date
       ORDER BY week_end_date`,
    );
    const todo = weeks.filter((w) => w.need_backfill > 0);
    const totalNeed = todo.reduce((s, w) => s + w.need_backfill, 0);
    console.log(
      `  ${weeks.length} weeks total; ${todo.length} need backfill; ${totalNeed.toLocaleString()} rows`,
    );
    if (todo.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    const startedAt = Date.now();

    for (let i = 0; i < todo.length; i++) {
      const w = todo[i];
      const ws = w.week_end_date.slice(0, 10);
      const sliceStart = Date.now();

      // -- 1. Build per-week temp title cache. ON COMMIT DROP would
      //    fire too early; we don't run in a single transaction. Use
      //    BEGIN/COMMIT explicitly so the temp table survives the
      //    UPDATE inside the same session.
      await client.query('BEGIN');

      await client.query(
        `CREATE TEMP TABLE tmp_title_forms ON COMMIT DROP AS
         WITH distinct_titles AS (
           SELECT top_clicked_product_1_title AS title
             FROM keyword_weekly_metrics
             WHERE week_end_date = $1::date AND top_clicked_product_1_title IS NOT NULL
           UNION
           SELECT top_clicked_product_2_title AS title
             FROM keyword_weekly_metrics
             WHERE week_end_date = $1::date AND top_clicked_product_2_title IS NOT NULL
           UNION
           SELECT top_clicked_product_3_title AS title
             FROM keyword_weekly_metrics
             WHERE week_end_date = $1::date AND top_clicked_product_3_title IS NOT NULL
         )
         SELECT title, loose_title_forms(title) AS forms FROM distinct_titles`,
        [ws],
      );
      await client.query('CREATE INDEX ON tmp_title_forms (title)');
      await client.query('ANALYZE tmp_title_forms');
      const { rows: cacheStats } = await client.query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM tmp_title_forms',
      );
      const distinctTitles = cacheStats[0]?.n ?? 0;

      // -- 2. Single materialized-CTE UPDATE for the week.
      const result = await client.query(
        `WITH computed AS MATERIALIZED (
           SELECT
             kwm.ctid,
             CASE
               WHEN kwm.top_clicked_product_1_title IS NULL THEN NULL
               WHEN kwm.keyword_in_title_1 IS TRUE THEN TRUE
               ELSE loose_match(loose_search_tokens(st.search_term_normalized), t1.forms)
             END AS f1,
             CASE
               WHEN kwm.top_clicked_product_2_title IS NULL THEN NULL
               WHEN kwm.keyword_in_title_2 IS TRUE THEN TRUE
               ELSE loose_match(loose_search_tokens(st.search_term_normalized), t2.forms)
             END AS f2,
             CASE
               WHEN kwm.top_clicked_product_3_title IS NULL THEN NULL
               WHEN kwm.keyword_in_title_3 IS TRUE THEN TRUE
               ELSE loose_match(loose_search_tokens(st.search_term_normalized), t3.forms)
             END AS f3
           FROM keyword_weekly_metrics kwm
           JOIN search_terms st ON st.id = kwm.search_term_id
           LEFT JOIN tmp_title_forms t1 ON t1.title = kwm.top_clicked_product_1_title
           LEFT JOIN tmp_title_forms t2 ON t2.title = kwm.top_clicked_product_2_title
           LEFT JOIN tmp_title_forms t3 ON t3.title = kwm.top_clicked_product_3_title
           WHERE kwm.week_end_date = $1::date
             AND kwm.keyword_title_match_count_loose IS NULL
         )
         UPDATE keyword_weekly_metrics kwm
         SET keyword_in_title_1_loose = c.f1,
             keyword_in_title_2_loose = c.f2,
             keyword_in_title_3_loose = c.f3,
             keyword_title_match_count_loose = (
               COALESCE(c.f1::int, 0) + COALESCE(c.f2::int, 0) + COALESCE(c.f3::int, 0)
             )::smallint
         FROM computed c
         WHERE kwm.ctid = c.ctid`,
        [ws],
      );

      await client.query('COMMIT');

      const sliceMs = Date.now() - sliceStart;
      const remaining = todo.length - i - 1;
      const avgMs = (Date.now() - startedAt) / (i + 1);
      const etaMin = Math.round((remaining * avgMs) / 60_000);
      const updated = result.rowCount ?? 0;
      console.log(
        ` [${(i + 1).toString().padStart(2)}/${todo.length}] ${ws} | ${distinctTitles.toLocaleString().padStart(8)} distinct titles | ${updated.toLocaleString().padStart(10)} rows | ${(sliceMs / 1000).toFixed(1).padStart(6)}s | ETA ~${etaMin}m`,
      );
    }

    console.log(`\nTotal elapsed: ${Math.round((Date.now() - startedAt) / 60_000)} min`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 6.2: Commit (without running)**

```bash
git add scripts/backfillKwmLooseFlags.ts
git commit -m "perf(backfill): per-week title cache + materialized CTE + strict shortcut

Three changes over the previous backfill:
  1. Build a temp tmp_title_forms(title, forms) per week so distinct
     titles are normalized once instead of once per kwm row referencing
     them. Expected 16-80× reduction in title-side CPU.
  2. WITH computed AS MATERIALIZED (...) so f1/f2/f3 evaluate once
     each (the count column reads c.f1/f2/f3 rather than re-running
     the expression).
  3. Strict-true shortcut: if Amazon's strict flag is TRUE, loose is
     also TRUE (loose is a superset). Skips computation for ~30-50%
     of rows.

Also fixes the resume marker bug: keyword_title_match_count_loose IS NULL
instead of keyword_in_title_1_loose IS NULL (the latter stays NULL
forever when title #1 is genuinely NULL)."
```

---

## Task 7: Single-week trial + HOT measurement

Run the new backfill against **one** week and measure performance + HOT-update rate. This decides whether we proceed straight to all 55 weeks or stop to investigate further.

- [ ] **Step 7.1: Pick a representative week and run the backfill in foreground**

Pick a week with median row count, e.g. `2025-08-30`. Edit `scripts/backfillKwmLooseFlags.ts` temporarily to filter to just that week (add `AND week_end_date = '2025-08-30'` to the planning query, or hardcode `const todo = weeks.filter(w => w.week_end_date.startsWith('2025-08-30'));`). DO NOT commit this edit.

Run: `pnpm tsx scripts/backfillKwmLooseFlags.ts`

Record:
- Wall time (the script prints it)
- Distinct title count (the script prints it)
- Rows updated (the script prints it)

Expected: ≤5 min for ~2.7M rows. If >10 min, stop and investigate before proceeding.

- [ ] **Step 7.2: Measure HOT update rate**

Immediately after the trial week runs, query `pg_stat_user_tables`:

```sql
SELECT relname,
       n_tup_upd,
       n_tup_hot_upd,
       ROUND(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 2) AS hot_pct,
       n_dead_tup,
       last_vacuum,
       last_autovacuum
FROM pg_stat_user_tables
WHERE relname LIKE 'keyword_weekly_metrics%'
ORDER BY relname;
```

Record `hot_pct` for the yearly partition that contains the trial week.

**If `hot_pct` is < 70%:** the wide-row tuple-rewrite is more expensive than expected. Consider dropping non-essential indexes before the full run (Step 7.4). If `hot_pct` is ≥ 70%, no further action; the indexes aren't a meaningful drag.

- [ ] **Step 7.3: Revert the trial filter and verify the data**

Revert the temporary filter in `scripts/backfillKwmLooseFlags.ts`. Verify the trial week's data via the verification script extended to a few real rows:

```sql
SELECT search_term_id, week_end_date,
       keyword_in_title_1, keyword_in_title_1_loose,
       keyword_title_match_count, keyword_title_match_count_loose
FROM keyword_weekly_metrics
WHERE week_end_date = '2025-08-30'
ORDER BY actual_rank ASC
LIMIT 20;
```

Sanity check: where strict is TRUE, loose should also be TRUE. Where strict is FALSE but the title clearly contains the keyword (you'll have to eyeball a few via the keyword_in_title_1's title column), loose should be TRUE.

- [ ] **Step 7.4 (conditional): If HOT < 70%, drop non-essential indexes before full run**

List the indexes on the yearly partition:

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename LIKE 'keyword_weekly_metrics_y%';
```

Identify any index that includes the loose columns (probably none, since we just added them) or that includes the title columns (none expected). The PK and the rank covering index from migration 0011 are essential — do NOT drop those.

If you find a non-essential index that's bloating updates, drop it (note its definition first), run the full backfill, then re-create concurrently after.

In the common case (HOT >= 70%), skip this step entirely.

- [ ] **Step 7.5: Commit any non-trial changes from this task (none expected)**

Likely nothing to commit. If you ended up dropping/recreating an index, that's a separate manual migration to add to the codebase.

---

## Task 8: Run full backfill

- [ ] **Step 8.1: Run the backfill in foreground or as a background task**

For foreground: `pnpm tsx scripts/backfillKwmLooseFlags.ts`
For background (if running from Claude): launch as a background task and check on it periodically.

Expected runtime based on Task 7 trial × 55 weeks. Target: ≤3 hours total.

- [ ] **Step 8.2: Verify all 55 weeks completed**

```sql
SELECT week_end_date,
       COUNT(*) FILTER (WHERE keyword_title_match_count_loose IS NULL) AS still_null,
       COUNT(*) AS total
FROM keyword_weekly_metrics
GROUP BY week_end_date
ORDER BY week_end_date;
```

Expected: every week shows `still_null = 0`.

If any week has `still_null > 0`, re-run the backfill script — it's idempotent and will pick up only those rows.

- [ ] **Step 8.3: Spot-check the keyword detail page**

Open `/explorer/keyword/<some-id>` in the local dev server. The "Keyword in product title (52w)" grid should now show green/red squares for all 52 weeks (not just the most recent ones imported with the new logic).

Pick a keyword with a known plural form (e.g. one ending in "supplements") and verify that historical weeks with singular titles in the top slot now show green in the loose view.

---

## Task 9: Refresh keyword_current_summary

The loose columns flow into kcs's `keyword_in_title_*_loose_current` columns via the existing refresh logic. After backfilling history, we need one fresh kcs build so the "current" snapshot uses the corrected loose data.

- [ ] **Step 9.1: Run the kcs refresh**

The refresh is normally triggered by Inngest after each weekly import. To run it ad-hoc, either:
- Trigger the Inngest function manually from the admin UI / Inngest dev tools, OR
- Run the refresh script directly if one exists (check `scripts/` for a refresh-only entry point).

Expected runtime: ~29 min (per the rank-covering-index optimization from migration 0011).

- [ ] **Step 9.2: Verify kcs has loose data for the current week**

```sql
SELECT current_week_end_date,
       COUNT(*) FILTER (WHERE keyword_in_title_1_loose_current IS NOT NULL) AS with_loose,
       COUNT(*) AS total
FROM keyword_current_summary;
```

Expected: `with_loose` should be close to `total` (modulo rows whose current title #1 is genuinely NULL).

- [ ] **Step 9.3: Spot-check the explorer table**

Open `/explorer` in the local dev server. The default sort/filter view should show loose-match data populated for the current week.

---

## Constraints / non-goals (locked from RFC)

- Stay in pure Postgres SQL — no custom C extensions, no Snowball stemmer.
- Same logic runs in import path and backfill — share via the new Postgres functions.
- No schema redesign — work with the columns added in migration 0014.
- Backfill must be safely interruptible/resumable.
- Don't touch the strict columns.
- Don't do stage-and-swap on yearly partitions; controlled UPDATE is fine at this expected runtime.

## What success looks like

- All 55 weeks in kwm have `keyword_title_match_count_loose` populated.
- The motivating example ("Creatine Supplements" matching "Creatine Gummies Supplement") returns TRUE on the loose view of the detail page.
- The import path uses the new functions; new imports produce correct loose flags without any further intervention.
- Total backfill wall time ≤ 3 hours (≥ 4× speedup over the previous 13-hour estimate).
- JS implementation in `looseMatch.ts` and Postgres functions agree on every fixture.
