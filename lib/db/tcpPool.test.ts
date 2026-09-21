import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';

// Mock Pool as an EventEmitter subclass that just records the config it was
// constructed with, so createTcpPool's tests can assert on it and trigger its
// 'error' event without a real socket. Dynamic import inside the factory
// avoids referencing a hoisted-above top-level binding (vi.mock factories run
// before this file's own imports are evaluated).
vi.mock('pg', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('node:events');
  class MockPool extends NodeEventEmitter {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
    }
  }
  return { Pool: MockPool };
});

import { createTcpPool, withReadOnlyTx, type TxClient } from './tcpPool';

class FakeClient extends EventEmitter {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;

  constructor(behaviour: (sql: string) => Promise<{ rows: unknown[] }>, log: string[]) {
    super();
    this.query = vi.fn(async (sql: string) => {
      log.push(sql);
      return behaviour(sql);
    });
    this.release = vi.fn();
  }
}

function fakePool(behaviour: (sql: string) => Promise<{ rows: unknown[] }>) {
  const log: string[] = [];
  const client = new FakeClient(behaviour, log);
  const pool = { connect: vi.fn(async () => client) };
  return { pool, log, client };
}

describe('withReadOnlyTx', () => {
  it('wraps the callback in a repeatable-read read-only transaction with a statement timeout, then commits and releases', async () => {
    const { pool, log, client } = fakePool(async () => ({ rows: [] }));
    const out = await withReadOnlyTx(pool as never, 10_000, async (c: TxClient) => {
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
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("returns 'timeout' on Postgres 57014, rolling back and releasing without committing", async () => {
    const { pool, log, client } = fakePool(async (sql) => {
      if (sql === 'SELECT slow') {
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      }
      return { rows: [] };
    });
    const out = await withReadOnlyTx(pool as never, 50, async (c: TxClient) => c.query('SELECT slow'));
    expect(out).toBe('timeout');
    expect(log.at(-1)).toBe('ROLLBACK');
    expect(log).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rethrows any other error after rolling back', async () => {
    const { pool, client } = fakePool(async (sql) => {
      if (sql === 'SELECT boom') throw new Error('relation missing');
      return { rows: [] };
    });
    await expect(
      withReadOnlyTx(pool as never, 50, async (c: TxClient) => c.query('SELECT boom')),
    ).rejects.toThrow('relation missing');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rethrows the ORIGINAL error, not a ROLLBACK failure, when ROLLBACK itself throws', async () => {
    const { pool, client } = fakePool(async (sql) => {
      if (sql === 'SELECT boom') throw new Error('relation missing');
      if (sql === 'ROLLBACK') throw new Error('connection terminated unexpectedly');
      return { rows: [] };
    });
    await expect(
      withReadOnlyTx(pool as never, 50, async (c: TxClient) => c.query('SELECT boom')),
    ).rejects.toThrow('relation missing');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('propagates a pool.connect() rejection and never calls release', async () => {
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => {
        throw new Error('pool exhausted');
      }),
    };
    await expect(withReadOnlyTx(pool as never, 50, async () => 'done')).rejects.toThrow('pool exhausted');
    expect(release).not.toHaveBeenCalled();
  });

  it('absorbs a socket error emitted on the client during fn, and leaves no listener behind once settled', async () => {
    const { pool, client } = fakePool(async () => ({ rows: [] }));
    const out = await withReadOnlyTx(pool as never, 10_000, async (c: TxClient) => {
      // Would throw synchronously (Node's default EventEmitter 'error'
      // behavior) if withReadOnlyTx hadn't already attached its listener.
      client.emit('error', new Error('socket hang up'));
      await c.query('SELECT 1');
      return 'done';
    });
    expect(out).toBe('done');
    expect(client.listenerCount('error')).toBe(0);
  });

  it.each([0, -1, 12.5, NaN, Infinity, 1e21, 2_147_483_648])(
    'rejects an out-of-range or non-integer timeout (%s) before touching the pool',
    async (value) => {
      const { pool } = fakePool(async () => ({ rows: [] }));
      await expect(withReadOnlyTx(pool as never, value, async () => 1)).rejects.toThrow(/integer/);
      expect(pool.connect).not.toHaveBeenCalled();
    },
  );
});

describe('createTcpPool', () => {
  it('builds a Pool with the given name, max, connection string, and a default connectionTimeoutMillis', () => {
    const pool = createTcpPool({ name: 'research', max: 5, connectionString: 'postgres://x' });
    expect(pool.options).toEqual({
      connectionString: 'postgres://x',
      max: 5,
      keepAlive: true,
      connectionTimeoutMillis: 20_000,
    });
  });

  it('honors an explicit connectionTimeoutMillis override', () => {
    const pool = createTcpPool({
      name: 'research',
      max: 5,
      connectionString: 'postgres://x',
      connectionTimeoutMillis: 5_000,
    });
    expect(pool.options).toEqual({
      connectionString: 'postgres://x',
      max: 5,
      keepAlive: true,
      connectionTimeoutMillis: 5_000,
    });
  });

  it('logs idle client errors via console.warn, prefixed with the pool name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pool = createTcpPool({ name: 'research', max: 5, connectionString: 'postgres://x' });
      pool.emit('error', new Error('idle client died'));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toEqual(expect.stringMatching(/^\[research pool\] idle client error:/));
    } finally {
      warn.mockRestore();
    }
  });
});
