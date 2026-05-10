# Loose title-match RFC — variation rules + plural handling + backfill perf

## TL;DR

Our keyword-detail page shows whether a search term appears in each of the
top-3 clicked product titles for that week. We compute two flavors:

- **Strict** — Amazon's own flag from the source CSV (exact phrase match).
- **Loose** — our flag: every non-stopword token in the search term must
  appear as a whole word anywhere in the title (order-independent,
  words-in-between OK).

Loose is the default on the detail page. We just added per-week loose
columns to `keyword_weekly_metrics` (kwm) and started backfilling 145M
rows. The backfill is running at ~15 min/week × 55 weeks ≈ **13 hr ETA**,
which is uncomfortably long. We've paused it.

Before we resume, we want feedback on:

1. **Two correctness problems** with how loose match is computed today:
   - **Apostrophe handling drift** between the JS code and the SQL
     fragment — `"beekeeper's"` gets tokenized differently in the two
     paths.
   - **No plural handling** — `"supplements"` does not match a title
     containing `"supplement"`, which surprises users.
2. **Backfill performance** — is there a much faster way to populate
   four computed columns across 145M wide rows in a partitioned table?

---

## System context

- **Stack:** Next.js 16 on Vercel + Inngest worker on Railway.
- **Database:** **Neon Postgres** (serverless, paid tier, auto-scales
  compute, data lives on object storage with a local page cache).
- **Scale:** 55 weekly partitions × ~2.7M rows = **~145M rows** in kwm,
  partitioned by year.
- **Driver for the backfill:** `pg` (node-postgres, TCP) — neon-http
  times out on multi-minute UPDATEs.
- **Row shape (kwm):** ~25 columns, several wide `text`/`varchar`
  columns for product titles. UPDATEs are expensive because each row is
  big and the tuple is rewritten in full.

## Schema essentials

```sql
search_terms (
  id uuid PRIMARY KEY,
  search_term_raw varchar(512) NOT NULL,        -- as-it-appeared in CSV (cleaned)
  search_term_normalized varchar(512) NOT NULL, -- canonical match key
  ...,
  UNIQUE (search_term_normalized)
)

keyword_weekly_metrics (
  week_end_date date NOT NULL,
  search_term_id uuid NOT NULL REFERENCES search_terms(id),
  actual_rank integer NOT NULL,
  top_clicked_product_1_title text,
  top_clicked_product_2_title text,
  top_clicked_product_3_title text,
  -- Strict flags (Amazon's, from CSV):
  keyword_in_title_1 boolean,
  keyword_in_title_2 boolean,
  keyword_in_title_3 boolean,
  keyword_title_match_count smallint,
  -- Loose flags (ours, just added in migration 0014; currently being backfilled):
  keyword_in_title_1_loose boolean,
  keyword_in_title_2_loose boolean,
  keyword_in_title_3_loose boolean,
  keyword_title_match_count_loose smallint,
  -- ... ~15 other columns ...
  PRIMARY KEY (week_end_date, search_term_id)
) PARTITION BY RANGE (week_end_date);
```

## The two normalization layers we already have (JS)

```ts
// 1. cleanSearchTermForDisplay — for human-visible / audit storage.
//    NFC, strip invisible/control chars, collapse whitespace. Preserves
//    case, punctuation, accents.
//
// 2. normalizeForMatch — the canonical match key. This is what produces
//    search_terms.search_term_normalized:
function normalizeForMatch(s: string): string {
  return cleanSearchTermForDisplay(s)
    .normalize('NFKC')                  // collapse ligatures, fullwidth, etc.
    .toLowerCase()
    .replace(/['’]/g, '')               // drop apostrophes: nature's -> natures
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')  // non-letter/non-number -> space
    .replace(/\s+/g, ' ').trim();
}
```

So in JS, `"beekeeper's"` → `"beekeepers"` (one token).
And `"creatine-gummies"` → `"creatine gummies"` (two tokens).

## How loose match is computed today (SQL)

The import path and the backfill share this SQL fragment. It's evaluated
per row, three times (one per slot), with the row's search-term and
product title as inputs:

```sql
CASE WHEN <title> IS NULL THEN NULL
  ELSE NOT EXISTS (
    SELECT 1 FROM unnest(
      string_to_array(
        regexp_replace(LOWER(<search_term_raw>), '[^a-z0-9]+', ' ', 'g'),
        ' '
      )
    ) AS w
    WHERE w <> ''
      AND w NOT IN ('a','an','and','are','as','at','be','by','for','from','has',
                    'have','in','is','it','its','of','on','or','that','the',
                    'this','to','with')
      AND POSITION(' ' || w || ' '
                   IN ' ' || regexp_replace(LOWER(<title>), '[^a-z0-9]+', ' ', 'g') || ' '
                  ) = 0
  )
END
```

In English: tokenize the search term on non-alphanumeric; for each
non-stopword token, require it to appear as a padded whole word inside a
padded normalized title. If any required token is missing, the result is
false; otherwise true. Order-independent. Words in between OK.

### Problem 1: divergence with `normalizeForMatch` on apostrophes

The SQL above treats `'` as a non-alphanumeric separator. So
`"beekeeper's"` tokenizes to `["beekeeper", "s"]` — and the loose check
then requires the title to contain `"s"` as a whole word. Most titles
happen to contain a stray `"s"` somewhere by coincidence, so this
*usually* works but for the wrong reason.

In JS, `normalizeForMatch("beekeeper's")` → `"beekeepers"` (apostrophe
elided, one token). That's the intended behavior, and what
`search_term_normalized` uses for dedup.

We want the SQL to faithfully mirror `normalizeForMatch` so the loose
match agrees with the dedup key.

### Problem 2: no plural handling

`"creatine supplements"` against title `"creatine gummies supplement"`
fails the loose check today, purely because `"supplements"` ≠
`"supplement"`. Users find this surprising.

---

## Proposed change — Option B (plural-rule cascade, symmetric)

### Step 1: fix the SQL to mirror `normalizeForMatch`

For each side (search term and title), normalize identically. Roughly:

```sql
-- inputs assumed already lowercased and NFKC-normalized at insert time
-- (or do it inline; NFKC in Postgres is `normalize(s, 'NFKC')` on PG 17+).
SELECT regexp_replace(
         regexp_replace(LOWER(<text>), $apostrophes$['’]$apostrophes$, '', 'g'),
         '[^a-z0-9]+', ' ', 'g'
       )
```

Key change vs. today: strip apostrophes **before** the
non-alphanumeric→space pass, so `"beekeeper's"` becomes `"beekeepers"`
(one token).

(Open question: do we also need `normalize(s, 'NFKC')` in SQL? Most
Amazon titles are ASCII, but the search terms can contain ligatures /
fullwidth chars. PG 17 added a `normalize()` function; we're on Neon
Postgres 17. Cost is non-trivial. We could just rely on the JS
normalization on the search-term side because `search_term_raw` was
cleaned by `cleanSearchTermForDisplay` at insert time — but it was
*not* NFKC'd; only NFC. Asymmetric. Worth thinking about.)

### Step 2: apply a plural-rule cascade per token, symmetric

After tokenization, normalize each token by stripping common plural
endings. Apply the same rule to both search-term tokens and title
tokens before comparison.

Rule sketch (first match wins, applied per token):

```text
if length > 4 AND ends with 'ies'                  → replace 'ies' with 'y'
elif ends with 'sses' or 'xes' or 'zes' or 'shes'
     or 'ches'                                     → strip trailing 'es'
elif length > 3 AND ends with 's'
     AND does NOT end with 'ss','us','is','as','os','rs','ys'
                                                   → strip trailing 's'
else unchanged
```

The "does not end with `ss`/`us`/`is`/`as`/`os`/`rs`/`ys`" guard catches
common false-positive endings: `stress`, `virus`, `analysis`, `gas`,
`bonus`, `hers`, `keys`.

The length guard (>3 for `-s`, >4 for `-ies`) avoids hits like
`is`→`i`, `as`→`a`, `dies`→`dy`.

Trade-offs accepted:
- Misses irregular plurals (mice/mouse, children/child, feet/foot).
- Misses some `-ves` plurals (knives/knife, leaves/leaf). Rare in
  product search.
- Will produce some odd stems on non-plural `-s` words we missed
  excluding (e.g., `lens` → `len`). We think this is fine — `"len"`
  is unlikely to be a standalone token in real titles.

Net effect on the motivating example:

- Search `"creatine supplements"` → tokens `["creatine", "supplement"]`
- Title `"creatine gummies supplement"` → tokens
  `["creatine", "gummy", "supplement"]`
- Both required tokens present → loose match TRUE. ✓

### SQL realization (sketch — would live in `looseFlagSqlFragment`)

```sql
CASE WHEN <title> IS NULL THEN NULL
  ELSE NOT EXISTS (
    SELECT 1
    FROM unnest(string_to_array(
      regexp_replace(
        regexp_replace(LOWER(<search_term>), $$['’]$$, '', 'g'),
        '[^a-z0-9]+', ' ', 'g'
      ),
      ' '
    )) AS raw_w
    CROSS JOIN LATERAL (SELECT plural_strip(raw_w) AS w) tok
    WHERE tok.w <> ''
      AND tok.w NOT IN (<stopwords>)
      AND POSITION(
        ' ' || tok.w || ' '
        IN ' ' || (
          SELECT string_agg(plural_strip(t), ' ')
          FROM unnest(string_to_array(
            regexp_replace(
              regexp_replace(LOWER(<title>), $$['’]$$, '', 'g'),
              '[^a-z0-9]+', ' ', 'g'
            ),
            ' '
          )) AS t
        ) || ' '
      ) = 0
  )
END
```

Where `plural_strip(text) RETURNS text` is an `IMMUTABLE` SQL function
implementing the rule cascade above. (We'd verify it inlines under
`ANALYZE` so we don't pay function-call overhead per token.)

---

## Backfill performance — current and target

### Today's backfill

Script: `scripts/backfillKwmLooseFlags.ts`. Per-week, in a loop:

```sql
UPDATE keyword_weekly_metrics kwm
SET keyword_in_title_1_loose = (<expr1>),
    keyword_in_title_2_loose = (<expr2>),
    keyword_in_title_3_loose = (<expr3>),
    keyword_title_match_count_loose = (
      CASE WHEN (<expr1>) THEN 1 ELSE 0 END
      + CASE WHEN (<expr2>) THEN 1 ELSE 0 END
      + CASE WHEN (<expr3>) THEN 1 ELSE 0 END
    )::smallint
FROM search_terms st
WHERE kwm.search_term_id = st.id
  AND kwm.week_end_date = $1::date
  AND kwm.keyword_in_title_1_loose IS NULL;
```

Observed: ~15 min per ~2.7M-row week. Wall: ~13 hr for 55 weeks.

### Suspected reasons for the slowness

1. **6 evaluations per row.** Each slot expression is referenced
   twice — once for the boolean column, once inside the count CASE.
   Postgres almost certainly does not common-subexpression-eliminate
   the regex+subquery.
2. **Wide-row UPDATE.** kwm rows are big; UPDATE rewrites the entire
   tuple in a new heap location, then dead-tuples the old one (MVCC).
   Vacuum later reclaims, but the write cost is paid up front.
3. **Per-row JOIN to `search_terms`.** Pulls the raw search term for
   every row, three times via the expression. Could be hoisted, but
   the planner may not.
4. **Index maintenance.** Several covering indexes include columns
   we're touching (or columns near them), causing extra index writes.

### Ideas we've considered but want a sanity check on

**A. Single-pass CTE then UPDATE FROM**
```sql
WITH computed AS (
  SELECT kwm.ctid,
         (<expr1>) AS f1, (<expr2>) AS f2, (<expr3>) AS f3
  FROM keyword_weekly_metrics kwm
  JOIN search_terms st ON st.id = kwm.search_term_id
  WHERE kwm.week_end_date = $1 AND kwm.keyword_in_title_1_loose IS NULL
)
UPDATE keyword_weekly_metrics kwm
SET keyword_in_title_1_loose = c.f1, ...,
    keyword_title_match_count_loose =
      (COALESCE(c.f1::int,0) + COALESCE(c.f2::int,0) + COALESCE(c.f3::int,0))::smallint
FROM computed c
WHERE kwm.ctid = c.ctid;
```
Forces each expression to evaluate once. Expected ~2× speedup. Free
correctness win.

**B. Stage-and-swap (rebuild the partition rather than UPDATE)**
For each weekly partition:
```sql
CREATE TABLE kwm_yYYYY_new (LIKE kwm INCLUDING ALL);
INSERT INTO kwm_yYYYY_new SELECT ..., <expr1>, <expr2>, <expr3>, <count> FROM kwm_yYYYY ...;
-- swap by detaching old partition, attaching new
```
Avoids MVCC tuple rewrite + dead-tuple bloat. Expected another
~1.5–2× on top of A. But: partitions are yearly, not weekly — so the
swap unit is ~3 months of data at a time, not 1 week. Operational
risk of swapping a live partition.

**C. Hoist the search-term tokenization out of the per-row expression**
Precompute a `tokens text[]` column for each `search_terms` row once,
then join to that instead of recomputing from `search_term_raw` in
every kwm row. Memory: ~3.8M rows × ~20-byte avg array = ~80MB,
trivial. Should give a meaningful win because the search-term
tokenization is paid once per term, not per term-week.

**D. Materialized helper view per week**
Tempting but probably the same cost as A.

**E. Parallelize across partitions**
Two TCP connections each working a different year's partition. Neon
auto-scales compute. Real concern: write contention on shared catalog,
WAL throughput limits. Worth thinking about.

**F. Skip rows where all three titles are NULL**
Probably <1% of rows. Negligible.

**G. Drop/disable non-essential indexes during the backfill, rebuild after**
Could help if index maintenance is a bottleneck. We'd want to confirm
with `pg_stat_user_tables.n_tup_hot_upd` whether HOT updates are
firing (they should be, since we're only writing non-indexed
columns), in which case index maintenance shouldn't be the bottleneck.

### What we want feedback on

- **Is there a structurally faster pattern** for "add 4 computed
  columns to 145M wide partitioned rows" that we're not considering?
  (Generated columns? `INSERT ... ON CONFLICT` into a fresh table?
  Anything Neon-specific?)
- **Of A–G above, what would you do?** Are we wrong about any of the
  expected speedups?
- **Is the stage-and-swap operationally safe** on a partitioned table
  in Neon, given the partitions are yearly and a year's worth of data
  swap is a non-trivial window?
- **Anything we should measure first** (e.g., `EXPLAIN ANALYZE` on one
  week with each variant) before committing to a strategy?

---

## Specific questions for review

### On the loose-match logic

1. Does the **plural-rule cascade** in Step 2 look sound, or are we
   missing an obvious edge case? Particularly the "does not end with
   `ss`/`us`/…" guard list.
2. Should we **NFKC-normalize titles** in SQL too, or is it safe to
   skip given titles are typically clean ASCII from Amazon?
3. Is **applying the plural rule symmetrically** (both sides) the
   right call, or would asymmetric — strip plurals from search
   term tokens, then look for the result as a *prefix* in title
   tokens — be cleaner? (Tradeoff: prefix match in SQL is awkward
   with word-boundary semantics.)
4. Are we **over- or under-engineering** by going with a hand-rolled
   plural cascade vs. just using Postgres `to_tsvector('english', …)`
   which has a built-in Snowball stemmer? The stemmer is more
   aggressive (it stems verbs, comparatives, etc.) which might be
   right or wrong depending on use case — for Amazon product search
   the corpus is noun-heavy, so the aggression is mostly fine,
   but `"natures"` → `"natur"` is a known weirdness.

### On the backfill

5. Anything in A–G above we should drop or add to?
6. Is there a way to use **generated columns** here? The columns
   depend on a JOIN to `search_terms`, which I don't think
   PG-generated columns can express, but a sanity check would help.
7. Would you advise **batch-and-pause** (smaller chunks, autovacuum
   between) over running each week as a single statement?

---

## Constraints / non-goals

- Stay in pure Postgres SQL. We don't want to ship a custom C
  extension or pull in a non-trivial dependency.
- The same logic has to run in two places: the per-import insert path
  and the historical backfill. The SQL fragment must be parameterizable
  in both.
- No schema redesign. We just added the four loose columns; we don't
  want to remove or move them.
- Backfill should be safely interruptible/resumable (current script is
  via `WHERE keyword_in_title_1_loose IS NULL`).
- We need to preserve the strict columns as-is (Amazon's raw flag).
  We're only changing what we put into the loose columns.

---

## What's already shipped (not for change in this RFC)

- Migration 0014 added the four loose columns to kwm.
- `inngest/functions/importFile.ts` populates the loose columns at
  INSERT time using the current (buggy-on-apostrophes, no-plurals)
  SQL fragment.
- UI on `/explorer/keyword/<id>` defaults to loose, with a toggle to
  see strict.
- 6 of 55 weeks were backfilled with the current SQL before we paused.
  Those weeks will need to be re-run once the new logic is finalized.
