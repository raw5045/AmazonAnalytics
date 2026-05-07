/**
 * Investigate the OBJ-character / data-anomaly issue.
 *
 * 1. Find all search_terms rows whose raw value contains "essential oils".
 *    Show byte-level dumps so we can see invisible chars.
 * 2. Compare what's in kcs to confirm whether dups have separate ranks.
 * 3. Check how many rows have the OBJ char (U+FFFC) in raw or normalized.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== All search_terms whose raw contains "essential oils" ===');
  const rows = (await sql`
    SELECT
      id,
      search_term_raw,
      LENGTH(search_term_raw) AS raw_len,
      search_term_normalized,
      LENGTH(search_term_normalized) AS norm_len,
      first_seen_week,
      last_seen_week
    FROM search_terms
    WHERE search_term_raw ILIKE '%essential oils%'
    ORDER BY length(search_term_raw)
  `) as Array<Record<string, unknown>>;
  console.log(`  ${rows.length} rows matched\n`);
  for (const r of rows) {
    const raw = r.search_term_raw as string;
    const norm = r.search_term_normalized as string;
    // Render byte hex of first 40 chars so OBJ chars become visible
    const hex = Array.from(raw.slice(0, 40))
      .map((c) => `${c}(${c.codePointAt(0)?.toString(16)})`)
      .join(' ');
    console.log(`  [${r.id}] raw_len=${r.raw_len} norm_len=${r.norm_len}`);
    console.log(`    raw:        "${raw}"`);
    console.log(`    raw hex:    ${hex}`);
    console.log(`    normalized: "${norm}"`);
    console.log(`    seen:       ${r.first_seen_week} .. ${r.last_seen_week}`);
    console.log();
  }

  console.log('\n=== Count of search_terms with U+FFFC (OBJECT REPLACEMENT) in RAW ===');
  const [c1] = (await sql`
    SELECT COUNT(*)::int c FROM search_terms WHERE search_term_raw LIKE '%' || E'\\uFFFC' || '%'
  `) as Array<{ c: number }>;
  console.log(`  ${c1.c.toLocaleString()} rows`);

  console.log('\n=== Count of search_terms with U+FFFC in NORMALIZED ===');
  const [c2] = (await sql`
    SELECT COUNT(*)::int c FROM search_terms WHERE search_term_normalized LIKE '%' || E'\\uFFFC' || '%'
  `) as Array<{ c: number }>;
  console.log(`  ${c2.c.toLocaleString()} rows (should be 0 if normalization works)`);

  console.log('\n=== Other suspicious unicode chars in NORMALIZED ===');
  // Look for any normalized value containing something other than letters/numbers/space
  const [c3] = (await sql`
    SELECT COUNT(*)::int c
    FROM search_terms
    WHERE search_term_normalized ~ '[^a-z0-9 ]'
  `) as Array<{ c: number }>;
  console.log(`  ${c3.c.toLocaleString()} rows have a non-[a-z0-9 ] char in normalized`);

  console.log('\n=== Sample of those rows ===');
  const samples = (await sql`
    SELECT search_term_raw, search_term_normalized
    FROM search_terms
    WHERE search_term_normalized ~ '[^a-z0-9 ]'
    LIMIT 20
  `) as Array<{ search_term_raw: string; search_term_normalized: string }>;
  for (const s of samples) {
    const hex = Array.from(s.search_term_normalized)
      .filter((c) => !/[a-z0-9 ]/.test(c))
      .map((c) => `${c}(${c.codePointAt(0)?.toString(16)})`)
      .join(' ');
    console.log(`  raw="${s.search_term_raw.slice(0, 50)}"`);
    console.log(`  norm="${s.search_term_normalized.slice(0, 50)}"`);
    console.log(`  bad chars: ${hex}`);
    console.log();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
