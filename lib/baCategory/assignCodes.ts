// lib/baCategory/assignCodes.ts
/**
 * The pure core of the crosswalk (spec 2026-10-14 §5.2): from one week's votes (one per training
 * product, grouped by the product's Keepa path and its code) and the catalog's paths, decide one
 * Brand Analytics code per catalog path.
 *
 * A path's own products decide first: with at least MIN_VOTES of them at the exact path, their
 * majority is its code, so an interior path (one that is also an ancestor of other catalog paths) is
 * not outvoted by its descendants. Otherwise it backs off: votes also count at every ancestor
 * (`Health & Household`, `Health & Household › Household Supplies`, …), and the first prefix, from the
 * path itself upward, whose whole subtree holds at least MIN_VOTES votes decides (the backoff compares
 * subtree totals; for a leaf, its own votes and its subtree are the same). A department (level 1) under
 * MIN_VOTES still decides with any vote at all; a path whose department has no vote gets no row (its
 * products show no category).
 *
 * Deterministic and pure: ties between codes break by code text ascending; the rows come back sorted
 * by path; the inputs are not mutated. No I/O. Code-unit order (as COLLATE "C"); never localeCompare,
 * whose order moves with the ICU data.
 */
import { PATH_SEP } from '@/lib/categoryBuilder/buildTree';

export interface CrosswalkVote {
  /** A Keepa path exactly as asin_products.category_path stores it. */
  path: string;
  /** A Brand Analytics code (Top Clicked Category spelling). */
  code: string;
  /** Training products with this path and this code. */
  products: number;
}

export interface CrosswalkRow {
  categoryPath: string;
  code: string;
  /** The prefix whose votes decided: the path itself, or the ancestor it backed off to. */
  sourcePath: string;
  /** Training products counted at sourcePath: the path's own when they decided it, else its whole subtree, all codes. */
  votes: number;
  /** The winning code's share of those votes, rounded to a whole percent. */
  sharePct: number;
}

/**
 * Votes needed to decide: a path's own products, or the whole subtree of the prefix it backs off to
 * (the path itself first, then each ancestor). A path's majority matches a product's own vote ~88 %
 * of the time, so 20 votes typically split about 17–3 (85 %): a stray vote or two cannot flip it,
 * while under 20 a handful of single-keyword accidents could decide a leaf; higher, and the backoff
 * loses the fine split a leaf gives (measured 2026-10-14: 5,194 paths with 20+ products of their own
 * hold 86 % of fetched products).
 */
export const MIN_VOTES = 20;

/** `A › B › C` → `['A › B › C', 'A › B', 'A']`: the path and every ancestor, deepest first. */
export function prefixesOf(path: string): string[] {
  const levels = path.split(PATH_SEP);
  const out: string[] = [];
  for (let depth = levels.length; depth >= 1; depth--) out.push(levels.slice(0, depth).join(PATH_SEP));
  return out;
}

type Decision = Omit<CrosswalkRow, 'categoryPath'>;

/** Votes per code, keyed by path. */
type Tally = Map<string, Map<string, number>>;

function addVote(tally: Tally, key: string, code: string, products: number): void {
  let byCode = tally.get(key);
  if (!byCode) tally.set(key, (byCode = new Map()));
  byCode.set(code, (byCode.get(code) ?? 0) + products);
}

/** The winning code at `key`, with the total over all codes there and its share; null where nothing was voted. */
function decide(tally: Tally, key: string): Decision | null {
  const byCode = tally.get(key);
  if (!byCode) return null;
  let total = 0;
  let winner: { code: string; n: number } | null = null;
  for (const [code, n] of byCode) {
    total += n;
    if (winner === null || n > winner.n || (n === winner.n && code < winner.code)) winner = { code, n };
  }
  if (winner === null) return null;
  return { code: winner.code, sourcePath: key, votes: total, sharePct: Math.round((100 * winner.n) / total) };
}

export function assignCodes(votes: readonly CrosswalkVote[], catalogPaths: readonly string[]): CrosswalkRow[] {
  // Votes per code at the exact path (own) and at the path and every ancestor (subtree).
  const own: Tally = new Map();
  const subtree: Tally = new Map();
  for (const v of votes) {
    if (!(v.products > 0)) continue;
    addVote(own, v.path, v.code, v.products);
    for (const prefix of prefixesOf(v.path)) addVote(subtree, prefix, v.code, v.products);
  }
  const rows: CrosswalkRow[] = [];
  for (const path of [...new Set(catalogPaths)].sort()) {
    const prefixes = prefixesOf(path);
    let decided: Decision | null = null;
    // The path's own products decide first; else the nearest prefix, from the path upward, whose subtree has enough.
    const ownDecision = decide(own, path);
    if (ownDecision !== null && ownDecision.votes >= MIN_VOTES) {
      decided = ownDecision;
    } else {
      for (const prefix of prefixes) {
        const d = decide(subtree, prefix);
        if (d !== null && d.votes >= MIN_VOTES) { decided = d; break; }
      }
    }
    // The department (the last prefix) decides under the threshold when it has any vote at all.
    if (decided === null) decided = decide(subtree, prefixes[prefixes.length - 1]);
    if (decided !== null) rows.push({ categoryPath: path, ...decided });
  }
  return rows;
}
