# Loose-match backfill perf — round 2 review

## TL;DR

We implemented your padded-string + bidirectional-candidate matcher
from the last review. JS↔SQL fixtures all pass. Two trial UPDATEs on
one week (~2.6M rows) have **both been killed without completing or
writing a single row**:

  - Trial 1 (plpgsql `loose_title_flags_3`): killed at 22 min
  - Trial 2 (pure SQL `loose_title_flags_3`, post-migration 0017): killed at 90 min

EXPLAIN says the plan is sensible (drives from the week-filtered kwm
partition, hash-joins to search_terms, calls our composite function
per row). The matcher is just expensive enough per row that this
shape isn't viable.

**Target: ≤15 min per ~2.6M-row week.** We need a structural
rethink. We're prepared to do significant restructuring of the
matcher SQL (or even the row model for the backfill) to hit that.

We want feedback on:

1. Is there a fundamentally faster matcher shape that preserves the
   same correctness as the bidirectional-candidate algorithm?
2. Should we abandon per-row function calls entirely and inline
   everything (e.g., a single regex match per slot)?
3. Are there backfill execution strategies (parallel workers,
   per-batch commits, etc.) we should add on top of the matcher fix?

---

## System context (recap)

- Postgres 17 on Neon (serverless, paid tier).
- 145M-row `keyword_weekly_metrics` (kwm) table, yearly partitioned
  (kwm_2024 empty, kwm_2025 ~80M rows, kwm_2026 ~73M rows, kwm_2027 empty).
- Per-week UPDATE backfill via `pg.Pool` TCP.
- `VACUUM (ANALYZE) keyword_weekly_metrics_2025` was run after the
  6-week reset — reclaimed 1.8M dead tuples.
- search_terms ~9.5M rows total, ~3.8M active.

## Trial data points

Both trials targeted week 2025-08-30 (~2.6M rows; ~94% need full
loose computation; ~6% qualify for the cheap fast path via strict=TRUE
or all-null titles).

| Trial | Matcher shape | Wall time when killed | Rows written | Wait event observed |
|---|---|---|---|---|
| 1 | `loose_title_flags_3` as plpgsql | 22 min | 0 | `null` (CPU active) |
| 2 | `loose_title_flags_3` as inlinable SQL | 90 min | 0 | `Neon/Prefetch` |

(For comparison, the **original buggy** backfill at the start of this
project ran each week in 14–16 min with inline regex + POSITION, no
function calls. That was just `regexp_replace(LOWER(...), '[^a-z0-9]+', ' ', 'g')`
and a single POSITION per non-stopword token. No plural handling, no
apostrophe stripping.)

## Plan

```
Update on keyword_weekly_metrics_2025 kwm  (cost=538472.87..9228081.90 rows=0 width=0)
  ->  Hash Join  (cost=538472.87..9228081.90 rows=2631296 width=49)
        Hash Cond: (kwm.search_term_id = st.id)
        ->  Bitmap Heap Scan on keyword_weekly_metrics_2025 kwm  (cost=43521.11..7670534.03 rows=2631296 width=423)
              Recheck Cond: (week_end_date = '2025-08-30'::date)
              Filter: (keyword_title_match_count_loose IS NULL)
              ->  Bitmap Index Scan on keyword_weekly_metrics_2025_week_end_date_top_clicked_categ_idx (cost=0.00..42863.29 rows=2631296 width=0)
                    Index Cond: (week_end_date = '2025-08-30'::date)
        ->  Hash  (cost=292081.78..292081.78 rows=9529278 width=46)
              ->  Seq Scan on search_terms st  (cost=0.00..292081.78 rows=9529278 width=46)
        SubPlan 1
          ->  Function Scan on loose_title_flags_3 lf  (cost=0.25..0.26 rows=1 width=5)
```

Plan reading:
- Drives from the week-filtered kwm partition via bitmap heap scan
  (good: 2.6M rows, not the full 80M-row partition).
- Hash-builds search_terms (9.5M rows). This is ~292K cost units —
  small in absolute terms.
- Per-row function-scan of `loose_title_flags_3` for each joined row.
- Width of the kwm rows on the heap scan is 423 bytes (wide).

## What we built

Migration 0016 + 0017 in sequence. Functions involved:

```sql
-- Plural-candidate generation per search token. Bidirectional:
-- includes singularization (-ies/-es/-s strip with suffix guards and
-- exact-word exceptions) AND a likely pluralization (consonant-y -> -ies,
-- sibilant -> -es, otherwise -> +s).
CREATE FUNCTION loose_token_forms_bidirectional(token text) RETURNS text[] AS $$
  -- (~20-line CTE returning array of 1-4 forms per token)
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- Stopword filter + tokenize the search_term_normalized.
CREATE FUNCTION loose_search_tokens(normalized_term text) RETURNS text[] AS $$
  -- (returns ~3-10 non-stopword tokens per term)
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- Normalize title to a padded lowercase alphanumeric string for
-- whole-word matching via POSITION(' '||form||' ' IN title_norm).
CREATE FUNCTION loose_title_norm(title text) RETURNS text AS $$
  SELECT CASE
    WHEN title IS NULL THEN NULL
    ELSE ' ' || trim(regexp_replace(
      regexp_replace(
        regexp_replace(LOWER(title), '[''’]', '', 'g'),
        '[^a-z0-9]+', ' ', 'g'
      ),
      '\s+', ' ', 'g'
    )) || ' '
  END;
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- Per-slot matcher, takes PRECOMPUTED inputs to avoid re-tokenizing
-- the search and re-normalizing the title 3x per row.
CREATE FUNCTION loose_match_padded(search_tokens text[], title_norm text)
RETURNS boolean AS $$
  SELECT CASE
    WHEN title_norm IS NULL THEN NULL
    WHEN search_tokens IS NULL OR cardinality(search_tokens) = 0 THEN FALSE
    ELSE NOT EXISTS (
      SELECT 1 FROM unnest(search_tokens) AS s
      WHERE NOT EXISTS (
        SELECT 1 FROM unnest(loose_token_forms_bidirectional(s)) AS f
        WHERE POSITION(' ' || f || ' ' IN title_norm) > 0
      )
    )
  END;
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- Composite return so all 4 values for one row come from ONE call.
-- Inlines null-title + strict-true shortcuts. Pure SQL (was plpgsql
-- in migration 0016) to permit planner inlining.
CREATE FUNCTION loose_title_flags_3(
  normalized_search text,
  title1 text, title2 text, title3 text,
  strict1 boolean, strict2 boolean, strict3 boolean
) RETURNS loose_title_flags AS $$
  WITH ctx AS (
    SELECT
      loose_search_tokens(normalized_search) AS tokens,
      loose_title_norm(title1) AS t1,
      loose_title_norm(title2) AS t2,
      loose_title_norm(title3) AS t3
  ),
  flags AS (
    SELECT
      CASE WHEN title1 IS NULL THEN NULL
           WHEN strict1 IS TRUE THEN TRUE
           ELSE loose_match_padded(c.tokens, c.t1)
      END AS f1,
      CASE WHEN title2 IS NULL THEN NULL
           WHEN strict2 IS TRUE THEN TRUE
           ELSE loose_match_padded(c.tokens, c.t2)
      END AS f2,
      CASE WHEN title3 IS NULL THEN NULL
           WHEN strict3 IS TRUE THEN TRUE
           ELSE loose_match_padded(c.tokens, c.t3)
      END AS f3
    FROM ctx c
  )
  SELECT ROW(
    f1, f2, f3,
    (COALESCE(f1::int, 0) + COALESCE(f2::int, 0) + COALESCE(f3::int, 0))::smallint
  )::loose_title_flags
  FROM flags;
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;
```

## The backfill UPDATE shape

```sql
UPDATE keyword_weekly_metrics_2025 kwm
SET (
  keyword_in_title_1_loose,
  keyword_in_title_2_loose,
  keyword_in_title_3_loose,
  keyword_title_match_count_loose
) = (
  SELECT (lf).f1, (lf).f2, (lf).f3, (lf).match_count
  FROM loose_title_flags_3(
    st.search_term_normalized,
    kwm.top_clicked_product_1_title,
    kwm.top_clicked_product_2_title,
    kwm.top_clicked_product_3_title,
    kwm.keyword_in_title_1,
    kwm.keyword_in_title_2,
    kwm.keyword_in_title_3
  ) AS lf
)
FROM search_terms st
WHERE kwm.search_term_id = st.id
  AND kwm.week_end_date = '2025-08-30'::date
  AND kwm.keyword_title_match_count_loose IS NULL
```

(Direct child-partition target. Row-valued scalar subquery in SET so
the composite function evaluates once and projects 4 fields.)

## Diagnostic data we ran first

Single-week sample on 2025-08-30 (full partition aggregate, NOT the
killed UPDATE trials):

```
Total rows: 2,604,342
All-null titles (no loose needed): 0 (0.0%)
All strict-true-or-null (cheap fast path): 151,044 (5.8%)
Needs expensive loose compute: 2,453,298 (94.2%)
Title occurrences (across 3 slots): 7,793,495
Distinct titles: 2,264,342 (29.1% of occurrences)
Avg uses per distinct title: 3.4x
```

So ~95% of rows do the full per-row matcher work. Title cache
amortizes badly (29% distinct).

## Hypotheses on where time is going

For ~2.6M rows per week:

1. **`loose_token_forms_bidirectional` is called per (row × token)** —
   not per distinct token. With ~3-5 non-stopword search tokens
   per row, that's ~8-13M calls per week. Each call evaluates a CTE
   with a UNION + regex matches inside the CASE.
2. **`loose_match_padded` does up to 4 POSITION calls per token**
   (1 original + ~1-3 plural variants). For ~5 tokens × ~3 forms × 3
   slots = ~45 POSITION calls per row. For 2.6M rows × 45 = ~117M
   substring scans per week.
3. **Function-call overhead** even on IMMUTABLE SQL functions, on
   the order of ~1μs per call on Neon. With ~3 calls to
   `loose_match_padded` + 3 to `loose_title_norm` + 1 to
   `loose_search_tokens` + ~13M to `loose_token_forms_bidirectional`
   per row, the overhead alone can dominate.
4. **CTE re-evaluation inside `loose_title_flags_3`** — even with
   `LANGUAGE sql`, the planner may not perfectly inline our
   CTE chain. If `ctx` is re-evaluated per `flags` reference, search
   tokens + title norms are re-computed 3× per row.

## Ideas we'd like your read on

### A. Single-regex per slot

Build one regex per row that encodes all required candidate forms
across all search tokens as lookahead assertions:

```sql
-- pattern: '(?=.*\m(creatine|creatines)\M)(?=.*\m(supplement|supplements)\M)'
SELECT title_norm ~ regex_pattern AS f1
```

One regex match per slot (3 per row) instead of ~45 POSITION calls.
Postgres' built-in regex (Spencer-style) is highly optimized C code.
The pattern is built once per row from search-token forms.

Concerns:
- Regex compilation has cost; would Postgres cache compiled patterns
  across rows when the pattern text is identical? (search_term
  repetition across weeks should make this useful — but in a single
  UPDATE, each row has a different search term, so cache miss is the
  default.)
- Pattern construction is a per-row string concat; cheap but not free.

Is this a path you'd recommend? Any structural concerns?

### B. Inline the matcher entirely (no function calls)

Bring all the logic up into the UPDATE itself as one large SQL
expression. No `loose_match_padded`, no `loose_title_flags_3`. The
plural-variant generation becomes a CASE WHEN cascade inline,
producing a literal `text[]` per token.

This eliminates per-call function overhead but blows up the SQL
verbosity. Want your gut feel on whether this typically helps in
practice on Postgres.

### C. Compute on a temp table first, then UPDATE from it

```sql
CREATE TEMP TABLE tmp_loose AS
SELECT ctid, f1, f2, f3, match_count
FROM (SELECT kwm.ctid, ... -- the matcher computation ... FROM kwm JOIN ... WHERE week=$1) sub;

UPDATE keyword_weekly_metrics_2025 kwm SET ... FROM tmp_loose t WHERE kwm.ctid = t.ctid;
```

Splits compute from write. The temp insert is fast (no MVCC); the
final UPDATE just looks up by ctid and writes 4 small fields.
Concern: same total CPU cost; but maybe better cache behavior /
fewer aborts on long-running statements?

### D. Parallel workers across weeks

Two TCP connections, each processing a different week. Neon's
compute auto-scales. Concern: shared catalog/WAL contention,
interaction with autovacuum.

### E. Generated columns

Could we make `loose_title_norm(title)` a generated column on kwm?
Postgres only allows stored generated columns from same-row expressions
(no joins), so this is fine for title_norm. Adding 3 columns
(`title_1_norm`, `title_2_norm`, `title_3_norm`) would pay the
normalization cost ONCE at INSERT time and never again.

(For the backfill, we'd still need to populate these for historical
rows — but that's just one regex per title per slot, vastly cheaper
than the matcher work.)

Search tokens can't be generated because they depend on the JOIN to
`search_terms.search_term_normalized`. But we could pre-compute a
search_terms-side text[] column once at insert time.

### F. Drop loose_token_forms_bidirectional and inline plural rules

Three CASE WHEN expressions per row could yield the 2-4 forms per
token without an array allocation, an unnest, and a function call.

---

## Constraints

- Pure Postgres SQL — no extensions, no Snowball.
- Same logic must run in two places: import path INSERT and historical
  UPDATE. Sharing via the new functions is ideal but not required —
  if the right answer is "inline differently in the two places," we
  can do that.
- The 5 functions in migrations 0016 + 0017 are already deployed but
  not yet used in production reads. We can DROP/replace freely.
- We can add new columns to kwm and search_terms.
- We can change the schema if it materially helps (generated columns,
  pre-computed token arrays, etc.).
- We have 4+ hours of operational tolerance for one-time backfill jobs
  but **per-week wall time must be ≤15 min** so the trailing-12-week
  backfill finishes in 3 hours and the full-history backfill (if we
  decide to do it later) is ≤14 hours.

## Question

Given the trial data, the matcher implementation, and the EXPLAIN
plan above — **what's the structural change that gets us ≤15 min per
week?** Concrete SQL would be valuable. We're open to changing data
shape, adding indexes, denormalizing, or anything else that makes
the per-row matcher cheap enough.
