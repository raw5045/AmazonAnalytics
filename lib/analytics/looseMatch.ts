/**
 * Loose title-match: every non-stopword token in the search term must
 * appear (as a whole word, possibly via a plural-candidate form) in the
 * product title. Order-independent; words in between are fine.
 *
 * Search side input: `search_term_normalized` (already lowercased,
 * apostrophe-stripped, alphanumeric-and-space). See `normalizeForMatch`
 * in `derivedFields.ts`.
 *
 * Title side input: raw title text. We normalize here.
 *
 * Mirrors the Postgres `loose_match` function (migration 0015). See
 * `scripts/verifyLooseMatchSql.ts` for the JS-SQL agreement check.
 */

const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','by','for','from','has','have',
  'in','is','it','its','of','on','or','that','the','this','to','with',
]);

const NO_STRIP_EXCEPTIONS = new Set([
  'gas','news','hers','ours','yours','lens','series','species','keys',
]);

/**
 * Generate the plural candidate set for a single normalized token.
 * Always includes the original. Returned in deterministic order:
 * original first, then derived forms.
 */
export function looseTokenForms(token: string): string[] {
  if (!token) return [];
  // Exceptions short-circuit first: words like "series" that look like
  // plurals by surface shape but aren't.
  if (NO_STRIP_EXCEPTIONS.has(token)) return [token];
  if (token.length > 4 && token.endsWith('ies')) {
    const stem = token.slice(0, -3);
    return [token, `${stem}y`, `${stem}ie`];
  }
  if (/(sses|xes|zes|shes|ches)$/.test(token)) {
    return [token, token.slice(0, -2)];
  }
  if (
    token.length > 3
    && token.endsWith('s')
    && !/(ss|us|is)$/.test(token)
  ) {
    return [token, token.slice(0, -1)];
  }
  return [token];
}

/**
 * Normalize a raw title to the same shape as `search_term_normalized`:
 *   - lowercase
 *   - drop apostrophes (curly + straight)
 *   - non-alphanumeric → space
 *   - collapse whitespace
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Tokenize + apply plural-candidate expansion + flatten to a Set.
 * Used for the title side. Returns the union of all candidate forms
 * across all tokens.
 */
function titleForms(title: string): Set<string> {
  const normalized = normalizeTitle(title);
  const forms = new Set<string>();
  for (const tok of normalized.split(' ')) {
    if (!tok) continue;
    for (const f of looseTokenForms(tok)) forms.add(f);
  }
  return forms;
}

/**
 * Get the set of search-side tokens after stopword filtering.
 * Input must already be in `search_term_normalized` form.
 */
function searchTokens(normalizedTerm: string): string[] {
  return normalizedTerm
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t));
}

/**
 * Full pipeline: return true iff every required search token (or one
 * of its candidate forms) appears in the title's form set.
 * Returns null when title is null.
 */
export function looseMatch(searchTermNormalized: string, title: string | null): boolean | null {
  if (title === null || title === undefined) return null;
  const tokens = searchTokens(searchTermNormalized);
  if (tokens.length === 0) return false;
  const forms = titleForms(title);
  for (const tok of tokens) {
    const candidates = looseTokenForms(tok);
    if (!candidates.some((c) => forms.has(c))) return false;
  }
  return true;
}
