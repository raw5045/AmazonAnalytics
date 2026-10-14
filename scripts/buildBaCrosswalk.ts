// scripts/buildBaCrosswalk.ts
/**
 * Build (or rebuild) the Keepa-path → Brand Analytics crosswalk by hand (spec 2026-10-14 §5.5): the
 * one-off first build after migration 0053, or a re-run after the import's own ba_crosswalk_build
 * phase logged a failure. Relearns ba_category_crosswalk from one report week's slot-1 rows and the
 * catalog's paths per lib/baCategory/buildCrosswalk.ts; re-running a week is idempotent.
 *
 * Run: BA_CROSSWALK_WEEK=2026-10-10 node --env-file=.env.local --import tsx scripts/buildBaCrosswalk.ts
 * BA_CROSSWALK_WEEK defaults to the Explorer week (keyword_current_summary_meta). BA_CROSSWALK_DRY_RUN=1
 * computes and prints the stats without writing.
 * Careful: .env.local's DATABASE_URL points at PRODUCTION — the write replaces the live table in one
 * transaction (readers wait a moment for the commit; the votes read takes about a minute).
 */
import { Pool } from 'pg';
import { buildCrosswalk, computeCrosswalk } from '@/lib/baCategory/buildCrosswalk';

const envWeek = process.env.BA_CROSSWALK_WEEK;
if (envWeek !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(envWeek)) {
  console.error('Refusing to run: BA_CROSSWALK_WEEK must be YYYY-MM-DD (or unset for the Explorer week).');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Refusing to run: DATABASE_URL is not set (pass --env-file=.env.local).');
  process.exit(1);
}
// Only the exact value 1 is a dry run; anything else ("0", "true", empty) is refused, not ignored.
if (process.env.BA_CROSSWALK_DRY_RUN !== undefined && process.env.BA_CROSSWALK_DRY_RUN !== '1') {
  console.error('Refusing to run: BA_CROSSWALK_DRY_RUN must be 1 (set BA_CROSSWALK_DRY_RUN=1 or unset it).');
  process.exit(1);
}
const dryRun = process.env.BA_CROSSWALK_DRY_RUN === '1';

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    statement_timeout: 600_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 20_000,
  });
  // Dropped-socket guard, as in scripts/buildTopAsinsWeek.ts: an unhandled 'error' would crash the script.
  pool.on('error', () => undefined);
  const client = await pool.connect();
  try {
    client.on('error', () => undefined);
    let week = envWeek;
    if (!week) {
      const meta = await client.query('SELECT current_week_end_date::text AS week FROM keyword_current_summary_meta WHERE singleton');
      week = (meta.rows[0] as { week: string | null } | undefined)?.week ?? undefined;
      if (!week) throw new Error('keyword_current_summary_meta has no week: set BA_CROSSWALK_WEEK');
    }
    console.log(`${dryRun ? 'computing' : 'building'} the crosswalk for week ${week} (the votes read takes about a minute)`);
    const t0 = Date.now();
    const stats = dryRun ? (await computeCrosswalk(client, week)).stats : await buildCrosswalk(client, week);
    console.log(
      `${dryRun ? 'computed' : 'built'} week ${stats.week} in ${((Date.now() - t0) / 1000).toFixed(0)}s: paths=${stats.paths} direct=${stats.direct} ` +
        `backedOff=${stats.backedOff} uncoded=${stats.uncoded} trainingProducts=${stats.trainingProducts} codes=${stats.codes}`,
    );
    if (!dryRun) {
      const top = await client.query(
        `SELECT x.code, count(*)::int AS products FROM asin_products a JOIN ba_category_crosswalk x ON x.category_path = a.category_path
         WHERE a.in_scope AND a.enrichment_status IN ('active', 'no_price') GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`,
      );
      for (const r of top.rows as Array<{ code: string; products: number }>) console.log(`  ${r.code}: ${r.products} products`);
    }
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => {
  console.error('failed:', e instanceof Error ? e.name : 'unknown', (e as { code?: string })?.code ?? '');
  process.exit(1);
});
