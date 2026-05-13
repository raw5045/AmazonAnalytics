-- One-row metadata table for keyword_current_summary (kcs).
--
-- Why this exists: kcs is a denormalized snapshot rebuilt weekly via
-- stage-and-swap. All rows always share the same current_week_end_date
-- value, so adding a "WHERE current_week_end_date = ?" predicate to
-- explorer queries doesn't filter anything — but it gives Postgres the
-- leading-column equality needed to use the existing composite indexes
-- (kcs_rank_idx, kcs_category_idx, etc.) for sorted output instead of
-- falling back to seq scan + sort-to-disk.
--
-- To avoid making the 3.9M-row kcs answer its own metadata question
-- via MAX() on every request, we stash the current week here and
-- update it in the same transaction as the kcs swap (see refreshSummary).
--
-- Kill switch for the new fast path: `TRUNCATE keyword_current_summary_meta;`
-- — runQuery.ts catches the empty result and reverts to today's behavior
-- (no predicate, slow seq scan + sort). Recovery is `INSERT ... SELECT MAX()`.

CREATE TABLE keyword_current_summary_meta (
  -- Singleton constraint: the table holds at most one row.
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  current_week_end_date date NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill the current state from kcs itself so the row exists from
-- the moment this migration applies. The next refreshSummary run will
-- update it atomically with the kcs swap.
INSERT INTO keyword_current_summary_meta (singleton, current_week_end_date)
SELECT true, MAX(current_week_end_date)
FROM keyword_current_summary
ON CONFLICT (singleton) DO UPDATE
  SET current_week_end_date = EXCLUDED.current_week_end_date,
      refreshed_at = now();

COMMENT ON TABLE keyword_current_summary_meta IS
  'Single-row metadata for kcs. Holds the current_week_end_date that all '
  'kcs rows share, so explorer queries can inject it as a leading-column '
  'equality predicate and let the existing composite indexes serve sorted '
  'output. Updated atomically in the refreshSummary stage-and-swap.';
