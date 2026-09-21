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

/**
 * SQL fragment formatting a `timestamptz` column `col` as an ISO 8601 UTC string with
 * milliseconds (`YYYY-MM-DDTHH:MI:SS.MSZ`) directly in Postgres, so the driver hands back a
 * string that's already in the client's target format — never re-parsed with `new Date(...)`
 * client-side (see mapMeta's docstring below). Shared by `SNAPSHOT_META_SQL` (`refreshed_at`)
 * and history.ts's `keyword_chart_series` read (`updated_at`), which both need exactly this
 * formatting and previously hand-copied the same `to_char` call.
 */
export const isoUtcSql = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const SNAPSHOT_META_SQL = `
  SELECT m.current_week_end_date::text AS week,
         m.snapshot_version::text AS snap,
         ${isoUtcSql('m.refreshed_at')} AS refreshed,
         m.volume_fit_run_id::text AS fit_id,
         r.calibration_month_end_date::text AS cal_month,
         m.volume_fit_is_extrapolated AS extrapolated
  FROM keyword_current_summary_meta m
  LEFT JOIN model_calibration_runs r ON r.id = m.volume_fit_run_id
  WHERE m.singleton = true`;

interface MetaRow { week: string | null; snap: string | null; refreshed: string | null; fit_id: string | null; cal_month: string | null; extrapolated: boolean | null }

/**
 * `refreshed` is already ISO 8601 (formatted by `to_char` above, UTC, milliseconds) — passed
 * through unchanged, never re-parsed with `new Date(...)` client-side. Missing week/snap/
 * refreshed are all treated the same way: the row isn't usable yet, so the whole meta is null.
 */
function mapMeta(row: MetaRow | undefined): SnapshotMeta | null {
  if (!row || !row.week || !row.snap || !row.refreshed) return null;
  return {
    currentWeekEndDate: row.week.slice(0, 10),
    snapshotVersion: row.snap,
    refreshedAt: row.refreshed,
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
