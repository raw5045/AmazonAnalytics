/**
 * Apply migration 0043 (daily activity counter tables) to DATABASE_URL,
 * then assert both tables exist. Gated by APPLY_0043=yes.
 *
 * Run: APPLY_0043=yes node --env-file=.env.local --import tsx scripts/applyMigration0043.ts
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';

if (process.env.APPLY_0043 !== 'yes') {
  console.error('Refusing to run: set APPLY_0043=yes to proceed.');
  process.exit(1);
}

(async () => {
  const sql = readFileSync('db/migrations/0043_activity_daily_counters.sql', 'utf8');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, statement_timeout: 60_000 });
  const c = await pool.connect();
  try {
    console.log('Applying 0043_activity_daily_counters.sql (two empty tables — instant)...');
    await c.query(sql);

    const { rows } = await c.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name IN ('user_activity_daily', 'app_activity_daily')`,
    );
    if (rows.length !== 2) {
      console.error(`❌ assertion FAILED — expected 2 tables, found ${rows.length}`);
      process.exit(1);
    }
    console.log('✅ 0043 applied — user_activity_daily + app_activity_daily exist');
  } finally {
    c.release();
    await pool.end();
  }
})();
