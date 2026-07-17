/**
 * Apply migration 0045 (sqp_calibration_data mirror table) to DATABASE_URL,
 * then assert the table and both indexes exist. Gated by APPLY_0045=yes.
 *
 * One empty-table CREATE plus two small index builds — instant, so the pool
 * carries 0043's 60s statement_timeout, not 0044's 30-min one.
 *
 * Run: APPLY_0045=yes node --env-file=.env.local --import tsx scripts/applyMigration0045.ts
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';

if (process.env.APPLY_0045 !== 'yes') {
  console.error('Refusing to run: set APPLY_0045=yes to proceed.');
  process.exit(1);
}

const EXPECTED_TABLE = 'sqp_calibration_data';
const EXPECTED_INDEXES = [
  'sqp_calibration_volume_idx',
  'sqp_calibration_month_idx',
];

(async () => {
  const sql = readFileSync('db/migrations/0045_sqp_calibration.sql', 'utf8');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, statement_timeout: 60_000 });
  const c = await pool.connect();
  try {
    console.log('Applying 0045_sqp_calibration.sql (one empty table + two indexes — instant)...');
    const t0 = Date.now();
    await c.query(sql);
    console.log(`Applied in ${((Date.now() - t0) / 1000).toFixed(0)}s. Asserting...`);

    const missing: string[] = [];
    const tables = await c.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = $1`,
      [EXPECTED_TABLE],
    );
    if (tables.rows.length !== 1) missing.push(`table ${EXPECTED_TABLE}`);
    const { rows } = await c.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)`,
      [EXPECTED_INDEXES],
    );
    const found = new Set(rows.map((r) => r.indexname as string));
    for (const n of EXPECTED_INDEXES) {
      if (!found.has(n)) missing.push(`index ${n}`);
    }
    if (missing.length > 0) {
      console.error(`❌ assertion FAILED — missing: ${missing.join(', ')}`);
      process.exit(1);
    }
    console.log('✅ 0045 applied — sqp_calibration_data + sqp_calibration_volume_idx + sqp_calibration_month_idx exist.');
  } finally {
    c.release();
    await pool.end();
  }
})();
