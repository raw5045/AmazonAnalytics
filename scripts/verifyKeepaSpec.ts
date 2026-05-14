/**
 * Keepa API verification script — run this BEFORE committing to a
 * paid tier to confirm token cost per ASIN + response data shape.
 *
 * Set KEEPA_API_KEY in .env.local (get it from
 * https://keepa.com/#!api after signing up).
 *
 * What it does:
 *   1. Pulls 6 representative ASINs from the current kcs across diverse
 *      categories (supplement, electronics, apparel, etc).
 *   2. For each ASIN, fires three Keepa /product calls with progressively
 *      more parameters: default, stats=1, stats=1&history=1.
 *   3. Records tokensLeft from the response header before/after each
 *      call so we know the EXACT per-call token cost.
 *   4. Inspects the response JSON and reports whether the fields we
 *      care about (current price, review count, average rating, full
 *      category tree) are populated.
 *
 * After running, share the output (or just the summary table at the
 * bottom) and we'll redo the tier math with real numbers.
 *
 * Usage: pnpm tsx scripts/verifyKeepaSpec.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

const KEEPA_DOMAIN = 1; // Amazon.com
const KEEPA_API_KEY = process.env.KEEPA_API_KEY;

interface SampleAsin {
  asin: string;
  category: string;
  searchTerm: string;
  rank: number;
}

interface CallResult {
  paramSet: string;
  asin: string;
  tokensBefore: number | null;
  tokensAfter: number | null;
  tokensSpent: number | null;
  hasCurrentPrice: boolean;
  hasReviewCount: boolean;
  hasAverageRating: boolean;
  hasCategoryTree: boolean;
  categoryTreeDepth: number;
  categoryTreePath: string;
  fullResponseSize: number;
  errorMessage: string | null;
}

async function fetchSampleAsins(): Promise<SampleAsin[]> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, statement_timeout: 60_000 });
  const c = await pool.connect();
  try {
    const { rows: meta } = await c.query<{ week: string; year: string }>(`
      SELECT current_week_end_date::text AS week,
             EXTRACT(YEAR FROM current_week_end_date)::text AS year
      FROM keyword_current_summary_meta WHERE singleton = true
    `);
    const week = meta[0].week;
    const partition = `keyword_weekly_metrics_${meta[0].year}`;

    // Pick one top-ranked ASIN from each of a diverse set of categories.
    const targetCategories = [
      'Health & Personal Care',
      'Electronics',
      'Apparel',
      'Kitchen',
      'Pet Products',
      'Beauty',
    ];
    const samples: SampleAsin[] = [];
    for (const cat of targetCategories) {
      const { rows } = await c.query<{ asin: string; search_term_raw: string; rank: number }>(
        `
        SELECT kwm.top_clicked_product_1_asin AS asin,
               st.search_term_raw,
               kwm.actual_rank AS rank
        FROM ${partition} kwm
        JOIN search_terms st ON st.id = kwm.search_term_id
        WHERE kwm.week_end_date = $1::date
          AND kwm.top_clicked_category_1 = $2
          AND kwm.actual_rank <= 100000
          AND kwm.top_clicked_product_1_asin IS NOT NULL
        ORDER BY kwm.actual_rank ASC
        LIMIT 1
        `,
        [week, cat],
      );
      if (rows[0]) {
        samples.push({
          asin: rows[0].asin,
          category: cat,
          searchTerm: rows[0].search_term_raw,
          rank: rows[0].rank,
        });
      }
    }
    return samples;
  } finally {
    c.release();
    await pool.end();
  }
}

async function callKeepa(
  asin: string,
  params: Record<string, string | number>,
): Promise<{ data: unknown; tokensLeft: number | null; error: string | null }> {
  const qs = new URLSearchParams({
    key: KEEPA_API_KEY ?? '',
    domain: String(KEEPA_DOMAIN),
    asin,
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });
  const url = `https://api.keepa.com/product?${qs.toString()}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    // Keepa returns tokensLeft IN the response body (not header).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tl = (data as any).tokensLeft ?? null;
    if (!res.ok) {
      return { data, tokensLeft: tl, error: `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}` };
    }
    return { data, tokensLeft: tl, error: null };
  } catch (e) {
    return { data: null, tokensLeft: null, error: (e as Error).message };
  }
}

function inspectResponse(data: unknown): {
  hasCurrentPrice: boolean;
  hasReviewCount: boolean;
  hasAverageRating: boolean;
  hasCategoryTree: boolean;
  categoryTreeDepth: number;
  categoryTreePath: string;
  fullResponseSize: number;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any;
  const product = d?.products?.[0];
  const fullResponseSize = JSON.stringify(d).length;

  if (!product) {
    return {
      hasCurrentPrice: false,
      hasReviewCount: false,
      hasAverageRating: false,
      hasCategoryTree: false,
      categoryTreeDepth: 0,
      categoryTreePath: '',
      fullResponseSize,
    };
  }

  // Current price can be in several places depending on Keepa params:
  //   product.csv[1] for "Amazon" price history (most recent value)
  //   product.csv[0] for "Buybox" price history
  //   product.stats.current[0..1] when stats=1
  // We just check whether any of these have a non-null value.
  const csv = product.csv;
  const csvAmazon = Array.isArray(csv?.[0]) && csv[0].length >= 2 ? csv[0] : null;
  const csvBuyBox = Array.isArray(csv?.[1]) && csv[1].length >= 2 ? csv[1] : null;
  const statsCurrent = product.stats?.current;
  const hasCurrentPrice =
    (csvAmazon?.[csvAmazon.length - 1] ?? -1) > 0
    || (csvBuyBox?.[csvBuyBox.length - 1] ?? -1) > 0
    || (Array.isArray(statsCurrent) && statsCurrent.some((v: number) => v > 0));

  // Review count: stats.current[16] usually, OR product.reviewCount, OR derived from csv[16]
  const csvReviews = Array.isArray(csv?.[16]) && csv[16].length >= 2 ? csv[16] : null;
  const hasReviewCount =
    (product.reviewCount !== undefined && product.reviewCount !== null)
    || (statsCurrent?.[16] !== undefined && statsCurrent[16] >= 0)
    || (csvReviews?.[csvReviews.length - 1] ?? -1) >= 0;

  // Average rating: stats.current[17] usually (0-50 scale, divide by 10)
  // OR product.rating, OR product.csv[17]
  const csvRating = Array.isArray(csv?.[17]) && csv[17].length >= 2 ? csv[17] : null;
  const hasAverageRating =
    (product.rating !== undefined && product.rating !== null)
    || (statsCurrent?.[17] !== undefined && statsCurrent[17] >= 0)
    || (csvRating?.[csvRating.length - 1] ?? -1) >= 0;

  // Category tree: array of { catId, name }, ordered root → leaf
  const tree = product.categoryTree;
  const hasCategoryTree = Array.isArray(tree) && tree.length > 0;
  const categoryTreeDepth = hasCategoryTree ? tree.length : 0;
  const categoryTreePath = hasCategoryTree
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? tree.map((n: any) => n.name ?? `#${n.catId}`).join(' › ')
    : '';

  return {
    hasCurrentPrice,
    hasReviewCount,
    hasAverageRating,
    hasCategoryTree,
    categoryTreeDepth,
    categoryTreePath,
    fullResponseSize,
  };
}

async function main() {
  if (!KEEPA_API_KEY) {
    console.error('Set KEEPA_API_KEY in .env.local first. Get one from https://keepa.com/#!api');
    process.exit(1);
  }

  console.log('\nFetching sample ASINs from current kcs...');
  const samples = await fetchSampleAsins();
  console.log(`Got ${samples.length} samples:`);
  for (const s of samples) {
    console.log(`  ${s.asin}  (rank ${s.rank.toString().padStart(5)})  ${s.category.padEnd(28)}  "${s.searchTerm}"`);
  }

  const paramSets: Array<{ name: string; params: Record<string, string | number> }> = [
    { name: 'default', params: {} },
    { name: 'stats=1', params: { stats: 1 } },
    { name: 'stats=1&history=1', params: { stats: 1, history: 1 } },
  ];

  console.log(`\nRunning ${samples.length * paramSets.length} Keepa calls...\n`);
  const results: CallResult[] = [];
  for (const set of paramSets) {
    for (const s of samples) {
      const before = results.length > 0 ? results[results.length - 1].tokensAfter : null;
      const res = await callKeepa(s.asin, set.params);
      const after = res.tokensLeft;
      const spent = before !== null && after !== null ? before - after : null;
      const inspect = inspectResponse(res.data);
      results.push({
        paramSet: set.name,
        asin: s.asin,
        tokensBefore: before,
        tokensAfter: after,
        tokensSpent: spent,
        ...inspect,
        errorMessage: res.error,
      });
      console.log(
        `  [${set.name.padEnd(18)}] ${s.asin}  tokensLeft=${after?.toString().padStart(6) ?? '   ?  '}  spent=${spent?.toString().padStart(3) ?? ' ? '}  ${res.error ? 'ERROR: ' + res.error.slice(0, 60) : 'OK'}`,
      );
    }
  }

  // Summary
  console.log(`\n=== Summary by param set ===\n`);
  for (const set of paramSets) {
    const setResults = results.filter((r) => r.paramSet === set.name);
    const spents = setResults.map((r) => r.tokensSpent).filter((n): n is number => n !== null);
    const avgSpent = spents.length > 0 ? spents.reduce((a, b) => a + b, 0) / spents.length : null;
    const minSpent = spents.length > 0 ? Math.min(...spents) : null;
    const maxSpent = spents.length > 0 ? Math.max(...spents) : null;
    const withPrice = setResults.filter((r) => r.hasCurrentPrice).length;
    const withReviews = setResults.filter((r) => r.hasReviewCount).length;
    const withRating = setResults.filter((r) => r.hasAverageRating).length;
    const withCats = setResults.filter((r) => r.hasCategoryTree).length;
    const avgDepth = setResults.reduce((s, r) => s + r.categoryTreeDepth, 0) / setResults.length;
    console.log(`Param set: ${set.name}`);
    console.log(`  tokens/call (avg/min/max):  ${avgSpent?.toFixed(2) ?? '?'} / ${minSpent ?? '?'} / ${maxSpent ?? '?'}`);
    console.log(`  has current price:          ${withPrice} / ${setResults.length}`);
    console.log(`  has review count:           ${withReviews} / ${setResults.length}`);
    console.log(`  has average rating:         ${withRating} / ${setResults.length}`);
    console.log(`  has category tree:          ${withCats} / ${setResults.length}  (avg depth ${avgDepth.toFixed(1)})`);
    console.log();
  }

  // Show example category trees so we can see the depth/quality
  console.log(`=== Category tree examples (first ASIN per param set) ===\n`);
  for (const set of paramSets) {
    const first = results.find((r) => r.paramSet === set.name && r.hasCategoryTree);
    if (first) {
      console.log(`[${set.name}] ${first.asin}:`);
      console.log(`  ${first.categoryTreePath}`);
    }
  }

  // Recommendation
  console.log(`\n=== Recommendation ===\n`);
  const defaultResults = results.filter((r) => r.paramSet === 'default');
  const defaultSpent = defaultResults.map((r) => r.tokensSpent).filter((n): n is number => n !== null);
  const defaultAvg = defaultSpent.length > 0 ? defaultSpent.reduce((a, b) => a + b, 0) / defaultSpent.length : null;
  const defaultAllOk = defaultResults.every((r) => r.hasCurrentPrice && r.hasReviewCount && r.hasAverageRating && r.hasCategoryTree);

  if (defaultAvg !== null && defaultAllOk) {
    console.log(`The DEFAULT param set returns everything we need at ${defaultAvg.toFixed(2)} tokens/ASIN.`);
    console.log(`Top 100K scope = 140,857 ASINs × ${defaultAvg.toFixed(2)} tokens = ${Math.round(140857 * defaultAvg).toLocaleString()} tokens/week.`);
    console.log(`At 250 tokens/min: ${(140857 * defaultAvg / 250 / 60).toFixed(1)} hours/week.`);
  } else {
    console.log(`Default params didn't return everything. Check the per-param-set summary above to see which fields require stats=1 or history=1.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
