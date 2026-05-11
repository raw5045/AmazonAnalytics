/**
 * Code-gen for the flat-predicate loose-match SQL used by the backfill
 * and the import path.
 *
 * The matching algorithm becomes a literal SQL expression:
 *   - For each token slot (1..N): if token_count >= N, at least one of
 *     that slot's pre-padded needle forms must appear in the normalized
 *     title via POSITION.
 *
 * No per-row tokenization, no plural-form generation, no function calls
 * other than POSITION. Same algorithm as loose_match_padded in SQL, but
 * unrolled to avoid the unnest + per-token-array overhead that proved
 * fatal for performance.
 *
 * Use `looseMatchPredicate(reqAlias, titleNormSql)` to build the
 * predicate. Pair with `looseTitleNormSql(titleColumnSql)` for the
 * title-side normalization that produces a padded lowercase alphanum
 * string.
 *
 * Token + form slot widths must match migration 0018.
 */

import { LOOSE_REQ_TOKEN_SLOTS, LOOSE_REQ_FORM_SLOTS } from '@/db/schema/searchTermLooseRequirements';

/**
 * Build the SQL fragment that normalizes a raw title column into a
 * padded lowercase alphanum-only string ready for whole-word matching
 * via POSITION(' ' || needle || ' ' IN result). Returns NULL when the
 * input is NULL.
 *
 * Mirrors the loose_title_norm Postgres function but inline so the
 * planner doesn't pay function-call overhead.
 */
export function looseTitleNormSql(titleColumnSql: string): string {
  return `(CASE WHEN ${titleColumnSql} IS NULL THEN NULL ELSE
    ' ' || trim(regexp_replace(
      regexp_replace(
        regexp_replace(LOWER(${titleColumnSql}), '[''’]', '', 'g'),
        '[^a-z0-9]+', ' ', 'g'
      ),
      '\\s+', ' ', 'g'
    )) || ' '
  END)`;
}

/**
 * Build the flat-predicate SQL for loose match. Returns a boolean
 * expression: TRUE iff every required search token (or one of its
 * stored bidirectional candidate forms) appears as a padded whole word
 * in `titleNormSql`.
 *
 * `reqAlias` is the SQL alias of a `search_term_loose_requirements`
 * row in scope (e.g., 'r' if you `JOIN search_term_loose_requirements r ON ...`).
 * `titleNormSql` is a SQL expression evaluating to a padded title string
 * (typically a CTE column or an inline call to looseTitleNormSql).
 *
 * The caller is expected to short-circuit NULL titles and strict-true
 * rows BEFORE invoking this predicate (it returns FALSE for
 * token_count = 0 to match the function's semantics, but a NULL title
 * needs to be handled separately to yield NULL).
 */
export function looseMatchPredicate(reqAlias: string, titleNormSql: string): string {
  const r = reqAlias;
  const lines: string[] = [];
  // Predicate is: token_count > 0 AND (for each slot N in 1..MAX:
  // token_count < N OR (any of that slot's forms appears))
  lines.push(`${r}.token_count > 0`);
  for (let t = 1; t <= LOOSE_REQ_TOKEN_SLOTS; t++) {
    const formChecks: string[] = [];
    for (let f = 1; f <= LOOSE_REQ_FORM_SLOTS; f++) {
      formChecks.push(
        `(${r}.t${t}_f${f} IS NOT NULL AND POSITION(${r}.t${t}_f${f} IN ${titleNormSql}) > 0)`,
      );
    }
    lines.push(
      `  AND (${r}.token_count < ${t} OR (\n      ${formChecks.join('\n      OR ')}\n    ))`,
    );
  }
  return `(\n  ${lines.join('\n')}\n)`;
}

/**
 * Convenience: full per-slot expression for one product title slot.
 * Wraps the predicate in the null-title + strict-true short-circuits
 * so it yields the same boolean/null result as loose_title_flags_3's
 * f1/f2/f3 fields.
 *
 *   titleSql:  the raw title column expression (e.g., 'kwm.top_clicked_product_1_title')
 *   strictSql: the strict-flag column expression (e.g., 'kwm.keyword_in_title_1')
 *   reqAlias:  alias of the requirements row
 */
export function looseSlotFlagSql(
  titleSql: string,
  strictSql: string,
  reqAlias: string,
): string {
  const titleNorm = looseTitleNormSql(titleSql);
  return `(CASE
    WHEN ${titleSql} IS NULL THEN NULL
    WHEN ${strictSql} IS TRUE THEN TRUE
    WHEN ${reqAlias}.overflow IS TRUE THEN
      -- Slow-path fallback for >${LOOSE_REQ_TOKEN_SLOTS}-token search terms (rare).
      loose_match_title((SELECT search_term_normalized FROM search_terms WHERE id = ${reqAlias}.search_term_id), ${titleSql})
    ELSE ${looseMatchPredicate(reqAlias, titleNorm)}
  END)`;
}
