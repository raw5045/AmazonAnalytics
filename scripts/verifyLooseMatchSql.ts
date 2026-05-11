/**
 * Cross-check: for each fixture, run both the JS looseMatch and the
 * deployed Postgres loose_match_raw, assert identical output.
 *
 * Run after migration 0015 is applied. If any fixture mismatches, the
 * script prints the divergence and exits non-zero. The JS implementation
 * in lib/analytics/looseMatch.ts is the spec; SQL must agree.
 *
 * Usage: pnpm tsx scripts/verifyLooseMatchSql.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
import { looseMatch } from '@/lib/analytics/looseMatch';

interface Fixture {
  desc: string;
  search: string;   // search_term_normalized form
  title: string | null;
  expected: boolean | null;
}

const FIXTURES: Fixture[] = [
  // Motivating examples
  { desc: 'plural search vs singular title',
    search: 'creatine supplements', title: 'Creatine Gummies Supplement', expected: true },
  { desc: 'singular search vs plural title',
    search: 'creatine supplement', title: 'Creatine Supplements', expected: true },
  { desc: 'creatine gummies vs sugar free gummies',
    search: 'creatine gummies', title: 'Creatine Sugar Free Gummies', expected: true },
  { desc: 'gummy/gummies cross-direction',
    search: 'gummy vitamins', title: 'Gummies Multi Vitamin', expected: true },
  // Apostrophe / hyphen
  { desc: 'beekeepers (normalized form, no apostrophe)',
    search: 'beekeepers honey', title: "Beekeeper's Naturals Honey Spray", expected: true },
  { desc: 'hyphenated title',
    search: 'creatine gummies', title: 'Pure Creatine-Gummies 60ct', expected: true },
  // Plural domain words (the GPT-flagged cases the old rules missed)
  { desc: 'powders -> powder',
    search: 'protein powders', title: 'Premium Protein Powder', expected: true },
  { desc: 'bars -> bar',
    search: 'protein bars', title: 'Big Bar Plus Protein 12 ct', expected: true },
  { desc: 'teas -> tea',
    search: 'green teas', title: 'Premium Green Tea Bags', expected: true },
  { desc: 'fibers -> fiber',
    search: 'fibers daily', title: 'Daily Fiber Supplement', expected: true },
  // -ies expansion
  { desc: 'batteries -> battery',
    search: 'aa batteries', title: 'AA Battery 24 Pack', expected: true },
  // Strict false cases
  { desc: 'missing required token',
    search: 'magnesium glycinate', title: 'Vitamin C Gummies', expected: false },
  { desc: 'stopwords on search side ignored',
    search: 'the protein', title: 'Premium Protein Powder', expected: true },
  // Null
  { desc: 'null title',
    search: 'anything', title: null, expected: null },
  // Suffix guards
  { desc: 'stress not stripped',
    search: 'stress relief', title: 'Stres Relief Tablets', expected: false },
  { desc: 'virus kept whole',
    search: 'virus protection', title: 'Viru Protection', expected: false },
  { desc: 'analysis kept whole',
    search: 'analysis kit', title: 'Analy Kit', expected: false },
  // Exact-word exceptions
  { desc: 'gas not stripped',
    search: 'gas relief', title: 'Ga Relief Pills', expected: false },
  { desc: 'lens not stripped',
    search: 'lens cleaner', title: 'Len Cleaner', expected: false },
  // Series stays singleton (regression on the bug we fixed in JS)
  { desc: 'series not exploded by -ies cascade',
    search: 'tv series', title: 'TV Sery Box Set', expected: false },
];

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  let failures = 0;
  for (const f of FIXTURES) {
    const jsResult = looseMatch(f.search, f.title);
    const sqlRows = (await sql`SELECT loose_match_raw(${f.search}, ${f.title}) AS r`) as Array<{ r: boolean | null }>;
    const sqlResult = sqlRows[0]?.r ?? null;

    const jsMatchesExpected = jsResult === f.expected;
    const sqlMatchesExpected = sqlResult === f.expected;
    const jsSqlAgree = jsResult === sqlResult;

    if (jsMatchesExpected && sqlMatchesExpected && jsSqlAgree) {
      console.log(`✓ ${f.desc}`);
    } else {
      failures += 1;
      console.error(
        `✗ ${f.desc}\n` +
        `    search="${f.search}" title=${JSON.stringify(f.title)}\n` +
        `    expected=${f.expected} js=${jsResult} sql=${sqlResult}`,
      );
    }
  }
  console.log(`\n${FIXTURES.length - failures}/${FIXTURES.length} fixtures agree.`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
