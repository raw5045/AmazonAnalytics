/**
 * Normalize text for keyword-in-title matching.
 * - Lowercase
 * - Strip apostrophes (so "nature's" matches "natures")
 * - Replace remaining punctuation and non-alphanumeric chars with spaces
 * - Collapse multiple spaces
 * - Trim
 */
export function normalizeForMatch(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/['\u2019]/g, '')
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
