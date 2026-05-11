-- Phase-1 perf-RFC follow-up. Replaces the array/title-form matcher
-- with a padded-string matcher that keeps the expensive plural logic
-- on the short (search-token) side, not the long (title-token) side.
--
-- Adds:
--   loose_title_flags        (composite type for the 3-slot result)
--   loose_title_norm         (title -> padded lowercase string)
--   loose_token_forms_bidirectional (search-token -> {singular,plural}+ forms)
--   loose_match_title        (single-slot matcher: substring on padded title)
--   loose_title_flags_3      (all 3 slots + count, one function call per row)
--
-- Updates:
--   loose_match_raw          (kept name; body now calls loose_match_title)
--
-- Drops (no longer used after the matcher rewrite):
--   loose_match(text[], text[])
--   loose_title_forms(text)

-- Composite type for the 3-slot result returned by loose_title_flags_3.
DO $$ BEGIN
  CREATE TYPE loose_title_flags AS (
    f1 boolean,
    f2 boolean,
    f3 boolean,
    match_count smallint
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Normalize a title to a PADDED lowercase alphanum-only string so any
-- token T can be matched via POSITION(' ' || T || ' ' IN result).
-- Returns NULL on NULL input.
CREATE OR REPLACE FUNCTION loose_title_norm(title text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
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
$$;

-- Bidirectional plural candidates for one search-side token.
-- Includes the original + singularization (via loose_token_forms) +
-- a likely pluralization. Skips pluralization when token already
-- ends in -s (already plural / pseudo-singular like stress) or is
-- in the exception list.
CREATE OR REPLACE FUNCTION loose_token_forms_bidirectional(token text)
RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  WITH base AS (
    SELECT unnest(loose_token_forms(token)) AS f
  ),
  with_plural AS (
    SELECT f FROM base
    UNION
    SELECT CASE
      WHEN token IS NULL OR token = '' THEN NULL
      WHEN length(token) <= 2 THEN NULL
      WHEN token = ANY(ARRAY[
        'gas','news','hers','ours','yours','lens',
        'series','species','keys'
      ]) THEN NULL
      WHEN token ~ 's$' THEN NULL                              -- already ends in s
      WHEN token ~ '[^aeiou]y$' THEN substring(token from 1 for length(token) - 1) || 'ies'
      WHEN token ~ '(x|z|sh|ch)$' THEN token || 'es'
      ELSE token || 's'
    END
  )
  SELECT COALESCE(array_agg(DISTINCT f) FILTER (WHERE f IS NOT NULL), ARRAY[]::text[])
  FROM with_plural;
$$;

-- Single-slot loose matcher. Returns NULL when title is NULL; otherwise
-- true iff every non-stopword search token has at least one
-- bidirectional candidate appearing as a padded whole word in the
-- normalized title.
CREATE OR REPLACE FUNCTION loose_match_title(normalized_search text, title text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  WITH tn AS (SELECT loose_title_norm(title) AS t)
  SELECT CASE
    WHEN (SELECT t FROM tn) IS NULL THEN NULL
    WHEN cardinality(loose_search_tokens(normalized_search)) = 0 THEN FALSE
    ELSE NOT EXISTS (
      SELECT 1 FROM unnest(loose_search_tokens(normalized_search)) AS s
      WHERE NOT EXISTS (
        SELECT 1 FROM unnest(loose_token_forms_bidirectional(s)) AS f
        WHERE POSITION(' ' || f || ' ' IN (SELECT t FROM tn)) > 0
      )
    )
  END;
$$;

-- All 3 slot flags + the count, in one call. Used by the backfill +
-- import path so each row pays one function-call overhead instead of
-- four (or six with the old approach).
CREATE OR REPLACE FUNCTION loose_title_flags_3(
  normalized_search text,
  title1 text,
  title2 text,
  title3 text,
  strict1 boolean,
  strict2 boolean,
  strict3 boolean
)
RETURNS loose_title_flags
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $$
DECLARE
  r loose_title_flags;
BEGIN
  r.f1 := CASE
    WHEN title1 IS NULL THEN NULL
    WHEN strict1 IS TRUE THEN TRUE
    ELSE loose_match_title(normalized_search, title1)
  END;
  r.f2 := CASE
    WHEN title2 IS NULL THEN NULL
    WHEN strict2 IS TRUE THEN TRUE
    ELSE loose_match_title(normalized_search, title2)
  END;
  r.f3 := CASE
    WHEN title3 IS NULL THEN NULL
    WHEN strict3 IS TRUE THEN TRUE
    ELSE loose_match_title(normalized_search, title3)
  END;
  r.match_count := (
    COALESCE(r.f1::int, 0) + COALESCE(r.f2::int, 0) + COALESCE(r.f3::int, 0)
  )::smallint;
  RETURN r;
END;
$$;

-- Update loose_match_raw to call the new matcher so the verifier
-- script keeps working without changes to its query. CREATE OR REPLACE
-- can't rename parameters, so DROP first then CREATE.
DROP FUNCTION IF EXISTS loose_match_raw(text, text);
CREATE FUNCTION loose_match_raw(normalized_search text, title text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT loose_match_title(normalized_search, title);
$$;

-- Drop the no-longer-used array-form matcher and title-forms helper.
DROP FUNCTION IF EXISTS loose_match(text[], text[]);
DROP FUNCTION IF EXISTS loose_title_forms(text);
