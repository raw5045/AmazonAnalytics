/**
 * Manually fire a keepa.enrich-week-requested event.
 *
 * Used for:
 *   - Initial backfill of the current week (one-time, when this feature ships)
 *   - Recovery after a cancelled / failed run
 *   - Re-running a week that came back with too many 'error' status rows
 *
 * NOT needed for normal weekly maintenance — that's auto-fired by
 * processFileImport (importFile.ts) after each kcs refresh completes.
 *
 * Usage:
 *   pnpm tsx scripts/fireKeepaEnrichment.ts                  # current kcs week
 *   pnpm tsx scripts/fireKeepaEnrichment.ts 2026-05-02       # explicit week
 *
 * The event is fire-and-forget. Inngest Cloud routes it to the Railway
 * worker; this script returns as soon as Inngest acknowledges the
 * event. Watch progress at https://app.inngest.com under
 * `enrich-keepa-for-week` → Runs.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { Pool } from 'pg';
// NOTE: Do NOT statically import '@/inngest/client' here. The Inngest
// constructor reads INNGEST_EVENT_KEY at module-load time, and TS hoists
// static imports above the dotenv.config() body call — so the env var
// hasn't been populated yet when the constructor runs, and eventKey
// ends up undefined. We dynamically import inside main() below, AFTER
// dotenv has populated process.env.

async function readCurrentWeekFromMeta(): Promise<string> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
  const c = await pool.connect();
  try {
    const { rows } = await c.query<{ current_week: string }>(`
      SELECT current_week_end_date::text AS current_week
      FROM keyword_current_summary_meta WHERE singleton = true
    `);
    if (rows.length === 0) throw new Error('keyword_current_summary_meta has no singleton row');
    return rows[0].current_week;
  } finally {
    c.release();
    await pool.end();
  }
}

async function readEnrichmentState(weekEndDate: string): Promise<{
  alreadyEnriched: number;
  countsByStatus: Record<string, number>;
}> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
  const c = await pool.connect();
  try {
    const { rows } = await c.query<{ status: string; n: number }>(
      `SELECT enrichment_status::text AS status, COUNT(*)::int AS n
       FROM asin_weekly_data
       WHERE week_end_date = $1::date
       GROUP BY 1
       ORDER BY 1`,
      [weekEndDate],
    );
    const countsByStatus: Record<string, number> = {};
    let alreadyEnriched = 0;
    for (const r of rows) {
      countsByStatus[r.status] = r.n;
      alreadyEnriched += r.n;
    }
    return { alreadyEnriched, countsByStatus };
  } finally {
    c.release();
    await pool.end();
  }
}

async function main() {
  // Validate / default the weekEndDate arg.
  const argWeek = process.argv[2];
  let weekEndDate: string;
  if (argWeek) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(argWeek)) {
      console.error(`Invalid week format "${argWeek}". Use YYYY-MM-DD.`);
      process.exit(1);
    }
    weekEndDate = argWeek;
  } else {
    weekEndDate = await readCurrentWeekFromMeta();
    console.log(`No week specified — using current kcs week: ${weekEndDate}`);
  }

  // Pre-flight: how much of this week's enrichment is already done?
  const { alreadyEnriched, countsByStatus } = await readEnrichmentState(weekEndDate);
  console.log(`\n=== Pre-flight state for ${weekEndDate} ===`);
  console.log(`  asin_weekly_data rows: ${alreadyEnriched.toLocaleString()}`);
  for (const [status, n] of Object.entries(countsByStatus)) {
    console.log(`    ${status.padEnd(10)} ${n.toLocaleString()}`);
  }

  // INNGEST_EVENT_KEY must be set to talk to Inngest Cloud (it identifies
  // this app + lets Cloud sign the event). Without it, inngest.send is
  // a no-op in the dev SDK — easy footgun.
  if (!process.env.INNGEST_EVENT_KEY) {
    console.warn(
      `\n⚠ INNGEST_EVENT_KEY not set. The SDK will run in dev mode and the event ` +
      `won't reach Inngest Cloud. Set it in .env.local before firing.`,
    );
    process.exit(1);
  }

  // Dynamic import AFTER dotenv has populated process.env. See top-of-file note.
  const { inngest } = await import('@/inngest/client');

  console.log(`\nFiring keepa.enrich-week-requested for ${weekEndDate}...`);
  const result = await inngest.send({
    name: 'keepa.enrich-week-requested',
    data: { weekEndDate },
  });

  // inngest.send returns { ids: [...] } — one ID per event sent.
  const eventId = result.ids?.[0] ?? '(no id returned)';
  console.log(`✓ Event sent.  id=${eventId}`);
  console.log(`\nNext steps:`);
  console.log(`  - Watch progress at https://app.inngest.com under enrich-keepa-for-week → Runs`);
  console.log(`  - Or poll the DB: `);
  console.log(`      SELECT enrichment_status, COUNT(*) FROM asin_weekly_data`);
  console.log(`      WHERE week_end_date = '${weekEndDate}' GROUP BY 1;`);
  console.log(`  - Email lands in admin inbox when complete (~19h for ~140K ASINs).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
