-- 0036_keyword_chart_series.sql
-- Compact per-keyword chart-data store for the detail page.
--
-- Each row holds one search term's most-recent ≤52 weeks of chart
-- fields as a jsonb array. The detail page reads this single row to
-- render all chart series without scanning keyword_weekly_metrics.
--
-- Populated/maintained by:
--   - A one-time backfill script (scripts/backfillChartSeries.ts)
--   - refreshSummary (appends the newest week, trims beyond 52w)
--
-- The jsonb array elements use short keys (w, r, sev, es, cs, vs,
-- t, tl) to keep the row compact. See ChartSeriesEntry in
-- db/schema/keywordChartSeries.ts for the full shape.

CREATE TABLE IF NOT EXISTS keyword_chart_series (
  search_term_id uuid        PRIMARY KEY REFERENCES search_terms(id) ON DELETE CASCADE,
  series         jsonb       NOT NULL,
  last_week      date        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
