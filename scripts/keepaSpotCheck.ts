/**
 * Keepa data-quality spot check.
 *
 * Pulls 15 representative top-ranked ASINs from the current kcs
 * across diverse categories, calls Keepa with rating=1 (2 tokens
 * each = 30 tokens total), and prints a table the user can manually
 * cross-reference against Amazon's live product pages.
 *
 * For each ASIN we show:
 *   - Keepa's reported review count, average rating, current price
 *   - lastRatingUpdate (freshness signal)
 *   - Amazon product URL for one-click verification
 *
 * The user opens the Amazon links and compares against what Keepa
 * returned. If they're within ~10-15% of each other we proceed; if
 * Keepa is materially off we adjust.
 *
 * Saves the output as docs/keepa-spot-check-YYYY-MM-DD.md too so
 * we can reference it in the implementation plan.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';
import { writeFileSync } from 'node:fs';

const KEEPA_API_KEY = process.env.KEEPA_API_KEY;

// Diverse category mix — picks one top-ranked ASIN from each.
const TARGET_CATEGORIES = [
  'Health & Personal Care',
  'Electronics',
  'Apparel',
  'Kitchen',
  'Pet Products',
  'Beauty',
  'Home',
  'Toys',
  'Sports',
  'Baby',
  'Grocery',
  'Office Products',
  'Automotive',
  'Books',
  'Wireless',
];

interface Sample {
  asin: string;
  category: string;
  searchTerm: string;
  rank: number;
  csvTitle: string | null;
}

interface KeepaResult {
  title: string | null;
  brand: string | null;
  currentPrice: number | null;     // dollars
  reviewCount: number | null;
  averageRating: number | null;    // 0.0-5.0
  lastRatingUpdate: string | null; // human-readable
  categoryPath: string;
  error: string | null;
}

async function fetchSamples(): Promise<Sample[]> {
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

    const samples: Sample[] = [];
    for (const cat of TARGET_CATEGORIES) {
      const { rows } = await c.query<{ asin: string; raw: string; rank: number; title: string | null }>(
        `
        SELECT kwm.top_clicked_product_1_asin AS asin,
               st.search_term_raw AS raw,
               kwm.actual_rank AS rank,
               kwm.top_clicked_product_1_title AS title
        FROM ${partition} kwm
        JOIN search_terms st ON st.id = kwm.search_term_id
        WHERE kwm.week_end_date = $1::date
          AND kwm.top_clicked_category_1 = $2
          AND kwm.actual_rank <= 1000
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
          searchTerm: rows[0].raw,
          rank: rows[0].rank,
          csvTitle: rows[0].title,
        });
      }
    }
    return samples;
  } finally {
    c.release();
    await pool.end();
  }
}

// Keepa Time Minutes: minutes since Keepa epoch (2011-01-01 00:00 UTC).
// Unix epoch (1970-01-01) → 2011-01-01 = 1293840000 seconds = 21564000 minutes.
// So unixSeconds = (keepaMinutes + 21564000) * 60.
function keepaMinutesToDate(km: number | null | undefined): string | null {
  if (km === null || km === undefined || km < 0) return null;
  const unixMs = (km + 21564000) * 60 * 1000;
  return new Date(unixMs).toISOString().slice(0, 10);
}

async function callKeepa(asin: string): Promise<KeepaResult> {
  const qs = new URLSearchParams({
    key: KEEPA_API_KEY ?? '',
    domain: '1',
    asin,
    rating: '1',
  });
  try {
    const res = await fetch(`https://api.keepa.com/product?${qs.toString()}`);
    const data = await res.json();
    if (!res.ok) {
      return {
        title: null, brand: null, currentPrice: null, reviewCount: null, averageRating: null,
        lastRatingUpdate: null, categoryPath: '', error: `HTTP ${res.status}`,
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const product = (data as any).products?.[0];
    if (!product) {
      return {
        title: null, brand: null, currentPrice: null, reviewCount: null, averageRating: null,
        lastRatingUpdate: null, categoryPath: '', error: 'no product in response',
      };
    }

    // Current price: csv[0] is Amazon, csv[1] is "new" — pick whichever has a value
    // Keepa price values are in cents
    const csv = product.csv ?? [];
    const lastCsv = (arr: unknown): number | null => {
      if (!Array.isArray(arr) || arr.length < 2) return null;
      const v = arr[arr.length - 1] as number;
      return v >= 0 ? v : null;
    };
    const priceCents = lastCsv(csv[0]) ?? lastCsv(csv[1]) ?? null;
    const currentPrice = priceCents !== null ? priceCents / 100 : null;

    // Review count: csv[17] (COUNT_REVIEWS)
    const reviewCount = lastCsv(csv[17]);
    // Average rating: csv[16] (RATING), 0-50 scale (divide by 10)
    const ratingRaw = lastCsv(csv[16]);
    const averageRating = ratingRaw !== null ? ratingRaw / 10 : null;

    // Category path (root → leaf)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tree = (product.categoryTree ?? []) as Array<{ catId: number; name: string }>;
    const categoryPath = tree.map((n) => n.name).join(' › ');

    return {
      title: product.title ?? null,
      brand: product.brand ?? null,
      currentPrice,
      reviewCount,
      averageRating,
      lastRatingUpdate: keepaMinutesToDate(product.lastRatingUpdate),
      categoryPath,
      error: null,
    };
  } catch (e) {
    return {
      title: null, brand: null, currentPrice: null, reviewCount: null, averageRating: null,
      lastRatingUpdate: null, categoryPath: '', error: (e as Error).message,
    };
  }
}

async function main() {
  if (!KEEPA_API_KEY) {
    console.error('Set KEEPA_API_KEY in .env.local');
    process.exit(1);
  }

  console.log(`Fetching ${TARGET_CATEGORIES.length} sample ASINs from current kcs...`);
  const samples = await fetchSamples();
  console.log(`Got ${samples.length} samples. Calling Keepa (~${samples.length * 2} tokens)...\n`);

  const lines: string[] = [];
  const mdRows: string[] = [];
  mdRows.push('# Keepa data-quality spot check');
  mdRows.push(`Generated against current kcs week. Compare Keepa values to live Amazon pages.\n`);
  mdRows.push(`| ASIN | Category | Search term | Keepa price | Keepa reviews | Keepa rating | lastRatingUpdate | Amazon link |`);
  mdRows.push(`|---|---|---|---:|---:|---:|---|---|`);

  for (const s of samples) {
    const k = await callKeepa(s.asin);
    const amazonUrl = `https://www.amazon.com/dp/${s.asin}`;
    const line = [
      s.asin.padEnd(11),
      s.category.padEnd(24).slice(0, 24),
      `"${s.searchTerm}"`.padEnd(36).slice(0, 36),
      `$${k.currentPrice?.toFixed(2) ?? ' ? '}`.padStart(9),
      `${k.reviewCount?.toLocaleString() ?? '?'}`.padStart(9),
      `${k.averageRating?.toFixed(1) ?? ' ? '}★`.padStart(6),
      `(updated ${k.lastRatingUpdate ?? '?'})`,
      k.error ? `[ERR: ${k.error}]` : '',
    ].join('  ');
    console.log('  ' + line);
    lines.push(line);
    mdRows.push(
      `| \`${s.asin}\` | ${s.category} | ${s.searchTerm} | $${k.currentPrice?.toFixed(2) ?? '?'} | ${k.reviewCount?.toLocaleString() ?? '?'} | ${k.averageRating?.toFixed(1) ?? '?'}★ | ${k.lastRatingUpdate ?? '?'} | [open](${amazonUrl}) |`,
    );
  }

  // Write markdown to docs/ for sharing
  const today = new Date().toISOString().slice(0, 10);
  const mdPath = `docs/keepa-spot-check-${today}.md`;
  writeFileSync(mdPath, mdRows.join('\n') + '\n');
  console.log(`\nMarkdown table written to ${mdPath}`);

  console.log(`\nNext: open each Amazon link in your browser, compare Keepa values:`);
  console.log(`  - Price: should match (or be within $1-2 if there's a current promo)`);
  console.log(`  - Review count: should be close. Amazon now lumps "ratings" and "reviews"`);
  console.log(`    together in the UI; Keepa's number may be lower because COUNT_REVIEWS`);
  console.log(`    historically tracked review-with-text only.`);
  console.log(`  - Average rating: should match within 0.1 stars.`);
  console.log(`  - lastRatingUpdate: if many of these are >30 days stale, that's a yellow flag.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
