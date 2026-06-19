/**
 * Turns a user's "search term contains" input into a safe SQL match pattern
 * for the explorer q-filter.
 *
 * - Whole-word (default): a Postgres word-boundary regex `\m<term>\M`,
 *   matched with `~` against the GIN-trigram-indexed normalized column.
 *   Matches the word "hair" in "hair loss" / "best hair oil" but NOT
 *   "chair" / "mohair".
 * - Broad (opt-in): a substring `%<term>%` matched with `LIKE` — the old
 *   behavior, partial-word matches included.
 *
 * Input is lowercased (the normalized column is lowercase) and escaped so
 * regex/LIKE metacharacters in a term (e.g. `c++`, `50%`, `a_b`) match
 * literally and can't break or wildcard the query.
 */

/** Escape characters that are special in a POSIX regular expression. */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape LIKE wildcards + the escape char so they match literally (default `\` escape). */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, '\\$&');
}

/** Whole-word pattern: word-boundary regex, lowercased + escaped. For the `~` operator. */
export function wordPattern(q: string): string {
  return `\\m${escapeRegex(q.toLowerCase())}\\M`;
}

/** Broad substring pattern: lowercased + escaped, wrapped in `%`. For the `LIKE` operator. */
export function broadPattern(q: string): string {
  return `%${escapeLike(q.toLowerCase())}%`;
}
