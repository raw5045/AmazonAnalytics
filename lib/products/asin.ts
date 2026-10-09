// lib/products/asin.ts
/**
 * The shape of an Amazon ASIN as the ASIN page's route accepts it: exactly ten upper-case letters or
 * digits. No `g` flag, so `test` keeps no state between calls; `$` without `m` does not match before
 * a trailing newline.
 */
export const ASIN_RE = /^[A-Z0-9]{10}$/;

export function isAsin(s: string): boolean {
  return ASIN_RE.test(s);
}
