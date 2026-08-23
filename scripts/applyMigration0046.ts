/**
 * Gated apply for migration 0046 (owner-run):
 *   APPLY_0046=yes node --env-file=.env.local --import tsx scripts/applyMigration0046.ts
 *
 * Run OUTSIDE the weekly refresh window — the plain CREATE INDEX on _stage
 * will lock-contend with the refresh's TRUNCATE/INSERT (the refresh runs
 * ~4.5h after an import upload).
 *
 * Statements run one at a time (CREATE INDEX CONCURRENTLY cannot be inside a
 * transaction). pg.Pool with a 30-min statement_timeout, mirroring
 * scripts/applyMigration0044.ts — the neon() HTTP driver's client-side
 * timeout (~5min) could abort a slow CONCURRENTLY build mid-flight and
 * manufacture an INVALID index.
 *
 * Asserts both columns + both indexes exist, AND that both indexes are
 * VALID (CREATE INDEX CONCURRENTLY IF NOT EXISTS silently no-ops over a
 * leftover INVALID index left by an earlier aborted build — pg_indexes
 * doesn't surface that; pg_index.indisvalid does).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const EXPECTED_TABLES = ['keyword_current_summary', 'keyword_current_summary_stage'];
const EXPECTED_INDEXES = ['kcs_cat_cover_idx', 'kcs_stage_cat_cover_idx'];

async function main() {
  if (process.env.APPLY_0046 !== 'yes') {
    console.error('Refusing: set APPLY_0046=yes to apply migration 0046.');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, statement_timeout: 1_800_000 });
  const c = await pool.connect();
  try {
    const raw = readFileSync(join(process.cwd(), 'db', 'migrations', '0046_category_covering_index.sql'), 'utf8');
    // Strip `-- ...` comments across the whole file BEFORE splitting on `;` —
    // splitting first would fracture on semicolons used as punctuation inside
    // comment prose (this file has several) and corrupt the real statements.
    // CAVEAT: this parser doesn't understand string literals or dollar-quoted
    // blocks that themselves contain `--` or `;` — safe for this file, but
    // don't reuse it verbatim for a migration whose statements have those.
    const statements = raw
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const st of statements) {
      const label = st.slice(0, 72).replace(/\s+/g, ' ');
      const t0 = Date.now();
      await c.query(st);
      console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)}s): ${label}…`);
    }

    const missing: string[] = [];

    const { rows: cols } = await c.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE column_name = 'word_count' AND table_name = ANY($1)`,
      [EXPECTED_TABLES],
    );
    const colsFound = new Set(cols.map((r) => r.table_name));
    for (const t of EXPECTED_TABLES) {
      if (!colsFound.has(t)) missing.push(`column word_count on ${t}`);
    }

    // House pattern for post-CONCURRENTLY validity checks — see
    // scripts/backfillKcsNormalized.ts ~line 115.
    const { rows: idxs } = await c.query<{ indexname: string; isvalid: boolean }>(
      `SELECT c.relname AS indexname, i.indisvalid AS isvalid
       FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
       WHERE c.relname = ANY($1)`,
      [EXPECTED_INDEXES],
    );
    const idxValidity = new Map(idxs.map((r) => [r.indexname, r.isvalid]));
    for (const n of EXPECTED_INDEXES) {
      if (!idxValidity.has(n)) missing.push(`index ${n} (not found)`);
      else if (!idxValidity.get(n)) missing.push(`index ${n} (INVALID)`);
    }

    console.log('columns:', [...colsFound].sort().join(', '));
    console.log('indexes:', idxs.map((r) => `${r.indexname}(valid=${r.isvalid})`).sort().join(', '));

    if (missing.length > 0) {
      console.error(`ASSERTION FAILED — missing/invalid: ${missing.join('; ')}.`);
      if (idxValidity.get('kcs_cat_cover_idx') === false) {
        console.error('DROP INDEX CONCURRENTLY kcs_cat_cover_idx; then re-run this script.');
      }
      process.exit(1);
    }
    console.log('0046 applied and verified.');
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
