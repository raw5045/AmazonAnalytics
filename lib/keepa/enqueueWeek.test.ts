// lib/keepa/enqueueWeek.test.ts
import { describe, it, expect } from 'vitest';
import { enqueueWeekStatements, enqueueWeek, kwmPartitionFor } from './enqueueWeek';
import { EXCLUDED_CATEGORIES_ARRAY } from './categoryExclusions';

describe('kwmPartitionFor', () => {
  it('maps the week to its year partition', () => {
    expect(kwmPartitionFor('2026-10-03')).toBe('keyword_weekly_metrics_2026');
  });
  it('rejects anything that is not an ISO date (the name is interpolated into SQL)', () => {
    expect(() => kwmPartitionFor("2026-10-03'; DROP TABLE x")).toThrow();
    expect(() => kwmPartitionFor('')).toThrow();
  });
});

describe('enqueueWeekStatements', () => {
  const s = enqueueWeekStatements('2026-10-03');

  it("upserts the week's top-3 ASINs with rank, scope week and tier, skipping excluded categories", () => {
    expect(s.upsert.text).toContain('FROM keyword_weekly_metrics_2026 kwm');
    expect(s.upsert.text).toContain('top_clicked_product_3_asin');
    expect(s.upsert.text).toContain('ON CONFLICT (asin) DO UPDATE');
    expect(s.upsert.values.slice(0, 3)).toEqual(['2026-10-03', 1_000_000, 7]);
    expect(s.upsert.values.slice(3)).toEqual(EXCLUDED_CATEGORIES_ARRAY);
    expect(s.upsert.text).toContain(`$${3 + EXCLUDED_CATEGORIES_ARRAY.length}`);
  });

  it('pulls a tier-2 → tier-1 move forward to a weekly due date without resetting anything else', () => {
    expect(s.upsert.text).toContain(
      'LEAST(asin_products.next_due_at, asin_products.last_fetched_at + make_interval(days => $3::int))',
    );
    expect(s.upsert.text).toContain('ELSE asin_products.next_due_at END');
  });

  it('retires vanished ASINs by flag, never by DELETE', () => {
    expect(s.retire.text).toContain('SET in_scope = false');
    expect(s.retire.text).not.toMatch(/DELETE/i);
    expect(s.retire.values).toEqual(['2026-10-03']);
  });
});

describe('enqueueWeek', () => {
  it('runs the upsert then the retire and reports both counts', async () => {
    const calls: string[] = [];
    const client = {
      query: async (text: string) => {
        calls.push(text);
        return { rowCount: text.includes('INSERT INTO asin_products') ? 5 : 2 };
      },
    };
    await expect(enqueueWeek(client, '2026-10-03')).resolves.toEqual({ upserted: 5, retired: 2 });
    expect(calls[0]).toContain('INSERT INTO asin_products');
    expect(calls[1]).toContain('SET in_scope = false');
  });
});
