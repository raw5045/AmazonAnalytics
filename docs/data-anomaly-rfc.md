# Data Anomaly RFC — duplicate rows + ON CONFLICT DO NOTHING

## TL;DR

Amazon's Brand Analytics CSV exports contain **phantom duplicate rows**
for many popular keywords. Each phantom has a unicode noise character
(U+FFFC OBJECT REPLACEMENT CHARACTER) prefixed to the search term and a
junk rank in the 700k+ "long-tail bucket." Our import correctly
normalizes the duplicates onto the same `search_term_id`, but uses
`ON CONFLICT (week_end_date, search_term_id) DO NOTHING` when writing
to `keyword_weekly_metrics` (kwm). That means **whichever row Postgres
inserts first wins, non-deterministically**, and the other (often the
real, lower-rank row) is silently discarded.

Result: roughly 5–15% of popular keywords' weekly rank rows are wrong —
showing the phantom row's high junk rank instead of the legit rank.

We need feedback on:
1. **Fix direction** for new imports (pre-strip + dedupe at parse, vs. deterministic ON CONFLICT)
2. **How to recover existing data** without re-importing 53 weeks the slow way
3. **Whether to also tag/flag visible anomalies in the existing data** as a stopgap

---

## System context

- **Stack:** Next.js 16 web app on Vercel + long-running worker on Railway
- **Database:** Neon Postgres
- **Import flow:** Admin uploads CSV → R2 → Inngest worker streams CSV through
  Postgres COPY into `staging_weekly_metrics`, then bulk-INSERT to
  `keyword_weekly_metrics` (kwm) with the JOIN to `search_terms` on a
  normalized form, then TRUNCATE staging
- **Scale:** 53 weeks imported, ~3.8M active terms, 145M kwm rows
- **Refresh:** After each import, a 30-min refresh rebuilds
  `keyword_current_summary` (a snapshot table powering the explorer page)

## Schema essentials

```sql
search_terms (
  id uuid PRIMARY KEY,
  search_term_raw varchar(512) NOT NULL,        -- as-it-appeared in CSV
  search_term_normalized varchar(512) NOT NULL, -- lowercased, punct stripped
  ...,
  UNIQUE (search_term_normalized)
)

keyword_weekly_metrics (
  week_end_date date NOT NULL,
  search_term_id uuid NOT NULL REFERENCES search_terms(id),
  actual_rank integer NOT NULL,
  top_clicked_product_1_asin varchar(20),
  top_clicked_product_1_title text,
  top_clicked_product_1_click_share numeric(5,2),
  top_clicked_product_1_conversion_share numeric(5,2),
  -- ... ~25 other columns ...
  PRIMARY KEY (week_end_date, search_term_id)
) PARTITION BY RANGE (week_end_date);
```

## The normalize function (works correctly — not the bug source)

```ts
export function normalizeForMatch(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')   // strips OBJ, zero-width, punct, etc.
    .replace(/\s+/g, ' ')
    .trim();
}
```

This already handles U+FFFC correctly. `"￼essential oils"` → `"essential oils"`.

## The current INSERT — root cause is here

```sql
INSERT INTO keyword_weekly_metrics (
  week_end_date, search_term_id, actual_rank,
  top_clicked_product_1_asin, ...,
  ...
)
SELECT
  s.week_end_date, st.id, s.actual_rank, ...
FROM staging_weekly_metrics s
JOIN search_terms st ON st.search_term_normalized = s.search_term_normalized
WHERE s.uploaded_file_id = $1
ON CONFLICT (week_end_date, search_term_id) DO NOTHING  -- <-- THE BUG
```

When two staging rows resolve to the same `search_term_id` for the
same week (one clean, one phantom), only one row's metrics survive.
Which one is non-deterministic.

## Evidence we gathered

For "essential oils" (a popular keyword, normally rank ~600-1000):
- ONE search_terms row, raw = `"￼essential oils"` (OBJ-prefixed; whichever
  CSV first inserted this term came in OBJ-prefixed, but normalization
  collapsed it correctly)
- 53 weeks of kwm history; **47 weeks correct** (rank 500-1000),
  **4 weeks wildly wrong**:
  - Nov 15 2025: rank 2,549,167
  - Dec 27 2025: rank 867,607
  - Jan 17 2026: rank 2,662,014
  - Apr 04 2026: rank 747,233
- Three of those four weeks come from CSVs whose filename has `(1)` or
  `(2)` suffix (browser-redownloaded duplicates). One has no suffix.

Spot-checked 4 other popular keywords. All show the same pattern:
- "magic eraser": min rank 4, max rank 1.07M, **7 anomaly weeks**
- "batteries": min rank 164, max rank 2.55M, **7 anomaly weeks**
- "shorts for women": min rank 100, max rank 2.32M, **7 anomaly weeks**
- "tinnitus relief": min rank 2, max rank 34,684, **1 anomaly week**

The anomaly weeks span both clean and `(1)`/`(2)`-suffixed files. We
think Amazon's CSV exports themselves contain phantom rows.

We don't have direct visibility into the CSV files anymore (we couldn't
re-read them after import); the inference is based on:
- The unique characters in the surviving raw values (OBJ char prefix)
- The fact that `ON CONFLICT DO NOTHING` is the only mechanism that
  could silently drop legit rows
- The consistency of the anomaly rank range (700k+) across affected
  rows — it's clearly a "phantom bucket" rank that Amazon assigns

## Why is the data lost?

Once the import runs:
1. Both rows enter staging (we have evidence of this — `search_term_raw`
   in `search_terms` carries the OBJ prefix, suggesting the OBJ row
   was the one that survived for some terms during the search_terms
   INSERT, even if the legit row would have lost the kwm INSERT race
   for other weeks)
2. `ON CONFLICT DO NOTHING` discards one row per (week, term_id)
3. `staging_weekly_metrics` is TRUNCATE'd at end of import
4. The CSV file is in R2 but our import process doesn't re-read it

So the only place the discarded data still exists is the original CSV
files on the admin's local disk. They have all 53 of them.

## The two parts of the fix

### Part A: Stop the bleeding (going forward)

Two options on the table. The user prefers the first because it's
cleaner architecturally:

**A1 — Pre-strip unicode noise during CSV parse, then dedupe at
staging insertion time:**
- Define a "noise stripping" pass: remove U+FFFC, zero-width chars
  (U+200B/C/D, U+FEFF), control chars (U+0000-001F)
- Apply to `searchTerm` before any further processing
- Result: `"￼essential oils"` and `"essential oils"` become byte-identical
  before they enter staging
- Use a Map<rawCleaned, row> in the streamParseCsv loop to dedupe — pick
  the row with the LOWEST `actual_rank` if duplicates are detected
- Insert deduped rows into staging — no possibility of conflict downstream

Pros: cleanest fix, all logic in one place, easier to reason about,
doesn't depend on DB ON CONFLICT semantics
Cons: requires touching the CSV parser, mid-stream dedup state grows
with the deduped row count (manageable — a few MB max)

**A2 — Deterministic ON CONFLICT in kwm INSERT:**
- Change the SQL to:
  ```sql
  ON CONFLICT (week_end_date, search_term_id) DO UPDATE SET
    actual_rank = EXCLUDED.actual_rank,
    top_clicked_product_1_asin = EXCLUDED.top_clicked_product_1_asin,
    -- ... all 25-ish other columns
  WHERE EXCLUDED.actual_rank < keyword_weekly_metrics.actual_rank
  ```
- Now: whichever row inserts first, the LOWER-rank one always wins after
  all rows are processed

Pros: minimal code change, no parse-level changes
Cons: 25-line UPDATE clause, still relies on ON CONFLICT to do the right
thing, doesn't address the root data quality issue (we still have phantom
rows in our intake — they just lose the conflict)

**Hybrid (probably the right answer):** do A1 for cleanliness AND A2
as defense in depth, in case A1 misses an edge case (e.g., a different
unicode noise char we didn't anticipate).

### Part B: Recover existing data

The 53 weeks already imported are roughly 5–15% wrong on popular
keywords. Three options:

**B1 — Re-import all 53 weeks**
- User has the CSVs locally
- Naive cost: 53 imports × ~40 min each (10 min import + 30 min refresh) =
  35 hours
- **Optimization: skip per-import refresh, do one bulk refresh at end:**
  - 53 imports × ~10 min kwm-only = ~9 hours
  - + 1 final refresh = ~30 min
  - Total: ~10 hours, doable overnight
- This requires a small worker change: add a `skipRefresh` parameter to
  `processFileImport` so bulk re-imports don't run the refresh each time

**B2 — Re-import only the most affected weeks**
- Identify which weeks have the highest anomaly count (some kind of
  detection query)
- User re-uploads only those CSVs
- Faster but partial coverage. Some popular keywords stay wrong on
  weeks the user didn't re-import.

**B3 — Live with the noise**
- Document the issue
- Consider client-side anomaly detection on the keyword detail page
  ("this week's rank looks anomalous, possible data quality issue")
- Don't fix historical, just fix forward

## Decisions we need help with

1. **Is hybrid (A1 + A2) the right fix direction**, or is one of them
   enough? Or is there a different approach we missed?

2. **For the staging-level dedup (A1)**: when two rows resolve to the
   same cleaned `search_term_raw` and have different `actual_rank`,
   should we always pick the LOWER rank? Are there edge cases where the
   higher rank could be the legit one (e.g., a real Amazon-tracked
   distinction we shouldn't flatten)?

3. **For existing data**: is the ~10-hour overnight re-import worth
   doing, or is "live with it + flag anomalies on the detail page"
   acceptable?

4. **Defense in depth**: should we also add a CHECK constraint or
   trigger on `search_terms` that rejects rows with non-printable
   characters in the raw value, to catch this kind of issue earlier in
   future?

5. **Are there other unicode-noise patterns we should pre-emptively
   handle**? We saw OBJ char (U+FFFC). Are there others to worry about
   based on common Excel/CSV quirks (BOM at start, NBSP, RTL marks,
   etc.)?

## What we want feedback on

- Is the root-cause analysis complete, or are we missing a possibility?
- Is the proposed fix overengineered or underengineered?
- Any sharper way to recover historical data without re-importing all
  53 CSVs?

---

*Posted after a systematic-debugging investigation that confirmed the
ON CONFLICT non-determinism via the surviving data pattern. Awaiting
input before implementing.*
