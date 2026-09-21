import { vi } from 'vitest';

/**
 * A fake `pg` Pool whose single client answers by matching each query's SQL text against
 * `answers`' keys (substring match) and returning the corresponding rows — or throwing when
 * `fail` names a SQL text to reject (optionally carrying a Postgres error `code`, e.g. '57014'
 * for a statement-timeout, surfaced by `withReadOnlyTx` as `'timeout'`). Shared by
 * search.test.ts and history.test.ts, both of which exercise code built on `withReadOnlyTx`
 * (lib/db/tcpPool.ts): it attaches a no-op 'error' listener to the checked-out client for the
 * duration of the transaction and removes it in `finally`, so the fake client needs `on` and
 * `removeListener` even though nothing here uses them. Plain module, not a `*.test.ts` file —
 * so it is not itself picked up as a test file, but it may still import `vi` from vitest.
 */
export function fakePool(answers: Record<string, unknown[]>, fail?: { sql: string; code?: string }) {
  const log: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      log.push(sql);
      if (fail && sql === fail.sql) throw Object.assign(new Error('boom'), fail.code ? { code: fail.code } : {});
      const key = Object.keys(answers).find((k) => sql.includes(k));
      return { rows: key ? answers[key] : [] };
    }),
    release: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  return { pool: { connect: async () => client } as never, log, client };
}
