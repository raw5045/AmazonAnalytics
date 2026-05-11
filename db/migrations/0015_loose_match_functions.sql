-- Postgres-side implementation of the loose title-match algorithm
-- defined in lib/analytics/looseMatch.ts. Five IMMUTABLE functions:
--
--   loose_token_forms(token text) -> text[]
--     Single normalized token -> array of plural-candidate forms
--     (always includes the original).
--
--   loose_title_forms(title text) -> text[]
--     Raw title -> set (array of distinct values) of all candidate forms
--     across all tokenized words. NULL -> NULL.
--
--   loose_search_tokens(normalized_term text) -> text[]
--     search_term_normalized -> array of non-stopword tokens.
--
--   loose_match(search_tokens text[], title_forms text[]) -> boolean
--     Returns true iff every search token (via any of its candidate
--     forms) appears in title_forms. Returns NULL when title_forms is
--     NULL. Built for the backfill / import path where the inputs are
--     precomputed once per distinct title.
--
--   loose_match_raw(search_term_normalized text, title text) -> boolean
--     Convenience wrapper. Slower (no caching); used in tests and
--     ad-hoc queries.
--
-- The function bodies mirror the rules in lib/analytics/looseMatch.ts;
-- scripts/verifyLooseMatchSql.ts cross-checks them on the JS fixtures.

CREATE OR REPLACE FUNCTION loose_token_forms(token text)
RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN token IS NULL OR token = '' THEN
      ARRAY[]::text[]
    -- Exceptions short-circuit first: words that look plural by surface
    -- shape but aren't (e.g. series, lens, news).
    WHEN token = ANY(ARRAY[
      'gas','news','hers','ours','yours','lens',
      'series','species','keys'
    ]) THEN
      ARRAY[token]
    WHEN length(token) > 4 AND token ~ 'ies$' THEN
      ARRAY[
        token,
        substring(token from 1 for length(token) - 3) || 'y',
        substring(token from 1 for length(token) - 3) || 'ie'
      ]
    WHEN token ~ '(sses|xes|zes|shes|ches)$' THEN
      ARRAY[token, substring(token from 1 for length(token) - 2)]
    WHEN length(token) > 3
         AND token ~ 's$'
         AND token !~ '(ss|us|is)$' THEN
      ARRAY[token, substring(token from 1 for length(token) - 1)]
    ELSE
      ARRAY[token]
  END;
$$;

CREATE OR REPLACE FUNCTION loose_title_forms(title text)
RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN title IS NULL THEN NULL
    ELSE (
      SELECT COALESCE(array_agg(DISTINCT form), ARRAY[]::text[])
      FROM (
        SELECT unnest(loose_token_forms(trim(t))) AS form
        FROM unnest(string_to_array(
          regexp_replace(
            regexp_replace(LOWER(title), '[''’]', '', 'g'),
            '[^a-z0-9]+', ' ', 'g'
          ),
          ' '
        )) AS t
        WHERE trim(t) <> ''
      ) sub
    )
  END;
$$;

CREATE OR REPLACE FUNCTION loose_search_tokens(normalized_term text)
RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  WITH tokens AS (
    SELECT DISTINCT trim(t) AS tok
    FROM unnest(string_to_array(COALESCE(normalized_term, ''), ' ')) AS t
    WHERE trim(t) <> ''
      AND trim(t) NOT IN (
        'a','an','and','are','as','at','be','by','for','from','has',
        'have','in','is','it','its','of','on','or','that','the',
        'this','to','with'
      )
  )
  SELECT COALESCE(array_agg(tok), ARRAY[]::text[]) FROM tokens;
$$;

CREATE OR REPLACE FUNCTION loose_match(search_tokens text[], title_forms text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN title_forms IS NULL THEN NULL
    WHEN search_tokens IS NULL OR cardinality(search_tokens) = 0 THEN FALSE
    ELSE NOT EXISTS (
      SELECT 1 FROM unnest(search_tokens) AS st
      WHERE NOT (loose_token_forms(st) && title_forms)
    )
  END;
$$;

CREATE OR REPLACE FUNCTION loose_match_raw(search_term_normalized text, title text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT loose_match(
    loose_search_tokens(search_term_normalized),
    loose_title_forms(title)
  );
$$;
