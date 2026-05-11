/**
 * Loose title-match: every non-stopword token in the search term must
 * appear (as a whole word, possibly via a plural-candidate form) in the
 * product title. Order-independent; words in between are fine.
 *
 * Algorithm (per the perf-update RFC, Phase 1):
 *   - Title side: normalize once to a padded lowercase string
 *     " creatine gummies supplement " (cheap, single pass).
 *   - Search side: tokenize, drop stopwords, generate BIDIRECTIONAL
 *     plural candidates per token (e.g. "supplement" → {supplement,
 *     supplements}, "supplements" → {supplements, supplement}).
 *   - Match: for each search token, check whether ANY of its candidate
 *     forms appears as a whole word (padded with spaces) in the title
 *     string.
 *
 * Keeps the expensive plural logic on the SHORT side (search tokens),
 * not on the LONG side (title tokens). Restores ~original performance
 * shape while fixing apostrophe + plural correctness.
 *
 * Mirrors the Postgres functions in migration 0016. See
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
 * Generate the SINGULARIZATION candidate set for one token. Always
 * includes the original. Same rules as the prior version — apply only
 * when the token looks like a plural that we can confidently strip.
 */
export function looseTokenForms(token: string): string[] {
  if (!token) return [];
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
 * BIDIRECTIONAL plural candidates. Generates both:
 *   - singularization (via looseTokenForms): plural → singular forms
 *   - pluralization: singular → likely plural forms
 *
 * Examples:
 *   supplements → {supplements, supplement}  (singularization)
 *   supplement  → {supplement, supplements}  (pluralization)
 *   gummies     → {gummies, gummy, gummie}   (singularization)
 *   gummy       → {gummy, gummies}           (pluralization, y→ies)
 *   box         → {box, boxes}               (pluralization, +es)
 *   creatine    → {creatine, creatines}      (pluralization, +s)
 *   stress      → {stress}                   (guarded)
 */
export function looseTokenFormsBidirectional(token: string): string[] {
  const forms = new Set<string>(looseTokenForms(token));
  if (!token || token.length <= 2) return Array.from(forms);
  if (NO_STRIP_EXCEPTIONS.has(token)) return Array.from(forms);
  // Already ends in -s (either already-plural with singularization handled
  // by looseTokenForms, or pseudo-singular like stress/gas/news). Don't
  // try to pluralize further.
  if (/s$/.test(token)) return Array.from(forms);
  // Singular-looking. Generate a plausible plural.
  if (/[^aeiou]y$/.test(token)) {
    // consonant + y → -ies: gummy → gummies, battery → batteries
    forms.add(token.slice(0, -1) + 'ies');
  } else if (/(x|z|sh|ch)$/.test(token)) {
    // sibilant ending → -es: box → boxes, brush → brushes
    forms.add(token + 'es');
  } else {
    // regular -s: supplement → supplements, creatine → creatines
    forms.add(token + 's');
  }
  return Array.from(forms);
}

/**
 * Normalize a raw title to a PADDED lowercase string for whole-word
 * substring matching. Pad with leading/trailing spaces so any internal
 * token T can be matched via `.includes(' ' + T + ' ')`.
 */
export function looseTitleNorm(title: string | null): string | null {
  if (title === null || title === undefined) return null;
  return ' '
    + title
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    + ' ';
}

/**
 * Get the set of search-side tokens after stopword filtering. Input
 * must already be in `search_term_normalized` form.
 */
function searchTokens(normalizedTerm: string): string[] {
  return normalizedTerm
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t));
}

/**
 * Full pipeline: return true iff every required search token (or one
 * of its bidirectional candidate forms) appears as a whole word in
 * the normalized title. Returns null when title is null.
 */
export function looseMatch(searchTermNormalized: string, title: string | null): boolean | null {
  const titleNorm = looseTitleNorm(title);
  if (titleNorm === null) return null;
  const tokens = searchTokens(searchTermNormalized);
  if (tokens.length === 0) return false;
  for (const tok of tokens) {
    const candidates = looseTokenFormsBidirectional(tok);
    if (!candidates.some((c) => titleNorm.includes(' ' + c + ' '))) {
      return false;
    }
  }
  return true;
}
