-- Extensions to keyword_current_summary_meta + a new facets table.
--
-- Why: per the explorer-perf RFC followup, cold-load is dominated by
-- two queries that can be precomputed during the kcs refresh:
--
--   1. listCategories (DISTINCT scan, ~5290ms cold) — replaced by a
--      lookup against keyword_current_summary_category_facets.
--   2. Default landing COUNT(*) (~1756ms cold) — replaced by a
--      precomputed total stored on the meta row.
--   3. Category-only filter COUNT (~7700ms cold) — replaced by the
--      per-category default_severity_count column on facets.
--
-- All three are computed once at kcs refresh time and read in
-- single-digit-ms time at request time.
--
-- Adds a `snapshot_version uuid` to meta so caches can be keyed by
-- snapshot rather than week-end-date — important because a same-week
-- replay/hotfix can produce a new snapshot with the same week.
--
-- Kill switches: any of these new fields being missing/NULL falls
-- through to today's slow-but-correct path in app code.

-- Step 1 — Add new columns to meta (nullable initially so the
-- backfill below can populate them before we tighten NOT NULL).
ALTER TABLE keyword_current_summary_meta
  ADD COLUMN snapshot_version uuid,
  ADD COLUMN default_severity_total integer;

-- Step 2 — Generate a snapshot_version + compute the default count
-- for the existing data so the columns are populated immediately.
UPDATE keyword_current_summary_meta
SET
  snapshot_version = gen_random_uuid(),
  default_severity_total = (
    SELECT COUNT(*)::int
    FROM keyword_current_summary
    WHERE fake_volume_severity_current IS NULL
       OR fake_volume_severity_current IN ('none', 'warning')
  )
WHERE singleton = true;

-- Step 3 — Now tighten NOT NULL. If the existing meta row was
-- somehow missing (shouldn't happen post-migration-0020), this would
-- fail; that's the right behavior since the app's fast path expects
-- these to be present.
ALTER TABLE keyword_current_summary_meta
  ALTER COLUMN snapshot_version SET NOT NULL,
  ALTER COLUMN default_severity_total SET NOT NULL;

-- Step 4 — Facets table. Keyed by (snapshot_version, category) so old
-- snapshots can coexist temporarily with new ones (useful for cache
-- consistency during a swap window). The refreshSummary writes rows
-- for the new snapshot_version BEFORE updating meta to point at it,
-- so a reader can never see "meta says X, facets only have Y."
CREATE TABLE keyword_current_summary_category_facets (
  snapshot_version uuid NOT NULL,
  category text NOT NULL,
  /** Count of kcs rows in this category whose severity matches the default explorer filter (NULL/none/warning). */
  default_severity_count integer NOT NULL,
  /** Total kcs row count for this category, all severities. Future use for severity-aware count short-circuits. */
  all_count integer NOT NULL,
  PRIMARY KEY (snapshot_version, category)
);

CREATE INDEX kcs_facets_snapshot_idx
  ON keyword_current_summary_category_facets (snapshot_version);

-- Step 5 — Populate facets for the current snapshot. This GROUP BY
-- runs once at migration time; subsequent maintenance happens inside
-- refreshSummary's swap path. The kcs_category_idx makes this an
-- index-only scan + aggregate.
INSERT INTO keyword_current_summary_category_facets
  (snapshot_version, category, default_severity_count, all_count)
SELECT
  (SELECT snapshot_version FROM keyword_current_summary_meta WHERE singleton = true),
  kcs.top_clicked_category_1_current,
  COUNT(*) FILTER (
    WHERE kcs.fake_volume_severity_current IS NULL
       OR kcs.fake_volume_severity_current IN ('none', 'warning')
  )::int,
  COUNT(*)::int
FROM keyword_current_summary kcs
WHERE kcs.top_clicked_category_1_current IS NOT NULL
GROUP BY kcs.top_clicked_category_1_current;

COMMENT ON TABLE keyword_current_summary_category_facets IS
  'Per-category counts precomputed during kcs refresh. Replaces the cold-slow '
  'SELECT DISTINCT scan in listCategories and the cold-slow per-category COUNT(*) '
  'in the explorer filter path. Keyed by snapshot_version so we can hold old + '
  'new snapshots briefly during a kcs swap.';
