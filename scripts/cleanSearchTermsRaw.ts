/**
 * One-shot cleanup of search_terms.search_term_raw values that still
 * contain unicode noise (OBJ char, zero-width chars, BOM, etc.) from
 * the original imports. The replay mode skipped search_terms_upsert
 * for performance, so any keyword that already existed before we
 * improved cleaning still has its old (possibly noisy) raw value.
 *
 * This runs the same character-class strip that
 * cleanSearchTermForDisplay does — purely SQL, no row-by-row JS.
 *
 * What it doesn't do:
 *   - NFC normalization (extremely rare to need; would require row-by-
 *     row JS)
 *   - Picking a different variant (e.g. "essential oils" vs
 *     "essential oils'"). The raw value stays as whichever came in
 *     first historically; only invisible chars get stripped. Variant
 *     selection would require re-running search_terms_upsert with
 *     ORDER BY against staging — separate effort.
 *
 * Safe to re-run; idempotent.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';

// Mirror lib/analytics/derivedFields.ts INVISIBLE_OR_CONTROL_PATTERN
// (Postgres regex syntax — same character ranges).
const INVISIBLE_PATTERN =
  '[\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\uFEFF\\uFFFC\\uFFFD]';

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  console.log('\n=== Counting rows that need cleanup ===');
  const [c] = (await sql`
    SELECT COUNT(*)::int c
    FROM search_terms
    WHERE search_term_raw ~ ${INVISIBLE_PATTERN}
       OR search_term_raw <> btrim(search_term_raw)
       OR search_term_raw ~ '\\s{2,}'
  `) as Array<{ c: number }>;
  console.log(`  ${c.c.toLocaleString()} rows need cleanup`);

  if (c.c === 0) {
    console.log('Nothing to do.');
    return;
  }

  console.log('\n=== Running UPDATE ===');
  const startedAt = Date.now();
  const result = (await sql`
    UPDATE search_terms
    SET search_term_raw = btrim(
      regexp_replace(
        regexp_replace(search_term_raw, ${INVISIBLE_PATTERN}, '', 'g'),
        '\\s+', ' ', 'g'
      )
    )
    WHERE search_term_raw ~ ${INVISIBLE_PATTERN}
       OR search_term_raw <> btrim(search_term_raw)
       OR search_term_raw ~ '\\s{2,}'
  `) as { rowCount?: number };
  const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
  console.log(`  Updated. Took ${elapsedMin} min.`);

  console.log('\n=== Verifying ===');
  const [after] = (await sql`
    SELECT COUNT(*)::int c
    FROM search_terms
    WHERE search_term_raw ~ ${INVISIBLE_PATTERN}
       OR search_term_raw <> btrim(search_term_raw)
       OR search_term_raw ~ '\\s{2,}'
  `) as Array<{ c: number }>;
  console.log(`  ${after.c.toLocaleString()} rows still need cleanup (should be 0 or near-0)`);

  console.log('\n=== Sample of cleaned essential-oils-style entries ===');
  const samples = (await sql`
    SELECT search_term_raw, search_term_normalized
    FROM search_terms
    WHERE search_term_normalized IN ('essential oils', 'magic eraser', 'batteries', 'crocs', 'ipad', 'shorts for women')
    LIMIT 10
  `) as Array<{ search_term_raw: string; search_term_normalized: string }>;
  for (const s of samples) {
    console.log(`  raw: "${s.search_term_raw}"  normalized: "${s.search_term_normalized}"`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
