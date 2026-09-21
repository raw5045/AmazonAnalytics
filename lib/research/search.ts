import type { Pool } from 'pg';
import { withReadOnlyTx } from '@/lib/db/tcpPool';
import { COUNT_CAP } from '@/lib/explorer/buildQuery';
import type { TotalMatches } from './contracts';
import { dataUnavailableError, queryTimeoutError, searchExpiredError } from './errors';
import type { CompiledSearch, RawSearchRow } from './query';
import { loadSnapshotMeta, type SnapshotMeta } from './snapshot';

/** M2: `compiled` is the exact CompiledSearch this run used, so a caller (service.ts) can count against it directly instead of keeping its own closure copy. */
export interface SearchRun { meta: SnapshotMeta; rows: RawSearchRow[]; compiled: CompiledSearch }

/** Meta + one page in a single read-only repeatable-read transaction. */
export async function runSearch(
  pool: Pool,
  timeoutMs: number,
  compile: (meta: SnapshotMeta) => CompiledSearch,
  opts: { expectedSnapshot: string | null },
): Promise<SearchRun> {
  const out = await withReadOnlyTx(pool, timeoutMs, async (client) => {
    const meta = await loadSnapshotMeta(client);
    if (!meta) throw dataUnavailableError();
    if (opts.expectedSnapshot !== null && meta.snapshotVersion !== opts.expectedSnapshot) {
      throw searchExpiredError('snapshot_changed');
    }
    const compiled = compile(meta);
    const rows = (await client.query(compiled.sql, compiled.args)).rows as RawSearchRow[];
    return { meta, rows, compiled };
  });
  if (out === 'timeout') throw queryTimeoutError(timeoutMs);
  return out;
}

/**
 * Capped count in its own short transaction; a timeout is an honest `unknown`, never zero.
 * When `expectedSnapshot` is given (a continuation re-counting nothing, or a later page
 * carrying forward the first page's count), the meta is read first inside this SAME
 * transaction and checked before the count SQL ever runs: a moved or missing snapshot reports
 * `unknown` directly, without issuing a count against what may now be a different population.
 */
export async function countMatches(
  pool: Pool,
  timeoutMs: number,
  compiled: CompiledSearch,
  opts: { expectedSnapshot: string | null } = { expectedSnapshot: null },
): Promise<TotalMatches> {
  const out = await withReadOnlyTx(pool, timeoutMs, async (client): Promise<number | TotalMatches> => {
    if (opts.expectedSnapshot !== null) {
      const meta = await loadSnapshotMeta(client);
      if (!meta || meta.snapshotVersion !== opts.expectedSnapshot) {
        return { kind: 'unknown', value: null };
      }
    }
    const r = await client.query(compiled.countSql, compiled.countArgs);
    return Number((r.rows as Array<{ total: number | string }>)[0]?.total ?? 0);
  });
  if (out === 'timeout') return { kind: 'unknown', value: null };
  if (typeof out === 'object') return out;
  return out > COUNT_CAP ? { kind: 'at_least', value: COUNT_CAP } : { kind: 'exact', value: out };
}
