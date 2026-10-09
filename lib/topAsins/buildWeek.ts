// lib/topAsins/buildWeek.ts
/**
 * Build one week's keyword→ASIN reverse table (spec 2026-10-09 §3.2–§4.1).
 *
 * One INSERT from the week's kwm partition (three slots, well-formed ASINs only) into a fresh
 * keyword_top_asins_next, carrying each (keyword, ASIN) pair's streak from the CURRENT table
 * (the previous built week, whatever its date — a gap week breaks nothing), then a rename swap
 * and the meta row, all in one transaction; ANALYZE after COMMIT. Guards: a week older than the
 * meta week is refused unless forced; zero rows never swap.
 *
 * `client` must be ONE dedicated connection (never a Pool, never inside a transaction).
 * Callers: the import phase (inngest/functions/importFile.ts), scripts/buildTopAsinsWeek.ts and
 * the backfill (scripts/backfillTopAsins.ts, which drives the same statements week by week).
 */
export interface SqlStatement { text: string; values: unknown[] }
export interface Queryable { query(text: string, values?: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }> }
export interface TopAsinsBuildStatements { createNext: SqlStatement; insert: SqlStatement; swap: SqlStatement[]; meta: SqlStatement }
export interface TopAsinsBuildResult { rows: number; previousWeek: string | null }
export type TopAsinsBuildErrorCode = 'top_asins_bad_date' | 'top_asins_older_than_meta' | 'top_asins_no_rows';
export class TopAsinsBuildError extends Error {
  constructor(public readonly code: TopAsinsBuildErrorCode, message: string) { super(message); this.name = 'TopAsinsBuildError'; }
}

const ASIN_RE = "'^[A-Z0-9]{10}$'";

export function kwmPartitionFor(week: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new TopAsinsBuildError('top_asins_bad_date', 'week must be YYYY-MM-DD');
  return `keyword_weekly_metrics_${week.slice(0, 4)}`;
}

/** The three slot selects over one week of the partition. */
function slotSelect(partition: string, slot: 1 | 2 | 3): string {
  return `SELECT search_term_id, top_clicked_product_${slot}_asin AS asin, ${slot}::smallint AS slot,
                 top_clicked_product_${slot}_click_share AS click_share, top_clicked_product_${slot}_conversion_share AS conversion_share
          FROM ${partition}
          WHERE week_end_date = $1::date AND top_clicked_product_${slot}_asin ~ ${ASIN_RE}`;
}

export function buildTopAsinsStatements(week: string): TopAsinsBuildStatements {
  const partition = kwmPartitionFor(week);
  return {
    createNext: { text: 'CREATE TABLE keyword_top_asins_next (LIKE keyword_top_asins INCLUDING ALL)', values: [] },
    insert: {
      text: `INSERT INTO keyword_top_asins_next (search_term_id, asin, slot, click_share, conversion_share, weeks_in_top3, streak_started_week, week_end_date)
             SELECT p.search_term_id, p.asin, p.slot, p.click_share, p.conversion_share,
                    COALESCE(prev.weeks_in_top3, 0) + 1,
                    COALESCE(prev.streak_started_week, $1::date),
                    $1::date
             FROM (${slotSelect(partition, 1)} UNION ALL ${slotSelect(partition, 2)} UNION ALL ${slotSelect(partition, 3)}) p
             LEFT JOIN LATERAL (
               SELECT k.weeks_in_top3, k.streak_started_week FROM keyword_top_asins k
               WHERE k.search_term_id = p.search_term_id AND k.asin = p.asin LIMIT 1
             ) prev ON true`,
      values: [week],
    },
    swap: [
      { text: 'DROP TABLE keyword_top_asins', values: [] },
      { text: 'ALTER TABLE keyword_top_asins_next RENAME TO keyword_top_asins', values: [] },
      { text: 'ALTER INDEX keyword_top_asins_next_asin_search_term_id_idx RENAME TO keyword_top_asins_asin_idx', values: [] },
      { text: 'ALTER TABLE keyword_top_asins RENAME CONSTRAINT keyword_top_asins_next_pkey TO keyword_top_asins_pkey', values: [] },
    ],
    meta: {
      text: `INSERT INTO keyword_top_asins_meta (singleton, week_end_date, built_at, row_count) VALUES (true, $1::date, now(), $2::bigint)
             ON CONFLICT (singleton) DO UPDATE SET week_end_date = EXCLUDED.week_end_date, built_at = EXCLUDED.built_at, row_count = EXCLUDED.row_count`,
      values: [week, 0],
    },
  };
}

export async function buildTopAsinsWeek(client: Queryable, week: string, opts: { force?: boolean } = {}): Promise<TopAsinsBuildResult> {
  const s = buildTopAsinsStatements(week);
  const meta = await client.query('SELECT week_end_date::text AS week_end_date FROM keyword_top_asins_meta WHERE singleton');
  const previousWeek = ((meta.rows[0] as { week_end_date: string | null } | undefined)?.week_end_date) ?? null;
  if (previousWeek && previousWeek > week && !opts.force) {
    throw new TopAsinsBuildError('top_asins_older_than_meta', `week ${week} is older than the built week ${previousWeek}`);
  }
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '1800s'");
    await client.query(s.createNext.text);
    const ins = await client.query(s.insert.text, s.insert.values);
    const rows = ins.rowCount ?? 0;
    if (rows === 0) throw new TopAsinsBuildError('top_asins_no_rows', `week ${week} produced no top-3 rows (not imported?)`);
    for (const st of s.swap) await client.query(st.text);
    await client.query(s.meta.text, [week, rows]);
    await client.query('COMMIT');
    await client.query('ANALYZE keyword_top_asins');
    return { rows, previousWeek };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}
