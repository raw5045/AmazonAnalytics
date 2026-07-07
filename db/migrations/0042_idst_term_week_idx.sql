-- 0042: per-keyword index on import_duplicate_search_terms.
--
-- The table (~2M rows / 428MB) was indexed only by uploaded_file_id, by
-- week_end_date, and by its PK. The detail page reads it per KEYWORD:
--   - variants box: WHERE search_term_id = $1 AND week_end_date = $2
--     (walked the whole week's ~100k rows via idst_week_idx — worst when
--     the keyword has no variants, i.e. the common case)
--   - raw-history variants: WHERE search_term_id = $1
--     (no usable index at all → full seq scan per page view)
-- The composite serves both: exact for the first, leading-column for the
-- second.
--
-- idst is NOT part of the kcs stage/live rename-swap — single physical
-- table, so no index twin is needed (the BOTH-tables rule doesn't apply).

CREATE INDEX IF NOT EXISTS idst_term_week_idx
  ON import_duplicate_search_terms (search_term_id, week_end_date);
