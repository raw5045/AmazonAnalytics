/**
 * Search-term cleaning + normalization.
 *
 * Two related but distinct functions:
 *
 *   cleanSearchTermForDisplay(s)
 *     - Used for the human-visible representation (UI, audit logs).
 *     - Preserves capitalization, punctuation, accents.
 *     - Strips invisible / control / format chars (OBJ, ZWSP, BOM, etc.)
 *       and collapses whitespace.
 *     - NFC normalization so visually-identical strings compare equal.
 *
 *   normalizeForMatch(s)
 *     - Used as the database match key (search_term_normalized) and
 *       for keyword-in-title matching.
 *     - Applies cleanSearchTermForDisplay first, then NFKC + lowercase
 *       + apostrophe strip + replace remaining non-alphanumeric chars
 *       with spaces.
 *     - NFKC (compatibility form) intentionally collapses visually-
 *       distinct-but-compatible chars together (e.g. ligatures) so
 *       search matching is forgiving.
 *
 * The invisible-char list reflects common CSV/Excel/copy-paste quirks
 * plus what we've directly observed in Amazon's BA exports (notably
 * U+FFFC OBJECT REPLACEMENT CHARACTER). See per-range comments below.
 */

/**
 * Source-of-truth list of characters we drop entirely (not replaced
 * with a space) when cleaning search terms for display. Built as a
 * unicode-flagged RegExp via explicit escapes — never embed raw
 * invisible chars in source code.
 *
 * Categories:
 *   Observed in Amazon BA CSV exports:
 *     U+FFFC OBJECT REPLACEMENT CHARACTER     <- the main offender
 *     U+FFFD REPLACEMENT CHARACTER             <- decode error placeholder
 *
 *   Common CSV/Excel/copy-paste residue:
 *     U+FEFF BOM / ZERO WIDTH NO-BREAK SPACE
 *     U+200B-U+200D zero-width space/non-joiner/joiner
 *     U+2060          word joiner
 *     U+00AD          soft hyphen
 *
 *   Bidi / directionality marks:
 *     U+200E-U+200F   LRM, RLM
 *     U+061C          ARABIC LETTER MARK
 *     U+202A-U+202E   bidi embeddings/overrides
 *     U+2066-U+2069   bidi isolates (subset of ⁠-⁯ below)
 *
 *   Other format chars:
 *     U+034F          COMBINING GRAPHEME JOINER
 *     U+180E          MONGOLIAN VOWEL SEPARATOR (legacy)
 *
 *   C0 / C1 control chars:
 *     U+0000-U+001F   C0 controls
 *     U+007F          DELETE
 *     U+0080-U+009F   C1 controls
 *
 * Whitespace separators (U+00A0 NBSP, U+202F narrow NBSP, etc.) are
 * NOT in this list - they're caught by the \p{Zs} pass which maps
 * them to ordinary space rather than deleting them.
 */
const INVISIBLE_OR_CONTROL_PATTERN =
  '[' +
  '\\u0000-\\u001F' + // C0 controls
  '\\u007F-\\u009F' + // DEL + C1 controls
  '\\u00AD' + // soft hyphen
  '\\u034F' + // combining grapheme joiner
  '\\u061C' + // arabic letter mark
  '\\u180E' + // mongolian vowel separator
  '\\u200B-\\u200F' + // zero-width space/joiner family + LRM/RLM
  '\\u202A-\\u202E' + // bidi embeddings/overrides
  '\\u2060-\\u206F' + // word joiner + bidi isolates + invisible math
  '\\uFEFF' + // BOM / ZWNBSP
  '\\uFFFC' + // object replacement
  '\\uFFFD' + // decode-error replacement
  ']';

const INVISIBLE_OR_CONTROL_GLOBAL = new RegExp(INVISIBLE_OR_CONTROL_PATTERN, 'gu');

/**
 * Cleaned display form of a raw search term:
 *   1. NFC normalize (combine code points)
 *   2. Drop invisible/control/format/placeholder chars
 *   3. Map any unicode space-separator (NBSP, narrow NBSP, etc.) to
 *      ordinary space
 *   4. Collapse runs of whitespace
 *   5. Trim
 */
export function cleanSearchTermForDisplay(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFC')
    .replace(INVISIBLE_OR_CONTROL_GLOBAL, '')
    .replace(/\p{Zs}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns true iff cleaning the input would change it. Used to set the
 * staging had_unicode_noise flag so we can audit how often Amazon's
 * CSVs ship corrupt rows. Cheap and exact: same as
 * cleanSearchTermForDisplay(s) !== s, just inlined.
 */
export function hadUnicodeNoise(s: string | null | undefined): boolean {
  if (!s) return false;
  return cleanSearchTermForDisplay(s) !== s;
}

/**
 * Match-key form: lowercased, accent/punctuation/symbol-insensitive
 * canonical key for grouping equivalent search terms.
 *
 * Pipeline:
 *   - cleanSearchTermForDisplay (NFC, strip invisible)
 *   - NFKC (compatibility form: collapses ligatures, fullwidth, etc.)
 *   - lowercase
 *   - drop apostrophes (so "nature's" matches "natures")
 *   - replace non-letter/non-number/non-whitespace with space
 *   - collapse whitespace, trim
 */
export function normalizeForMatch(s: string | null | undefined): string {
  if (!s) return '';
  return cleanSearchTermForDisplay(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns true if the normalized title contains the normalized keyword as a contiguous phrase. */
export function keywordInTitle(keyword: string, title: string | null | undefined): boolean {
  if (!title) return false;
  const nKw = normalizeForMatch(keyword);
  const nTitle = normalizeForMatch(title);
  if (!nKw || !nTitle) return false;
  return nTitle.includes(nKw);
}

/** Counts how many of the given titles contain the keyword. */
export function computeTitleMatchCount(
  keyword: string,
  titles: (string | null | undefined)[],
): number {
  return titles.reduce((sum, t) => (keywordInTitle(keyword, t) ? sum + 1 : sum), 0);
}
