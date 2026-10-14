// lib/baCategory/assignCodes.ts
/**
 * The pure core of the crosswalk (spec 2026-10-14 §5.2): from one week's votes (one per training
 * product, grouped by the product's Keepa path and its code) and the catalog's paths, decide one
 * Brand Analytics code per catalog path.
 *
 * Votes count at the path itself and at every ancestor (`Health & Household`, `Health & Household ›
 * Household Supplies`, …), so a path with too few votes borrows its parent's majority. For each
 * catalog path the first prefix, from the path itself upward, with at least MIN_VOTES votes decides;
 * a department (level 1) under MIN_VOTES still decides with any vote at all; a path whose department
 * has no vote gets no row (its products show no category).
 *
 * Deterministic and pure: ties between codes break by code text ascending; the rows come back sorted
 * by path; the inputs are not mutated. No I/O.
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
  /** Training products at sourcePath, all codes. */
  votes: number;
  /** The winning code's share of those votes, rounded to a whole percent. */
  sharePct: number;
}

/**
 * Votes a prefix needs to decide on its own. At 20 a 17–3 split is still an 85 % majority, while under
 * it a handful of single-keyword accidents could decide a leaf; higher, and the backoff loses the fine
 * split a leaf gives (measured 2026-10-14: 5,194 paths with 20+ votes hold 86 % of fetched products).
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

export function assignCodes(votes: readonly CrosswalkVote[], catalogPaths: readonly string[], minVotes: number = MIN_VOTES): CrosswalkRow[] {
  // Votes per code at every prefix of every voting path.
  const tallies = new Map<string, Map<string, number>>();
  for (const v of votes) {
    if (!(v.products > 0)) continue;
    for (const prefix of prefixesOf(v.path)) {
      let byCode = tallies.get(prefix);
      if (!byCode) tallies.set(prefix, (byCode = new Map()));
      byCode.set(v.code, (byCode.get(v.code) ?? 0) + v.products);
    }
  }
  const decide = (prefix: string): Decision | null => {
    const byCode = tallies.get(prefix);
    if (!byCode) return null;
    let total = 0;
    let winner: { code: string; n: number } | null = null;
    for (const [code, n] of byCode) {
      total += n;
      if (winner === null || n > winner.n || (n === winner.n && code < winner.code)) winner = { code, n };
    }
    if (winner === null || total === 0) return null;
    return { code: winner.code, sourcePath: prefix, votes: total, sharePct: Math.round((100 * winner.n) / total) };
  };
  const rows: CrosswalkRow[] = [];
  for (const path of [...new Set(catalogPaths)].sort()) {
    const prefixes = prefixesOf(path);
    let decided: Decision | null = null;
    for (const prefix of prefixes) {
      const d = decide(prefix);
      if (d !== null && d.votes >= minVotes) { decided = d; break; }
    }
    // The department (the last prefix) decides under the threshold when it has any vote at all.
    if (decided === null) decided = decide(prefixes[prefixes.length - 1]);
    if (decided !== null) rows.push({ categoryPath: path, ...decided });
  }
  return rows;
}
