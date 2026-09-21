import type { Pool } from 'pg';
import { withReadOnlyTx } from '@/lib/db/tcpPool';
import { COUNT_CAP } from '@/lib/explorer/buildQuery';
import type { TotalMatches } from './contracts';
import { ResearchError } from './errors';
import type { CompiledSearch, RawSearchRow } from './query';
import { loadSnapshotMeta, type SnapshotMeta } from './snapshot';

export interface SearchRun { meta: SnapshotMeta; rows: RawSearchRow[] }

export const dataUnavailable = () =>
  new ResearchError('DATA_UNAVAILABLE', 'The keyword dataset is being refreshed; try again in a few minutes.', { retryable: true, retryAfterSeconds: 120 });
export const queryTimeout = () =>
  new ResearchError('QUERY_TIMEOUT', 'The query took longer than its 10-second budget. Narrow the criteria (a category scope or a tighter range) and try again; this is not an empty result.', { retryable: true });

/** Meta + one page in a single read-only repeatable-read transaction. */
export async function runSearch(
  pool: Pool,
  timeoutMs: number,
  compile: (meta: SnapshotMeta) => CompiledSearch,
  opts: { expectedSnapshot: string | null },
): Promise<SearchRun> {
  const out = await withReadOnlyTx(pool, timeoutMs, async (client) => {
    const meta = await loadSnapshotMeta(client);
    if (!meta) throw dataUnavailable();
    if (opts.expectedSnapshot && meta.snapshotVersion !== opts.expectedSnapshot) {
      throw new ResearchError('SEARCH_EXPIRED', 'The dataset was refreshed since this search started. Start a new search to see current data.');
    }
    const compiled = compile(meta);
    const rows = (await client.query(compiled.sql, compiled.args)).rows as RawSearchRow[];
    return { meta, rows };
  });
  if (out === 'timeout') throw queryTimeout();
  return out;
}

/** Capped count in its own short transaction; a timeout is an honest `unknown`, never zero. */
export async function countMatches(pool: Pool, timeoutMs: number, compiled: CompiledSearch): Promise<TotalMatches> {
  const out = await withReadOnlyTx(pool, timeoutMs, async (client) => {
    const r = await client.query(compiled.countSql, compiled.countArgs);
    return Number((r.rows as Array<{ total: number | string }>)[0]?.total ?? 0);
  });
  if (out === 'timeout') return { kind: 'unknown', value: null };
  return out > COUNT_CAP ? { kind: 'at_least', value: COUNT_CAP } : { kind: 'exact', value: out };
}
