// lib/explorer/enrichedProductsQuery.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
vi.mock('@/lib/env', () => ({ env: { DATABASE_URL: 'postgres://test' } }));
import { enrichedProductsFor } from './fetchKeywordDetail';

/** A tagged-template stand-in for neon's sql: returns the joined text and the bound values. */
const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise.resolve({ text: strings.join('?'), values })) as never;

describe('enrichedProductsFor', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads the per-week table at the keyword\'s current week by default', async () => {
    const q = (await enrichedProductsFor(fakeSql, '42')) as unknown as { text: string; values: unknown[] };
    expect(q.text).toContain('FROM asin_weekly_data a');
    expect(q.text).toContain('a.week_end_date = kcs.current_week_end_date');
    expect(q.values).toEqual(['42']);
  });

  it('reads the catalog with the new fields when KEEPA_READ_SOURCE=products', async () => {
    vi.stubEnv('KEEPA_READ_SOURCE', 'products');
    const q = (await enrichedProductsFor(fakeSql, '42')) as unknown as { text: string; values: unknown[] };
    expect(q.text).toContain('FROM asin_products a');
    expect(q.text).not.toContain('a.week_end_date');
    expect(q.text).toContain('a.monthly_sold');
    expect(q.text).toContain('a.fba_offer_count');
    expect(q.values).toEqual(['42']);
  });
});
