-- Performance fix for migration 0016's loose-match functions.
--
-- Three changes:
--   1. New helper loose_match_padded(search_tokens text[], title_norm text)
--      that takes PRE-COMPUTED inputs. Avoids re-tokenizing the search
--      term and re-normalizing the title for every per-slot call.
--   2. loose_title_flags_3 rewritten as a pure SQL function (was plpgsql).
--      Plpgsql functions can't be inlined by the planner; pure SQL with
--      IMMUTABLE PARALLEL SAFE can be inlined. The new function uses a
--      CTE chain that materializes search tokens + 3 title norms exactly
--      once each per row, then references them across all four output
--      values.
--   3. loose_match_title rewritten as a thin wrapper around
--      loose_match_padded so the ad-hoc / verifier path stays consistent
--      with the hot path.

-- Per-call: search_tokens and title_norm are precomputed once by the
-- caller. Returns NULL when title_norm is NULL. Returns TRUE iff every
-- non-stopword search token has at least one bidirectional candidate
-- form appearing as a padded whole word in the title.
CREATE OR REPLACE FUNCTION loose_match_padded(search_tokens text[], title_norm text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
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
$$;

-- Thin wrapper: precomputes once and delegates. Kept for the verifier
-- and ad-hoc queries.
CREATE OR REPLACE FUNCTION loose_match_title(normalized_search text, title text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT loose_match_padded(
    loose_search_tokens(normalized_search),
    loose_title_norm(title)
  );
$$;

-- Drop the plpgsql version before recreating as SQL. CREATE OR REPLACE
-- cannot change a function's language.
DROP FUNCTION IF EXISTS loose_title_flags_3(text, text, text, text, boolean, boolean, boolean);

-- Composite-returning SQL function. The CTE chain ensures:
--   - loose_search_tokens evaluates ONCE per row (not 3x)
--   - loose_title_norm evaluates ONCE per title (not 6x via re-evaluation)
--   - The match check pays the function-call overhead only when not shorted out
CREATE FUNCTION loose_title_flags_3(
  normalized_search text,
  title1 text,
  title2 text,
  title3 text,
  strict1 boolean,
  strict2 boolean,
  strict3 boolean
)
RETURNS loose_title_flags
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
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
    f1,
    f2,
    f3,
    (COALESCE(f1::int, 0) + COALESCE(f2::int, 0) + COALESCE(f3::int, 0))::smallint
  )::loose_title_flags
  FROM flags;
$$;
