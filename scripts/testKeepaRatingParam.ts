/**
 * Test whether Keepa's rating=1 parameter returns review count + avg
 * rating (and at what token cost). Tries 6 ASINs at both default
 * and rating=1 to compare.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';

const ASINS = [
  'B07BGLT25K', // toilet paper (Health & Personal Care)
  'B0CQXMXJC5', // headphones (Electronics)
  'B08JDXHM5V', // dresses for women (Apparel)
  'B0BZYCJK89', // owala (Kitchen)
  'B0009X29WK', // cat litter (Pet Products)
  'B0GWZL1YM1', // magnetic eyelashes (Beauty)
];

async function call(asin: string, params: Record<string, string | number>) {
  const qs = new URLSearchParams({
    key: process.env.KEEPA_API_KEY ?? '',
    domain: '1',
    asin,
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });
  const res = await fetch(`https://api.keepa.com/product?${qs.toString()}`);
  const data = await res.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return data as any;
}

function extractReviewCount(product: unknown): number | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = product as any;
  if (!p) return null;
  if (p.reviewCount !== undefined && p.reviewCount !== null && p.reviewCount >= 0) return p.reviewCount;
  if (p.stats?.current?.[17] !== undefined && p.stats.current[17] >= 0) return p.stats.current[17];
  if (Array.isArray(p.csv?.[17]) && p.csv[17].length >= 2) {
    const v = p.csv[17][p.csv[17].length - 1];
    if (v >= 0) return v;
  }
  return null;
}

function extractRating(product: unknown): number | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = product as any;
  if (!p) return null;
  // Keepa rating is on a 0-50 scale (divide by 10 to get 0.0-5.0)
  if (p.rating !== undefined && p.rating !== null && p.rating >= 0) return p.rating / 10;
  if (p.stats?.current?.[16] !== undefined && p.stats.current[16] >= 0) return p.stats.current[16] / 10;
  if (Array.isArray(p.csv?.[16]) && p.csv[16].length >= 2) {
    const v = p.csv[16][p.csv[16].length - 1];
    if (v >= 0) return v / 10;
  }
  return null;
}

async function main() {
  console.log('\nComparing default vs rating=1 vs stats=1&rating=1\n');

  const paramSets: Array<{ name: string; params: Record<string, string | number> }> = [
    { name: 'default', params: {} },
    { name: 'rating=1', params: { rating: 1 } },
    { name: 'stats=1&rating=1', params: { stats: 1, rating: 1 } },
  ];

  let prevTokens: number | null = null;
  for (const ps of paramSets) {
    console.log(`\n=== Param set: ${ps.name} ===`);
    for (const asin of ASINS) {
      const data = await call(asin, ps.params);
      const tl = data.tokensLeft;
      const spent = prevTokens !== null ? prevTokens - tl : null;
      prevTokens = tl;
      const product = data.products?.[0];
      const reviewCount = extractReviewCount(product);
      const rating = extractRating(product);
      console.log(
        `  ${asin}  tokensLeft=${tl?.toString().padStart(6)}  spent=${spent?.toString().padStart(3) ?? '  ?'}  reviews=${reviewCount?.toLocaleString().padStart(8) ?? '    null'}  rating=${rating?.toFixed(1).padStart(4) ?? 'null'}`,
      );
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
