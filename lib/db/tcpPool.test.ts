import { describe, it, expect, vi } from 'vitest';

// lib/env parses process.env eagerly at module load; vitest doesn't load
// .env.local, so the bare import throws ZodError on missing required vars
// (e.g. NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY). Mock rather than touch the module.
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://x' } }));

import { withReadOnlyTx, type TxClient } from './tcpPool';

function fakePool(behaviour: (sql: string) => Promise<{ rows: unknown[] }>) {
  const log: string[] = [];
  const release = vi.fn();
  const client: TxClient & { release: () => void } = {
    query: vi.fn(async (sql: string) => {
      log.push(sql);
      return behaviour(sql);
    }) as unknown as TxClient['query'],
    release,
  };
  const pool = { connect: vi.fn(async () => client) };
  return { pool, log, release };
}

describe('withReadOnlyTx', () => {
  it('wraps the callback in a repeatable-read read-only transaction with a statement timeout, then commits and releases', async () => {
    const { pool, log, release } = fakePool(async () => ({ rows: [] }));
    const out = await withReadOnlyTx(pool as never, 10_000, async (c) => {
      await c.query('SELECT 1');
      return 'done';
    });
    expect(out).toBe('done');
    expect(log).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'SET LOCAL statement_timeout = 10000',
      'SELECT 1',
      'COMMIT',
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("returns 'timeout' on Postgres 57014, rolling back and releasing", async () => {
    const { pool, log, release } = fakePool(async (sql) => {
      if (sql === 'SELECT slow') throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      return { rows: [] };
    });
    const out = await withReadOnlyTx(pool as never, 50, async (c) => c.query('SELECT slow'));
    expect(out).toBe('timeout');
    expect(log.at(-1)).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rethrows any other error after rolling back', async () => {
    const { pool, release } = fakePool(async (sql) => {
      if (sql === 'SELECT boom') throw new Error('relation missing');
      return { rows: [] };
    });
    await expect(withReadOnlyTx(pool as never, 50, async (c) => c.query('SELECT boom'))).rejects.toThrow('relation missing');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-integer timeout before touching the pool', async () => {
    const { pool } = fakePool(async () => ({ rows: [] }));
    await expect(withReadOnlyTx(pool as never, 12.5, async () => 1)).rejects.toThrow(/integer/);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
