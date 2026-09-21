import { neon } from '@neondatabase/serverless';
import type { TxClient } from '@/lib/db/tcpPool';
import { env } from '@/lib/env';

export interface SnapshotMeta {
  currentWeekEndDate: string;
  snapshotVersion: string;
  refreshedAt: string;
  volumeFitRunId: string | null;
  calibrationMonthEndDate: string | null;
  isExtrapolated: boolean;
}

export const SNAPSHOT_META_SQL = `
  SELECT m.current_week_end_date::text AS week,
         m.snapshot_version::text AS snap,
         m.refreshed_at::text AS refreshed,
         m.volume_fit_run_id::text AS fit_id,
         r.calibration_month_end_date::text AS cal_month,
         m.volume_fit_is_extrapolated AS extrapolated
  FROM keyword_current_summary_meta m
  LEFT JOIN model_calibration_runs r ON r.id = m.volume_fit_run_id
  WHERE m.singleton = true`;

interface MetaRow { week: string | null; snap: string | null; refreshed: string | null; fit_id: string | null; cal_month: string | null; extrapolated: boolean | null }

function mapMeta(row: MetaRow | undefined): SnapshotMeta | null {
  if (!row || !row.week || !row.snap) return null;
  return {
    currentWeekEndDate: row.week.slice(0, 10),
    snapshotVersion: row.snap,
    refreshedAt: row.refreshed ? new Date(row.refreshed).toISOString() : new Date(0).toISOString(),
    volumeFitRunId: row.fit_id ?? null,
    calibrationMonthEndDate: row.cal_month ? row.cal_month.slice(0, 10) : null,
    isExtrapolated: row.extrapolated ?? false,
  };
}

/** Inside a research transaction (same snapshot as the rows). */
export async function loadSnapshotMeta(client: TxClient): Promise<SnapshotMeta | null> {
  const r = await client.query(SNAPSHOT_META_SQL);
  return mapMeta((r.rows as MetaRow[])[0]);
}

/** Stand-alone read over neon-http for the guide and details tools. */
export async function loadSnapshotMetaHttp(): Promise<SnapshotMeta | null> {
  const sql = neon(env.DATABASE_URL);
  const rows = (await sql.query(SNAPSHOT_META_SQL)) as MetaRow[];
  return mapMeta(rows[0]);
}
