-- Side table holding pre-computed search-side requirements for the
-- loose-match backfill + import path. Each row stores the set of
-- padded candidate "needles" (e.g. ' creatine ', ' supplements ',
-- ' supplement ', ' gummies ', ' gummy ', ' gummie ') for one
-- search term, organized by token slot.
--
-- The weekly UPDATE then becomes a flat predicate over POSITION
-- checks against precomputed strings — no per-row tokenization, no
-- plural-form generation, no array allocation.
--
-- 8 token slots × 4 form slots = 32 text columns. Sizing comes from
-- empirical token-count distribution: p99 = 6 tokens, 8 slots covers
-- 99.74% of search terms. The ~0.26% overflow rows are flagged via
-- `overflow = TRUE` and processed by the slower function path.

CREATE TABLE search_term_loose_requirements (
  search_term_id uuid PRIMARY KEY REFERENCES search_terms(id) ON DELETE CASCADE,
  token_count smallint NOT NULL,
  overflow boolean NOT NULL DEFAULT false,

  -- 8 token slots × 4 form slots per token. Each cell holds either NULL
  -- (slot unused) or a pre-padded needle like ' creatine '.
  t1_f1 text, t1_f2 text, t1_f3 text, t1_f4 text,
  t2_f1 text, t2_f2 text, t2_f3 text, t2_f4 text,
  t3_f1 text, t3_f2 text, t3_f3 text, t3_f4 text,
  t4_f1 text, t4_f2 text, t4_f3 text, t4_f4 text,
  t5_f1 text, t5_f2 text, t5_f3 text, t5_f4 text,
  t6_f1 text, t6_f2 text, t6_f3 text, t6_f4 text,
  t7_f1 text, t7_f2 text, t7_f3 text, t7_f4 text,
  t8_f1 text, t8_f2 text, t8_f3 text, t8_f4 text,

  logic_version smallint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- For the overflow-handling pass: index on overflow=true so the
-- separate slow-path UPDATE can find them quickly.
CREATE INDEX search_term_loose_requirements_overflow_idx
  ON search_term_loose_requirements (search_term_id)
  WHERE overflow IS TRUE;

COMMENT ON TABLE search_term_loose_requirements IS
  'Precomputed search-side loose-match requirements (per search_term, once). '
  'The backfill / import UPDATE joins to this table and uses a flat POSITION-based '
  'predicate against the precomputed padded needles. Eliminates per-row tokenization '
  'and plural-candidate generation. See lib/analytics/loosePredicate.ts for the '
  'code generator that emits the matching SQL predicate.';
