/**
 * Apply migration 0044 (volume-delta partial expression index twins) to
 * DATABASE_URL, then assert all 10 indexes exist. Gated by APPLY_0044=yes.
 *
 * 10 CREATE INDEX IF NOT EXISTS builds on ~4M-row kcs (~30-60s each), so the
 * pool carries the 0041-style 30-min statement_timeout, not 0043's 60s.
 *
 * Run: APPLY_0044=yes node --env-file=.env.local --import tsx scripts/applyMigration0044.ts
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';

if (process.env.APPLY_0044 !== 'yes') {
  console.error('Refusing to run: set APPLY_0044=yes to proceed.');
  process.exit(1);
}

const EXPECTED_INDEXES = [
  'kcs_vol_delta_1w_idx',
  'kcs_vol_delta_4w_idx',
  'kcs_vol_delta_13w_idx',
  'kcs_vol_delta_26w_idx',
  'kcs_vol_delta_52w_idx',
  'kcs_stage_vol_delta_1w_idx',
  'kcs_stage_vol_delta_4w_idx',
  'kcs_stage_vol_delta_13w_idx',
  'kcs_stage_vol_delta_26w_idx',
  'kcs_stage_vol_delta_52w_idx',
];

(async () => {
  const sql = readFileSync('db/migrations/0044_kcs_vol_delta_indexes.sql', 'utf8');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, statement_timeout: 1_800_000 });
  const c = await pool.connect();
  try {
    console.log('Applying 0044_kcs_vol_delta_indexes.sql (10 index builds on ~4M-row kcs — several minutes)...');
    const t0 = Date.now();
    await c.query(sql);
    console.log(`Applied in ${((Date.now() - t0) / 1000).toFixed(0)}s. Asserting...`);

    const { rows } = await c.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)`,
      [EXPECTED_INDEXES],
    );
    if (rows.length !== EXPECTED_INDEXES.length) {
      const found = new Set(rows.map((r) => r.indexname as string));
      const missing = EXPECTED_INDEXES.filter((n) => !found.has(n));
      console.error(`❌ assertion FAILED — expected ${EXPECTED_INDEXES.length} indexes, found ${rows.length}; missing: ${missing.join(', ')}`);
      process.exit(1);
    }
    console.log('✅ 0044 applied — all 10 volume-delta index twins exist on both physical tables.');
  } finally {
    c.release();
    await pool.end();
  }
})();
