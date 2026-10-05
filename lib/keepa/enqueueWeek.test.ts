// lib/keepa/enqueueWeek.test.ts
import { describe, it, expect } from 'vitest';
import { enqueueWeekStatements, enqueueWeek, kwmPartitionFor, EnqueueWeekError } from './enqueueWeek';
import { EXCLUDED_CATEGORIES_ARRAY } from './categoryExclusions';
import { ENQUEUE_LOCK_KEY, TIER1_MAX_RANK } from './lanes';

describe('kwmPartitionFor', () => {
  it('maps the week to its year partition', () => {
    expect(kwmPartitionFor('2026-10-03')).toBe('keyword_weekly_metrics_2026');
  });
  it('rejects anything that is not an ISO date with a coded error (the name is interpolated into SQL)', () => {
    expect(() => kwmPartitionFor("2026-10-03'; DROP TABLE x")).toThrow(EnqueueWeekError);
    expect(() => kwmPartitionFor('')).toThrowError(expect.objectContaining({ code: 'enqueue_week_bad_date' }));
  });
});

describe('enqueueWeekStatements', () => {
  const s = enqueueWeekStatements('2026-10-03');

  it("upserts the week's top-3 ASINs from the year partition, dropping malformed ASINs and excluded categories", () => {
    expect(s.upsert.text).toContain('FROM keyword_weekly_metrics_2026 kwm');
    expect(s.upsert.text).toContain('top_clicked_product_3_asin');
    expect(s.upsert.text).toContain("t.asin ~ '^[A-Z0-9]{10}$'");
    expect(s.upsert.text).toContain('kwm.top_clicked_category_1 IS NULL OR kwm.top_clicked_category_1 <> ALL($4::text[])');
    expect(s.upsert.values).toEqual(['2026-10-03', TIER1_MAX_RANK, 7, EXCLUDED_CATEGORIES_ARRAY]);
    expect(TIER1_MAX_RANK).toBe(1_000_000);
  });

  it('assigns tier 1 up to the rank cutoff and tier 2 above it, makes new rows due now, and re-scopes existing rows', () => {
    expect(s.upsert.text).toContain('CASE WHEN best_rank <= $2::int THEN 1 ELSE 2 END, true, now()');
    expect(s.upsert.text).toContain('ON CONFLICT (asin) DO UPDATE SET');
    expect(s.upsert.text).toContain('in_scope = true,');
    expect(s.upsert.text).toContain('tier = EXCLUDED.tier,');
  });

  it('pulls a tier-2 → tier-1 move forward only when the ASIN was fetched before, and leaves every other due date alone', () => {
    expect(s.upsert.text).toContain('WHEN EXCLUDED.tier = 1 AND asin_products.tier = 2 AND asin_products.last_fetched_at IS NOT NULL');
    expect(s.upsert.text).toContain('LEAST(asin_products.next_due_at, asin_products.last_fetched_at + make_interval(days => $3::int))');
    expect(s.upsert.text).toContain('ELSE asin_products.next_due_at END');
  });

  it('reports inserted versus updated rows from the upsert', () => {
    expect(s.upsert.text).toContain('RETURNING (xmax = 0) AS inserted');
    expect(s.upsert.text).toContain('COUNT(*) FILTER (WHERE inserted)::int AS inserted');
  });

  it('retires vanished ASINs by flag, never by DELETE', () => {
    expect(s.retire.text).toContain('SET in_scope = false');
    expect(s.retire.text).not.toMatch(/DELETE/i);
    expect(s.retire.values).toEqual(['2026-10-03']);
  });
});

/** Recording fake of one dedicated connection. */
function fakeClient(opts: { scopeWeek?: string | null; upsert?: { inserted: number; updated: number } | Error; retired?: number; vacuumFails?: boolean } = {}) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text.includes('max(scope_week)')) return { rowCount: 1, rows: [{ max_week: opts.scopeWeek ?? null }] };
      if (text.includes('INSERT INTO asin_products')) {
        if (opts.upsert instanceof Error) throw opts.upsert;
        return { rowCount: 1, rows: [opts.upsert ?? { inserted: 5, updated: 7 }] };
      }
      if (text.includes('SET in_scope = false')) return { rowCount: opts.retired ?? 2, rows: [] };
      if (text.includes('VACUUM') && opts.vacuumFails) throw Object.assign(new Error('x'), { code: '55P03' });
      return { rowCount: 0, rows: [] };
    },
  };
  return { client, calls, texts: () => calls.map((c) => c.text) };
}

describe('enqueueWeek', () => {
  it('runs the lock, scope check, upsert and retire in one transaction, then vacuums after COMMIT — and reports every count', async () => {
    const f = fakeClient({ scopeWeek: '2026-09-26' });
    await expect(enqueueWeek(f.client, '2026-10-03')).resolves.toEqual({ inserted: 5, updated: 7, retired: 2, vacuumed: true });
    expect(f.texts()).toEqual([
      'BEGIN',
      "SET LOCAL statement_timeout = '1800s'",
      'SELECT pg_advisory_xact_lock($1)',
      expect.stringContaining('max(scope_week)'),
      expect.stringContaining('INSERT INTO asin_products'),
      expect.stringContaining('SET in_scope = false'),
      'COMMIT',
      'VACUUM (ANALYZE) asin_products',
    ]);
    expect(f.calls[2].values).toEqual([ENQUEUE_LOCK_KEY]);
    expect(f.calls[4].values).toEqual(enqueueWeekStatements('2026-10-03').upsert.values);
    expect(f.calls[5].values).toEqual(['2026-10-03']);
  });

  it('a week with no rows stops before the retire with a coded error, and rolls back without vacuuming', async () => {
    const f = fakeClient({ upsert: { inserted: 0, updated: 0 } });
    await expect(enqueueWeek(f.client, '2026-10-03')).rejects.toMatchObject({ name: 'EnqueueWeekError', code: 'enqueue_week_no_rows' });
    const t = f.texts();
    expect(t).not.toContainEqual(expect.stringContaining('SET in_scope = false'));
    expect(t).not.toContain('COMMIT');
    expect(t).not.toContain('VACUUM (ANALYZE) asin_products');
    expect(t.at(-1)).toBe('ROLLBACK');
  });

  it('a week older than the catalog scope is refused before the upsert and rolled back, unless forced', async () => {
    const f = fakeClient({ scopeWeek: '2026-10-03' });
    await expect(enqueueWeek(f.client, '2026-09-26')).rejects.toMatchObject({ code: 'enqueue_week_older_than_scope' });
    expect(f.texts()).not.toContainEqual(expect.stringContaining('INSERT INTO asin_products'));
    expect(f.texts().at(-1)).toBe('ROLLBACK');
    const g = fakeClient({ scopeWeek: '2026-10-03' });
    await expect(enqueueWeek(g.client, '2026-09-26', { force: true })).resolves.toMatchObject({ inserted: 5 });
    expect(g.texts()).not.toContainEqual(expect.stringContaining('max(scope_week)'));
    expect(g.texts()).toContain('COMMIT');
  });

  it('an upsert failure skips the retire and the vacuum and rolls back', async () => {
    const f = fakeClient({ upsert: Object.assign(new Error('x'), { code: '42P01' }) });
    await expect(enqueueWeek(f.client, '2026-10-03')).rejects.toMatchObject({ code: '42P01' });
    const t = f.texts();
    expect(t).not.toContainEqual(expect.stringContaining('SET in_scope = false'));
    expect(t).not.toContain('COMMIT');
    expect(t).not.toContain('VACUUM (ANALYZE) asin_products');
    expect(t.at(-1)).toBe('ROLLBACK');
  });

  it('the vacuum can be skipped', async () => {
    const f = fakeClient();
    await expect(enqueueWeek(f.client, '2026-10-03', { vacuum: false })).resolves.toMatchObject({ vacuumed: false });
    expect(f.texts()).not.toContain('VACUUM (ANALYZE) asin_products');
    expect(f.texts()).toContain('COMMIT');
  });

  it('a VACUUM failure is swallowed and reported as vacuumed: false', async () => {
    const f = fakeClient({ vacuumFails: true });
    await expect(enqueueWeek(f.client, '2026-10-03')).resolves.toEqual({ inserted: 5, updated: 7, retired: 2, vacuumed: false });
    const t = f.texts();
    const commit = t.indexOf('COMMIT');
    expect(commit).toBeGreaterThan(-1);
    expect(t.indexOf('VACUUM (ANALYZE) asin_products')).toBeGreaterThan(commit);
    expect(t).not.toContain('ROLLBACK');
  });
});
